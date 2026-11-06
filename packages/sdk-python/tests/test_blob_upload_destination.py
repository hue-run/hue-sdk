"""A blob reservation must not send recorded bytes to a URL the Hue origin did not serve.

The upload is accepted today when the reservation says PUT and the URL is HTTPS to any host, or
HTTP to any loopback address, and every header except Authorization is copied onto that PUT.
These tests export a real captured value and require that none of those bytes are delivered.
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import socket
import ssl
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

from hue_sdk import Attachment, Hue

KEY = "synthetic-blob-key"
MIB = 1024 * 1024
HUE_HOST = "127.0.0.1"
COOKIE = "session=attacker-chosen"
HOST_HEADER = "metadata.internal"

PROXY_VARIABLES = (
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
)


class _Delivery:
    __slots__ = ("path", "host", "cookie", "authorization", "length", "sha256")

    def __init__(
        self,
        path: str,
        host: str | None,
        cookie: str | None,
        authorization: bool,
        length: int,
        sha256: str,
    ) -> None:
        self.path = path
        self.host = host
        self.cookie = cookie
        self.authorization = authorization
        self.length = length
        self.sha256 = sha256

    def __repr__(self) -> str:
        return (
            f"PUT {self.path} host={self.host!r} cookie={self.cookie!r} "
            f"authorization={self.authorization} length={self.length} sha256={self.sha256}"
        )


def _record_put(handler: BaseHTTPRequestHandler, sink: list[_Delivery]) -> None:
    length = int(handler.headers.get("Content-Length", "0"))
    body = handler.rfile.read(length) if length else b""
    names = {name.lower() for name in handler.headers}
    sink.append(
        _Delivery(
            handler.path.split("?")[0],
            handler.headers.get("Host"),
            handler.headers.get("Cookie"),
            "authorization" in names,
            len(body),
            hashlib.sha256(body).hexdigest(),
        )
    )
    handler.send_response(200)
    handler.send_header("Content-Length", "0")
    handler.end_headers()


def _collector(sink: list[_Delivery]) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def do_PUT(self) -> None:
            _record_put(self, sink)

        def log_message(self, _format: str, *_args: Any) -> None:
            return

    return Handler


def _hue(upload_url: str, puts: list[_Delivery]) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length else b""
            path = self.path.split("?")[0]
            if path == "/api/v1/otlp/blobs":
                request = json.loads(raw)
                ref = {
                    "key": request["key"],
                    "sha256": request["sha256"],
                    "size": request["byteSize"],
                    "content_type": request["contentType"],
                }
                self._json(
                    {
                        "status": "upload",
                        "method": "PUT",
                        "url": upload_url,
                        "headers": {
                            "Content-Type": request["contentType"],
                            "Cookie": COOKIE,
                            "Host": HOST_HEADER,
                        },
                        "ref": ref,
                    }
                )
                return
            if path == "/api/v1/otlp/blobs/complete":
                self._json({"status": "complete"})
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/x-protobuf")
            self.send_header("Hue-Pending-Spans", "1")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_PUT(self) -> None:
            _record_put(self, puts)

        def _json(self, value: dict[str, Any]) -> None:
            body = json.dumps(value).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, _format: str, *_args: Any) -> None:
            return

    return Handler


class _HTTPServer(ThreadingHTTPServer):
    address_family = socket.AF_INET


class _HTTP6Server(ThreadingHTTPServer):
    address_family = socket.AF_INET6


def _serve(
    address: tuple[str, int] | tuple[str, int, int, int],
    handler: type[BaseHTTPRequestHandler],
    *,
    tls: ssl.SSLContext | None = None,
) -> ThreadingHTTPServer:
    kind = _HTTP6Server if ":" in address[0] else _HTTPServer
    server = kind(address, handler)
    server.daemon_threads = True
    if tls is not None:
        server.socket = tls.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(
        target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True
    )
    thread.start()
    server.serve_thread = thread  # type: ignore[attr-defined]
    return server


def _stop(server: ThreadingHTTPServer) -> None:
    server.shutdown()
    server.server_close()
    thread = getattr(server, "serve_thread", None)
    if thread is not None:
        thread.join(timeout=5)


def _other_host() -> str:
    """A local address that is not loopback, so an HTTPS collector is a different host.

    Falls back to another loopback address where this machine has no such address. HTTPS is
    accepted for either: the reservation check looks at the scheme, not the Hue origin.
    """
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("192.0.2.1", 9))
        host = probe.getsockname()[0]
    except OSError:
        return "127.0.0.2"
    finally:
        probe.close()
    try:
        if ipaddress.ip_address(host).is_loopback:
            return "127.0.0.2"
    except ValueError:
        return "127.0.0.2"
    try:
        sock = socket.socket()
        sock.bind((host, 0))
        sock.close()
    except OSError:
        return "127.0.0.2"
    return host


def _certificate(directory: Path, hosts: list[str]) -> tuple[Path, Path]:
    key = directory / "server.key"
    cert = directory / "server.crt"
    names = ",".join(f"IP:{host}" for host in hosts)
    subprocess.run(
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            str(key),
            "-out",
            str(cert),
            "-days",
            "2",
            "-subj",
            "/CN=hue-upload-test",
            "-addext",
            f"subjectAltName={names}",
        ],
        check=True,
        capture_output=True,
    )
    return cert, key


@pytest.fixture(scope="module")
def trusted_cert(tmp_path_factory: pytest.TempPathFactory) -> tuple[ssl.SSLContext, Path, str]:
    other = _other_host()
    hosts = list(dict.fromkeys([HUE_HOST, "127.0.0.2", other]))
    cert, key = _certificate(tmp_path_factory.mktemp("blob-upload-cert"), hosts)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    return context, cert, other


def _capture(hue: Hue, source: str, payload: bytes, path: Path) -> None:
    with hue.span("captured") as span:
        if source == "attribute":
            span.set_attribute("tool.output", payload.decode())
        elif source == "record_file":
            span.record_file(role="output", media_type="image/png", data=payload, upload=True)
        elif source == "attachment":
            span.set_output({"scan": Attachment(payload, content_type="image/png")})
        elif source == "path":
            path.write_bytes(payload)
            span.record_file(role="output", media_type="image/png", path=path, upload=True)
        else:
            span.log_inference(input=[Attachment(payload, content_type="image/png")])


@pytest.mark.parametrize("source", ["attribute", "record_file", "attachment", "path", "log"])
@pytest.mark.parametrize(
    "destination",
    ["loopback_ipv4", "loopback_ipv6", "localhost", "third_party_https"],
)
def test_recorded_bytes_are_not_put_to_a_reservation_url(
    source: str,
    destination: str,
    trusted_cert: tuple[ssl.SSLContext, Path, str],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    context, ca, other_host = trusted_cert
    for name in PROXY_VARIABLES:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("REQUESTS_CA_BUNDLE", str(ca))
    payload = b"p" * (MIB + 1) if source == "attribute" else b"file-bytes-" + source.encode()
    delivered: list[_Delivery] = []
    hue_puts: list[_Delivery] = []
    servers: list[ThreadingHTTPServer] = []
    upload_url = ""
    try:
        if destination == "third_party_https":
            collector = _serve((other_host, 0), _collector(delivered), tls=context)
            servers.append(collector)
            port = collector.server_address[1]
            upload_url = f"https://{other_host}:{port}/collect"
        elif destination == "loopback_ipv6":
            collector = _serve(("::1", 0), _collector(delivered))
            servers.append(collector)
            port = collector.server_address[1]
            upload_url = f"http://[::1]:{port}/collect"
        elif destination == "localhost":
            collector = _serve(("::1", 0), _collector(delivered))
            servers.append(collector)
            port = collector.server_address[1]
            servers.append(_serve(("127.0.0.1", port), _collector(delivered)))
            upload_url = f"http://localhost:{port}/collect"
        else:
            collector = _serve(("127.0.0.2", 0), _collector(delivered))
            servers.append(collector)
            port = collector.server_address[1]
            upload_url = f"http://127.0.0.2:{port}/collect"
        hue_server = _serve((HUE_HOST, 0), _hue(upload_url, hue_puts), tls=context)
        servers.append(hue_server)
        hue_port = hue_server.server_address[1]
        with Hue(
            f"https://{HUE_HOST}:{hue_port}",
            api_key=KEY,
            capture_content=True,
            live_spans=False,
        ) as hue:
            _capture(hue, source, payload, tmp_path / "captured.bin")
            hue.force_flush()
            status = hue.export_status
            uploaded = status.uploaded_values
            fallbacks = status.upload_fallbacks
    finally:
        for server in servers:
            _stop(server)
    expected = hashlib.sha256(payload).hexdigest()
    assert delivered == [] and hue_puts == [], (upload_url, expected, uploaded, fallbacks)
    assert (uploaded, fallbacks) == (0, 1)
