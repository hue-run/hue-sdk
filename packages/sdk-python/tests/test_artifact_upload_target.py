"""A non-loopback evaluation origin must not PUT artifact bytes to a server-chosen URL.

The URL is acceptable only when it is https, has no userinfo or fragment, and its hostname is
the origin hostname. An address of that name must be public (not loopback, private, link-local,
or the other ranges named in the TypeScript upload-target test), and a name is connected to the
addresses from a single lookup. These tests fail while `_upload_url` still accepts loopback HTTP
and any https URL.
"""

from __future__ import annotations

import fcntl
import json
import os
import socket
import ssl
import struct
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory

from hue_sdk.evals.client import EvaluationClient

MARKER = b"python-case-bytes"
HITS: list[bytes] = []


class _Handler(BaseHTTPRequestHandler):
    def do_PUT(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        if body == MARKER:
            HITS.append(body)
        self.send_response(200)
        self.end_headers()

    def log_message(self, _format: str, *_args: object) -> None:
        return


def _private_ipv4() -> str:
    for iface in os.listdir("/sys/class/net"):
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            info = fcntl.ioctl(sock, 0x8915, struct.pack("256s", iface.encode()[:15]))
        except OSError:
            continue
        finally:
            sock.close()
        ip = socket.inet_ntoa(info[20:24])
        if not ip.startswith("127."):
            return ip
    raise AssertionError("a non-loopback IPv4 address is required")


def _serve(ip: str, cert: str | None = None, key: str | None = None) -> ThreadingHTTPServer:
    class Server(ThreadingHTTPServer):
        address_family = socket.AF_INET6 if ":" in ip else socket.AF_INET

    httpd = Server((ip, 0), _Handler)
    if cert is not None and key is not None:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        httpd.socket = context.wrap_socket(httpd.socket, server_side=True)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def _upload(client: EvaluationClient, upload_url: str) -> str:
    try:
        client.upload_artifact_bytes(
            {
                "uploadUrl": upload_url,
                "method": "PUT",
                "headers": {"x-vercel-blob-access": "private"},
                "expiresAt": "2099-01-01T00:00:00Z",
            },
            MARKER,
            "text/plain",
        )
    except Exception as error:
        return type(error).__name__
    return "sent"


def test_remote_origin_does_not_put_artifact_bytes_at_a_server_chosen_url() -> None:
    private_ip = _private_ipv4()
    with TemporaryDirectory() as directory:
        key = str(Path(directory) / "key.pem")
        cert = str(Path(directory) / "cert.pem")
        subprocess.run(
            [
                "openssl",
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-keyout",
                key,
                "-out",
                cert,
                "-days",
                "1",
                "-nodes",
                "-subj",
                "/CN=upload-target",
                "-addext",
                f"subjectAltName=IP:127.0.0.1,IP:::1,IP:{private_ip}",
            ],
            check=True,
            capture_output=True,
        )
        os.environ["REQUESTS_CA_BUNDLE"] = cert
        http4 = _serve("127.0.0.1")
        http6 = _serve("::1")
        https4 = _serve("127.0.0.1", cert, key)
        https_private = _serve(private_ip, cert, key)
        client = EvaluationClient(
            base_url="https://hue.invalid",
            api_key="synthetic-upload-key",
            timeout_seconds=2,
            max_attempts=1,
        )
        HITS.clear()
        targets = [
            f"http://127.0.0.1:{http4.server_address[1]}/steal",
            f"http://localhost:{http4.server_address[1]}/local",
            f"http://[::1]:{http6.server_address[1]}/v6",
            f"https://127.0.0.1:{https4.server_address[1]}/secret",
            f"https://{private_ip}:{https_private.server_address[1]}/arbitrary",
        ]
        errors = [_upload(client, url) for url in targets]
        for httpd in (http4, http6, https4, https_private):
            httpd.shutdown()
        assert HITS == [], HITS
        assert errors == ["HueApiError"] * len(targets)


def test_upload_url_from_the_evaluation_api_is_the_url_that_is_checked() -> None:
    """The bytes follow the uploadUrl in the reservation response, not a URL the client rewrote."""
    seen: list[bytes] = []

    class Handler(_Handler):
        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("Content-Length", "0"))
            self.rfile.read(length)
            port = sink.server_address[1]
            body = json.dumps(
                {
                    "uploadUrl": f"http://127.0.0.1:{port}/from-api",
                    "method": "PUT",
                    "headers": None,
                    "expiresAt": "2099-01-01T00:00:00Z",
                }
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_PUT(self) -> None:  # noqa: N802
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length)
            if body == MARKER:
                seen.append(body)
            self.send_response(200)
            self.end_headers()

    sink = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    # The origin has to be https and not loopback. Use the private address with the cert from
    # the previous test's trust store only when this process already has one; otherwise this
    # case is the loopback sink fed by an https origin built below.
    private_ip = _private_ipv4()
    with TemporaryDirectory() as directory:
        key = str(Path(directory) / "key.pem")
        cert = str(Path(directory) / "cert.pem")
        subprocess.run(
            [
                "openssl",
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-keyout",
                key,
                "-out",
                cert,
                "-days",
                "1",
                "-nodes",
                "-subj",
                "/CN=upload-target",
                "-addext",
                f"subjectAltName=IP:{private_ip}",
            ],
            check=True,
            capture_output=True,
        )
        os.environ["REQUESTS_CA_BUNDLE"] = cert
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        api = ThreadingHTTPServer((private_ip, 0), Handler)
        api.socket = context.wrap_socket(api.socket, server_side=True)
        threading.Thread(target=sink.serve_forever, daemon=True).start()
        threading.Thread(target=api.serve_forever, daemon=True).start()
        client = EvaluationClient(
            base_url=f"https://{private_ip}:{api.server_address[1]}",
            api_key="synthetic-upload-key",
            timeout_seconds=2,
            max_attempts=1,
        )
        upload = client.request_artifact_upload("11111111-1111-4111-8111-111111111111")
        assert str(upload["uploadUrl"]).startswith("http://127.0.0.1:")
        try:
            client.upload_artifact_bytes(upload, MARKER, "text/plain")
        except Exception as error:
            assert type(error).__name__ == "HueApiError"
        else:
            raise AssertionError("upload accepted a loopback URL from the evaluation API")
        sink.shutdown()
        api.shutdown()
        assert seen == []


