"""A remote Hue origin must not aim recorded bytes at a server-chosen upload URL.

The reservation answer is a presigned PUT. These cases fail while that PUT is issued to
loopback (including the rest of 127.0.0.0/8), to an arbitrary HTTPS name, or to a name whose
later ``getaddrinfo`` result is not the address the first lookup returned.
"""

from __future__ import annotations

import hashlib
import json
import os
import socket
import ssl
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
import requests

from hue_sdk._blobs import BlobUploader

API_NAME = "hue-api.invalid"
SINK_NAME = "hue-blob-sink.invalid"
REBIND_NAME = "hue-rebind.invalid"
PUBLIC_IP = "23.192.0.10"
MARK = "# hue-blob-upload-target"
PAYLOAD = b"telemetry-blob-canary"
KEY = "hue_test_placeholder_key"


def _run(command: list[str]) -> None:
    result = subprocess.run(command, check=False, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(result.stderr or result.stdout or command[0])


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _read(self) -> bytes:
        return self.rfile.read(int(self.headers.get("Content-Length") or 0))

    def do_PUT(self) -> None:  # noqa: N802
        body = self._read()
        self.server.hits.append(body)  # type: ignore[attr-defined]
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self) -> None:  # noqa: N802
        self._read()
        path = self.path.split("?", 1)[0]
        if path.endswith("/complete"):
            encoded = b"{}"
        else:
            self.server.reserves += 1  # type: ignore[attr-defined]
            encoded = json.dumps(
                {
                    "status": "upload",
                    "method": "PUT",
                    "url": self.server.grant,  # type: ignore[attr-defined]
                    "headers": {"Content-Type": "text/plain"},
                    "expiresAt": "2099-01-01T00:00:00.000Z",
                    "ref": {"content_type": "text/plain"},
                }
            ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, format: str, *args: object) -> None:
        return


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    hits: list[bytes]
    reserves: int
    grant: str

    def __init__(self, address: tuple[str, int], tls: tuple[str, str] | None = None) -> None:
        self.hits = []
        self.reserves = 0
        self.grant = ""
        super().__init__(address, _Handler)
        if tls is not None:
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(tls[0], tls[1])
            self.socket = context.wrap_socket(self.socket, server_side=True)

    def start(self) -> None:
        threading.Thread(target=self.serve_forever, daemon=True).start()


def _local(ip: str) -> bool:
    result = subprocess.run(["ip", "route", "get", ip], check=False, capture_output=True, text=True)
    return result.returncode == 0 and "dev lo" in result.stdout


