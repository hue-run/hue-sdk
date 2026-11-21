"""A media grant may be downloaded only from the Hue origin already connected.

``MediaClient.fetch`` and ``MediaClient.resolve`` ask the configured origin for a grant, then
download ``url``. These tests are the spec for that download: it must open no connection to any
other host, port, or address, including one produced by resolving the same name again. They fail
while a grant can still choose where the GET goes.
"""

from __future__ import annotations

import hashlib
import json
import socket
import ssl
import subprocess
import threading
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from uuid import uuid4

import pytest

from hue_sdk.evals import EvaluationClient, MediaFetchError

PNG = b"\x89PNG\r\n\x1a\n"
OTHER = b"not-the-recorded-file"
DIGEST = hashlib.sha256(PNG).hexdigest()
TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
KEY = "synthetic-project-key"
PART = {"type": "image_url", "image_url": {}, "sha256": DIGEST, "size": len(PNG)}


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:
        server = self.server
        assert isinstance(server, _Probe)
        path = urlsplit(self.path).path
        with server.lock:
            server.requests.append({"path": path, "authorization": "Authorization" in self.headers})
        status, body, content_type = server.answer(path)
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        return


class _Probe(ThreadingHTTPServer):
    """Loopback HTTP server that records every accepted connection and GET."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        address: tuple[str, int] | tuple[str, int, int, int],
        answer: Callable[[str], tuple[int, bytes, str]],
        *,
        tls: ssl.SSLContext | None = None,
        family: socket.AddressFamily = socket.AF_INET,
    ) -> None:
        self.address_family = family
        self.answer = answer
        self.tls = tls
        self.lock = threading.Lock()
        self.accepted: list[str] = []
        self.requests: list[dict[str, Any]] = []
        super().__init__(address, _Handler)

    def get_request(self) -> tuple[socket.socket, Any]:
        sock, _addr = self.socket.accept()
        # The address this probe is bound to, not the client that connected.
        with self.lock:
            self.accepted.append(sock.getsockname()[0])
        if self.tls is not None:
            sock = self.tls.wrap_socket(sock, server_side=True)
        return sock, _addr

    def serve_in_background(self) -> None:
        threading.Thread(target=self.serve_forever, name="media-grant-probe", daemon=True).start()


def _stop(server: _Probe) -> None:
    server.shutdown()
    server.server_close()


def _grant(url: str, size: int) -> dict[str, Any]:
    return {
        "sha256": DIGEST,
        "size": size,
        "url": url,
        "method": "GET",
        "contentType": "image/png",
        "fileName": "chart.png",
    }


def _api(grant: dict[str, Any]) -> Callable[[str], tuple[int, bytes, str]]:
    body = json.dumps(grant).encode()

    def answer(path: str) -> tuple[int, bytes, str]:
        if path.startswith("/api/v1/traces/") or path.startswith("/api/v1/trace-snapshots/"):
            return 200, body, "application/json"
        return 404, b"", "text/plain"

    return answer


def _bytes(payload: bytes) -> Callable[[str], tuple[int, bytes, str]]:
    def answer(path: str) -> tuple[int, bytes, str]:
        return 200, payload, "application/octet-stream"

    return answer


def _listen(
    host: str,
    answer: Callable[[str], tuple[int, bytes, str]],
    *,
    port: int = 0,
    tls: ssl.SSLContext | None = None,
) -> _Probe:
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    server = _Probe((host, port), answer, tls=tls, family=family)
    server.serve_in_background()
    return server


def _port(server: _Probe) -> int:
    return int(server.server_address[1])


def _client(base_url: str) -> EvaluationClient:
    return EvaluationClient(base_url, KEY, timeout_seconds=2)


def _fetch(client: EvaluationClient, *, snapshot: bool) -> tuple[MediaFetchError | None, Any]:
    try:
        if snapshot:
            return None, client.media.fetch(snapshot_id=str(uuid4()), sha256=DIGEST)
        return None, client.media.fetch(trace_id=TRACE_ID, sha256=DIGEST)
    except MediaFetchError as error:
        return error, None


def _issued(tmp: Path, san: str) -> tuple[Path, ssl.SSLContext]:
    ca_key, ca, key, csr, cert = (
        tmp / "ca.key",
        tmp / "ca.pem",
        tmp / "server.key",
        tmp / "server.csr",
        tmp / "server.pem",
    )
    extension = tmp / "san.cnf"
    extension.write_text(f"subjectAltName={san}\n")
    subprocess.run(
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-keyout",
            str(ca_key),
            "-out",
            str(ca),
            "-days",
            "2",
            "-nodes",
            "-subj",
            "/CN=hue-media-test-ca",
        ],
        check=True,
        capture_output=True,
    )
    subprocess.run(
        [
            "openssl",
            "req",
            "-newkey",
            "rsa:2048",
            "-keyout",
            str(key),
            "-out",
            str(csr),
            "-nodes",
            "-subj",
            "/CN=hue-media-test",
        ],
        check=True,
        capture_output=True,
    )
    subprocess.run(
        [
            "openssl",
            "x509",
            "-req",
            "-in",
            str(csr),
            "-CA",
            str(ca),
            "-CAkey",
            str(ca_key),
            "-CAcreateserial",
            "-out",
            str(cert),
            "-days",
            "2",
            "-extfile",
            str(extension),
        ],
        check=True,
        capture_output=True,
    )
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    return ca, context


def _trust(monkeypatch: pytest.MonkeyPatch, ca: Path) -> None:
    monkeypatch.setenv("REQUESTS_CA_BUNDLE", str(ca))
    monkeypatch.setenv("CURL_CA_BUNDLE", str(ca))


@pytest.mark.parametrize("snapshot", [False, True], ids=["trace", "snapshot"])
@pytest.mark.parametrize("host", ["127.0.0.1", "localhost", "::1"])
@pytest.mark.parametrize("payload", [PNG, OTHER], ids=["matching-bytes", "rejected-bytes"])
def test_fetch_does_not_get_a_loopback_grant_outside_the_hue_origin(
    snapshot: bool, host: str, payload: bytes
) -> None:
    """HTTP to localhost, 127.0.0.1, or ::1 is not the origin at 127.0.0.2.

    ``payload`` is the recorded file or other bytes. Either way the probe must accept nothing:
    a digest check that runs after the GET still leaves the request on the probe.
    """
    bind = "127.0.0.1" if host == "127.0.0.1" else "::1"
    target = _listen(bind, _bytes(payload))
    # localhost resolves to ::1 and to 127.0.0.1; listen on both so either answer is seen.
    other = (
        _listen("127.0.0.1", _bytes(payload), port=_port(target)) if host == "localhost" else None
    )
    origin = _listen("127.0.0.2", _api(_grant(_download_url(host, _port(target)), len(payload))))
    try:
        error, file = _fetch(_client(f"http://127.0.0.2:{_port(origin)}"), snapshot=snapshot)
        seen = target.accepted + ([] if other is None else other.accepted)
        requests = target.requests + ([] if other is None else other.requests)
        assert seen == [], (seen, requests, None if error is None else error.reason)
        assert error is not None and error.reason == "failed" and file is None
    finally:
        _stop(origin)
        _stop(target)
        if other is not None:
            _stop(other)


def test_fetch_does_not_get_another_port_on_the_hue_host() -> None:
    target = _listen("127.0.0.1", _bytes(OTHER))
    origin = _listen(
        "127.0.0.1", _api(_grant(f"http://127.0.0.1:{_port(target)}/private", len(OTHER)))
    )
    try:
        assert _port(origin) != _port(target)
        error, file = _fetch(_client(f"http://127.0.0.1:{_port(origin)}"), snapshot=False)
        assert target.accepted == [], (target.accepted, target.requests, _reason(error))
        assert error is not None and error.reason == "failed" and file is None
    finally:
        _stop(origin)
        _stop(target)


def test_fetch_does_not_get_https_on_a_different_host(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ca, context = _issued(tmp_path, "IP:127.0.0.1")
    _trust(monkeypatch, ca)
    target = _listen("127.0.0.1", _bytes(OTHER), tls=context)
    origin = _listen(
        "127.0.0.2",
        _api(_grant(f"https://127.0.0.1:{_port(target)}/private", len(OTHER))),
    )
    try:
        error, file = _fetch(_client(f"http://127.0.0.2:{_port(origin)}"), snapshot=False)
        assert target.accepted == [], (target.accepted, target.requests, _reason(error))
        assert error is not None and error.reason == "failed" and file is None
    finally:
        _stop(origin)
        _stop(target)


def _reason(error: MediaFetchError | None) -> str | None:
    return None if error is None else error.reason


def test_resolve_does_not_get_a_grant_outside_the_hue_origin() -> None:
    target = _listen("127.0.0.1", _bytes(OTHER))
    origin = _listen(
        "127.0.0.2",
        _api(_grant(f"http://127.0.0.1:{_port(target)}/private", len(OTHER))),
    )
    try:
        resolved = _client(f"http://127.0.0.2:{_port(origin)}").media.resolve(
            PART, trace_id=TRACE_ID
        )
        assert target.accepted == [], (target.accepted, target.requests, resolved.failures)
        assert resolved.resolved == 0
        assert [(failure.sha256, failure.reason) for failure in resolved.failures] == [
            (DIGEST, "failed")
        ]
        assert resolved.value == PART
    finally:
        _stop(origin)
        _stop(target)


class _Names:
    """Resolves hue-media.test to the origin, then to a different address on every later lookup.

    The first answer is the address the grant connection uses. The download must connect to that
    address. A later lookup is a different address, so resolving the name again between the check
    and the GET connects somewhere else.
    """

    def __init__(self, real: Callable[..., Any]) -> None:
        self.real = real
        self.phase = "origin"
        self.calls: list[str] = []

    def __call__(self, host: object, port: object, *args: object, **kwargs: object) -> Any:
        label = host[:-1] if isinstance(host, str) and host.endswith(".") else host
        if isinstance(label, str):
            label = label.lower()
        if label != "hue-media.test":
            return self.real(host, port, *args, **kwargs)
        phase = self.phase
        self.calls.append(phase)
        if phase == "origin":
            address = "127.0.0.1"
        elif phase == "first":
            address = "127.0.0.2"
            self.phase = "second"
        else:
            address = "127.0.0.3"
        return self.real(address, port, *args, **kwargs)


def test_fetch_reuses_the_origin_address_when_the_grant_name_resolves_again(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ca, context = _issued(tmp_path, "DNS:hue-media.test")
    _trust(monkeypatch, ca)
    names = _Names(socket.getaddrinfo)
    monkeypatch.setattr(socket, "getaddrinfo", names)

    def origin_answer(path: str) -> tuple[int, bytes, str]:
        if path.startswith("/api/v1/"):
            # The grant connection has already resolved the name. Later lookups must not move it.
            names.phase = "first"
            body = json.dumps(
                _grant(f"https://hue-media.test:{_port(origin)}/storage/{DIGEST}", len(PNG))
            ).encode()
            return 200, body, "application/json"
        if path == f"/storage/{DIGEST}":
            return 200, PNG, "application/octet-stream"
        return 404, b"", "text/plain"

    origin = _listen("127.0.0.1", origin_answer, tls=context)
    first = _listen("127.0.0.2", _bytes(OTHER), port=_port(origin), tls=context)
    second = _listen("127.0.0.3", _bytes(OTHER), port=_port(origin), tls=context)
    try:
        error, file = _fetch(_client(f"https://hue-media.test:{_port(origin)}"), snapshot=False)
        moved = first.accepted + second.accepted
        assert moved == [], (moved, first.requests + second.requests, names.calls, error)
        assert error is None and file is not None and file.data == PNG
    finally:
        _stop(origin)
        _stop(first)
        _stop(second)


def _download_url(host: str, port: int) -> str:
    authority = f"[{host}]" if ":" in host else host
    return f"http://{authority}:{port}/private"