def test_allowlisted_upload_name_is_pinned_to_the_first_public_address() -> None:
    harness = (
        Path(__file__).resolve().parents[3]
        / "packages/sdk-typescript/tests/artifact-upload-pin.harness.py"
    )
    names = [
        "evil.example",
        "loop.hue.test",
        "storage.hue.test",
        "evil2.example",
        "loop2.hue.test",
        "storage2.hue.test",
    ]
    with TemporaryDirectory() as directory:
        key = str(Path(directory) / "key.pem")
        cert = str(Path(directory) / "cert.pem")
        alt = ",".join(["IP:127.0.0.1", "IP:203.0.113.10", *(f"DNS:{name}" for name in names)])
        subprocess.run(
            [
                "openssl",
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-keyout",
                key,
                "-out",
                cert,
                "-days",
                "1",
                "-nodes",
                "-subj",
                "/CN=upload-target",
                "-addext",
                f"subjectAltName={alt}",
            ],
            check=True,
            capture_output=True,
        )
        proc = subprocess.run(
            [
                "unshare",
                "--user",
                "--map-root-user",
                "--net",
                "--mount",
                sys.executable,
                str(harness),
                "python",
                cert,
                key,
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        assert proc.returncode == 0, proc.stderr
        report = json.loads(proc.stdout)
        hits = report["hits"]

        def paths(prefix: str) -> list[dict[str, object]]:
            return [hit for hit in hits if str(hit["path"]).startswith(prefix)]

        assert paths("/evil2") == []
        assert paths("/loop2") == []
        assert report["python"]["evil"] == "HueApiError"
        assert report["python"]["loop"] == "HueApiError"
        pinned = paths("/pinned-python")
        assert len(pinned) == 1
        assert pinned[0]["where"] == "public"
        assert pinned[0]["body"] == "pinned-python-bytes"
        assert pinned[0]["path"] == "/pinned-python?sig=keep"
        assert pinned[0]["type"] == "text/plain"
        assert pinned[0]["blob"] == "private"
        assert pinned[0]["authorization"] is None
        assert report["python"]["pin"] == "sent"
        assert [hit for hit in hits if hit["where"] == "loop"] == []