def test_remote_origin_cannot_aim_recorded_bytes() -> None:
    hosts_path = Path("/etc/hosts")
    original = hosts_path.read_text()
    root = Path(tempfile.mkdtemp(prefix="hue-blob-target-"))
    previous_bundle = os.environ.get("REQUESTS_CA_BUNDLE")
    real_getaddrinfo = socket.getaddrinfo
    lookups = {"n": 0}
    servers: list[_Server] = []
    try:
        kept = "\n".join(
            line
            for line in original.split("\n")
            if MARK not in line and API_NAME not in line and SINK_NAME not in line
        ).rstrip("\n")
        hosts_file = root / "hosts"
        hosts_file.write_text(f"{kept}\n127.0.0.1 {API_NAME} {SINK_NAME} {MARK}\n")
        _run(["sudo", "-n", "cp", str(hosts_file), "/etc/hosts"])
        _run(["sudo", "-n", "ip", "addr", "replace", f"{PUBLIC_IP}/32", "dev", "lo"])
        if not _local(PUBLIC_IP):
            raise RuntimeError(f"{PUBLIC_IP} is not local; refusing to open a route to it")

        _run(
            [
                "openssl",
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-keyout",
                str(root / "ca.key"),
                "-out",
                str(root / "ca.pem"),
                "-days",
                "1",
                "-nodes",
                "-subj",
                "/CN=hue-blob-target-test",
            ]
        )
        _run(
            [
                "openssl",
                "req",
                "-newkey",
                "rsa:2048",
                "-keyout",
                str(root / "sink.key"),
                "-out",
                str(root / "sink.csr"),
                "-nodes",
                "-subj",
                f"/CN={SINK_NAME}",
            ]
        )
        (root / "sink.ext").write_text(
            f"subjectAltName=DNS:{API_NAME},DNS:{SINK_NAME},DNS:{REBIND_NAME}\n"
        )
        _run(
            [
                "openssl",
                "x509",
                "-req",
                "-in",
                str(root / "sink.csr"),
                "-CA",
                str(root / "ca.pem"),
                "-CAkey",
                str(root / "ca.key"),
                "-CAcreateserial",
                "-out",
                str(root / "sink.pem"),
                "-days",
                "1",
                "-extfile",
                str(root / "sink.ext"),
            ]
        )
        os.environ["REQUESTS_CA_BUNDLE"] = str(root / "ca.pem")
        tls = (str(root / "sink.pem"), str(root / "sink.key"))

        api = _Server(("127.0.0.1", 0))
        loop = _Server(("127.0.0.1", 0))
        loop_two = _Server(("127.0.0.2", 0))
        named = _Server(("127.0.0.1", 0), tls)
        public = _Server((PUBLIC_IP, 0), tls)
        rebound = _Server(("127.0.0.1", public.server_address[1]), tls)
        servers.extend([api, loop, loop_two, named, public, rebound])
        for server in servers:
            server.start()

        probe = requests.put(
            f"https://{SINK_NAME}:{named.server_address[1]}/probe",
            data=b"probe",
            timeout=3,
        )
        probe.raise_for_status()
        if named.hits != [b"probe"]:
            raise RuntimeError("named HTTPS sink was not reachable")
        named.hits.clear()

        def patched(host: str, port: int, *args: object, **kwargs: object) -> list:
            if host == REBIND_NAME:
                lookups["n"] += 1
                ip = PUBLIC_IP if lookups["n"] == 1 else "127.0.0.1"
                return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port))]
            return real_getaddrinfo(host, port, *args, **kwargs)

        failures: list[str] = []

        def upload(body: bytes, url: str) -> None:
            api.grant = url
            before = api.reserves
            groups = [loop, loop_two, named, public, rebound]
            for server in groups:
                server.hits.clear()
            uploader = BlobUploader(
                f"http://{API_NAME}:{api.server_address[1]}",
                {"Authorization": f"Bearer {KEY}"},
                3,
            )
            try:
                digest = (hashlib.sha256(body).hexdigest(), len(body))
                uploader.store("ab" * 16, "input.value", body, "text/plain", digest)
            finally:
                uploader.close()
            if api.reserves == before:
                failures.append(f"{url}: the API reservation was never requested")
            landed = [server for server in groups if server.hits]
            if landed:
                failures.append(
                    f"{url}: {sum(len(server.hits) for server in landed)} server-chosen "
                    "upload request(s) received the bytes"
                )

        upload(PAYLOAD, f"http://127.0.0.1:{loop.server_address[1]}/blob")
        upload(PAYLOAD, f"http://127.0.0.2:{loop_two.server_address[1]}/blob")
        upload(PAYLOAD, f"https://{SINK_NAME}:{named.server_address[1]}/blob")

        socket.getaddrinfo = patched  # type: ignore[assignment]
        try:
            lookups["n"] = 0
            port = public.server_address[1]
            one = requests.put(f"https://{REBIND_NAME}:{port}/probe", data=b"one", timeout=3)
            two = requests.put(f"https://{REBIND_NAME}:{port}/probe", data=b"two", timeout=3)
            one.raise_for_status()
            two.raise_for_status()
            if public.hits != [b"one"] or rebound.hits != [b"two"]:
                raise RuntimeError(
                    f"rebinding probe missed a listener (public {public.hits!r}, "
                    f"loop {rebound.hits!r}, lookups {lookups['n']})"
                )
            lookups["n"] = 0
            upload(PAYLOAD, f"https://{REBIND_NAME}:{port}/blob")
        finally:
            socket.getaddrinfo = real_getaddrinfo  # type: ignore[assignment]

        if failures:
            pytest.fail("\n".join(failures))
    finally:
        socket.getaddrinfo = real_getaddrinfo  # type: ignore[assignment]
        for server in servers:
            server.shutdown()
            server.server_close()
        if previous_bundle is None:
            os.environ.pop("REQUESTS_CA_BUNDLE", None)
        else:
            os.environ["REQUESTS_CA_BUNDLE"] = previous_bundle
        restored = (
            "\n".join(
                line
                for line in original.split("\n")
                if MARK not in line and API_NAME not in line and SINK_NAME not in line
            ).rstrip("\n")
            + "\n"
        )
        restore = root / "hosts.restore"
        restore.write_text(restored)
        subprocess.run(["sudo", "-n", "cp", str(restore), "/etc/hosts"], check=False)
        subprocess.run(
            ["sudo", "-n", "ip", "addr", "del", f"{PUBLIC_IP}/32", "dev", "lo"],
            check=False,
        )
        subprocess.run(["rm", "-rf", str(root)], check=False)
