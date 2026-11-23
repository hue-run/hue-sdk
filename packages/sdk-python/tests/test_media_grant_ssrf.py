"""A non-loopback Hue origin must not aim a media download at this machine.

``media.evil.test`` resolves to 127.0.0.1 on the first lookup and 127.0.0.2 on every later one.
Both addresses run the probe, so a check that resolves the name and then lets the download
resolve it again still connects here.
"""

from __future__ import annotations

import hashlib
import json
import socket
import ssl
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from typing import Any
from urllib.parse import urlsplit

import pytest

from hue_sdk.evals import EvaluationClient, MediaFetchError

TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
SNAPSHOT_ID = "4bf92f35-77b3-4da6-a3ce-929d0e0e4736"
DECLARED = b"recorded-file"
DIGEST = hashlib.sha256(DECLARED).hexdigest()
PROBE = b"x" * len(DECLARED)
KEY = "synthetic-media-key"


def _cert(directory: Path) -> tuple[str, str]:
    key = directory / "key.pem"
    cert = directory / "cert.pem"
    made = subprocess.run(
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-keyout",
            str(key),
            "-out",
            str(cert),
            "-days",
            "1",
            "-nodes",
            "-subj",
            "/CN=hue-media-api.test",
            "-addext",
            "subjectAltName=DNS:hue-media-api.test,DNS:media.evil.test,IP:127.0.0.1,IP:127.0.0.2",
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if made.returncode != 0:
        raise RuntimeError(made.stderr or "openssl failed")
    return str(cert), str(key)


class _V6Server(ThreadingHTTPServer):
    address_family = socket.AF_INET6


def _serve(
    host: str,
    handler: type[BaseHTTPRequestHandler],
    port: int = 0,
    context: ssl.SSLContext | None = None,
    ipv6: bool = False,
) -> ThreadingHTTPServer:
    server = (_V6Server if ipv6 else ThreadingHTTPServer)((host, port), handler)
    if context is not None:
        server.socket = context.wrap_socket(server.socket, server_side=True)
    thread = Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    thread.start()
    return server


@pytest.fixture
def media_grant(monkeypatch: pytest.MonkeyPatch):
    downloads: list[dict[str, str]] = []
    grants: list[dict[str, str]] = []
    grant: dict[str, Any] = {}
    lookups = {"evil": 0}
    directory = tempfile.TemporaryDirectory()
    cert, key = _cert(Path(directory.name))
    monkeypatch.setenv("REQUESTS_CA_BUNDLE", cert)

    class Api(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            path = urlsplit(self.path).path
            grants.append(
                {
                    "method": "GET",
                    "path": path,
                    "authorization": "present" if self.headers.get("Authorization") else "absent",
                }
            )
            asked = path.rsplit("/", 1)[-1]
            if asked != DIGEST or "url" not in grant:
                self._send(404, b'{"error":"Not found"}')
                return
            body = {"sha256": DIGEST, "size": len(PROBE), "url": grant["url"]}
            if "method" in grant:
                body["method"] = grant["method"]
            self._send(200, json.dumps(body).encode())

        def _send(self, status: int, payload: bytes) -> None:
            self.send_response(status)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_args: object) -> None:
            return

    class Probe(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            downloads.append(
                {
                    "method": "GET",
                    "path": urlsplit(self.path).path,
                    "authorization": "present" if self.headers.get("Authorization") else "absent",
                }
            )
            self.send_response(200)
            self.send_header("Content-Length", str(len(PROBE)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(PROBE)

        def log_message(self, *_args: object) -> None:
            return

    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    api = _serve("127.0.0.1", Api, context=context)
    http_probe = _serve("127.0.0.1", Probe)
    http_v6 = _serve("::1", Probe, http_probe.server_port, ipv6=True)
    tls_probe = _serve("127.0.0.1", Probe, context=context)
    tls_next = _serve("127.0.0.2", Probe, tls_probe.server_port, context)
    original = socket.getaddrinfo

    def resolve(host: str, port: int, *args: Any, **kwargs: Any):
        if host == "hue-media-api.test":
            host = "127.0.0.1"
        elif host == "media.evil.test":
            lookups["evil"] += 1
            host = "127.0.0.1" if lookups["evil"] == 1 else "127.0.0.2"
        return original(host, port, *args, **kwargs)

    monkeypatch.setattr(socket, "getaddrinfo", resolve)
    client = EvaluationClient(
        f"https://hue-media-api.test:{api.server_port}", KEY, timeout_seconds=5
    )
    try:
        yield {
            "client": client,
            "downloads": downloads,
            "grants": grants,
            "grant": grant,
            "lookups": lookups,
            "http_port": http_probe.server_port,
            "tls_port": tls_probe.server_port,
        }
    finally:
        for server in (api, http_probe, http_v6, tls_probe, tls_next):
            server.shutdown()
            server.server_close()
        directory.cleanup()


def _refuse(media_grant: dict[str, Any], *, snapshot: bool = False) -> MediaFetchError:
    client: EvaluationClient = media_grant["client"]
    with pytest.raises(MediaFetchError) as caught:
        if snapshot:
            client.media.fetch(snapshot_id=SNAPSHOT_ID, sha256=DIGEST)
        else:
            client.media.fetch(trace_id=TRACE_ID, sha256=DIGEST)
    return caught.value


def test_fetch_from_a_non_loopback_origin_does_not_get_the_grant_url(media_grant: dict[str, Any]):
    targets: list[tuple[str, str | None, bool]] = [
        (f"http://127.0.0.1:{media_grant['http_port']}/admin", "GET", False),
        (f"http://127.0.0.1:{media_grant['http_port']}/omitted", None, False),
        (f"http://[::1]:{media_grant['http_port']}/v6", "GET", False),
        (f"http://localhost:{media_grant['http_port']}/local", "GET", False),
        (f"https://127.0.0.1:{media_grant['tls_port']}/admin", "GET", False),
        (f"https://media.evil.test:{media_grant['tls_port']}/rebind", "GET", True),
    ]
    fetched: list[tuple[str, list[dict[str, str]]]] = []
    for url, method, rebind in targets:
        media_grant["downloads"].clear()
        media_grant["grants"].clear()
        if rebind:
            media_grant["lookups"]["evil"] = 0
        media_grant["grant"].clear()
        media_grant["grant"]["url"] = url
        if method is not None:
            media_grant["grant"]["method"] = method
        error = _refuse(media_grant)
        assert media_grant["grants"], url
        if media_grant["downloads"]:
            fetched.append((url, list(media_grant["downloads"])))
            continue
        assert error.reason == "failed", url
    assert fetched == []


def test_snapshot_fetch_does_not_get_loopback(media_grant: dict[str, Any]):
    media_grant["grant"]["url"] = f"http://127.0.0.1:{media_grant['http_port']}/snapshot"
    media_grant["grant"]["method"] = "GET"
    error = _refuse(media_grant, snapshot=True)
    assert any(hit["path"].startswith("/api/v1/trace-snapshots/") for hit in media_grant["grants"])
    assert media_grant["downloads"] == []
    assert error.reason == "failed"


def test_resolve_does_not_get_the_grant_url(media_grant: dict[str, Any]):
    media_grant["grant"]["url"] = f"http://127.0.0.1:{media_grant['http_port']}/resolve"
    media_grant["grant"]["method"] = "GET"
    resolution = media_grant["client"].media.resolve(
        [{"type": "image_url", "image_url": {}, "sha256": DIGEST, "size": len(DECLARED)}],
        trace_id=TRACE_ID,
    )
    assert media_grant["grants"]
    assert media_grant["downloads"] == []
    assert resolution.resolved == 0
    assert resolution.failures[0].reason == "failed"
