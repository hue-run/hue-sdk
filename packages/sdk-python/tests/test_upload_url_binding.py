"""A Hue reservation must not make the client PUT local bytes anywhere but the configured origin.

The client currently accepts every HTTPS upload URL, and HTTP to localhost, 127.0.0.1 or
[::1], then PUTs the caller's file there. These tests fail while that is true. They pass once
an upload URL is accepted only when its scheme, host and port are the configured Hue origin,
including when a second parse of the same string would connect somewhere else.

Same-origin uploads are still required to deliver the bytes, and only the allowed headers.
"""

from __future__ import annotations

import json
import socket
import ssl
import subprocess
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from typing import Any

import certifi
import pytest
import requests.adapters
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from hue_sdk.evals.client import EvaluationClient
from hue_sdk.evals.types import CaseFileWrite
from hue_sdk.managed import ManagedOutputFile, ManagedTargetHandler, ManagedTargetResult

EXECUTION = "11111111-1111-4111-8111-111111111111"
FILE = "22222222-2222-4222-8222-222222222222"
CASE = "33333333-3333-4333-8333-333333333333"
VERSION = "44444444-4444-4444-8444-444444444444"
TRACE = "1234567890abcdef1234567890abcdef"
DATA = b"synthetic document bytes"
CONTENT_TYPE = "text/plain"
# Placeholders. The upload must not carry the project key or the invocation token.
PROJECT_KEY = "synthetic-project-key"
MACHINE = "synthetic-machine"
INVOCATION = "synthetic-scoped-token"
ALLOWED_HEADERS = {"content-type": CONTENT_TYPE, "x-vercel-blob-access": "private"}

# Destinations a hostile reservation can name. Each one is a server this process owns.
OFF_ORIGIN = (
    "foreign_https",
    "other_port",
    "loopback_v4",
    "localhost_http",
    "loopback_v6",
    "encoded_host",
)


class _Capture(ThreadingHTTPServer):
    puts: list[dict[str, Any]]
    upload_url: str

    def __init__(self, address: tuple[str, int], family: socket.AddressFamily) -> None:
        self.puts = []
        self.upload_url = ""
        self.address_family = family
        super().__init__(address, _Handler)

    def server_bind(self) -> None:
        if self.address_family == socket.AF_INET6:
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
        super().server_bind()


class _Handler(BaseHTTPRequestHandler):
    server: _Capture

    def do_GET(self) -> None:
        self._json({"id": FILE, "state": "ready"})

    def do_POST(self) -> None:
        self._discard()
        if self.path.endswith("/claim"):
            self._json({"claimed": True, "executionId": EXECUTION, "state": "running"})
            return
        if self.path.endswith("/files") or self.path.endswith("/artifacts"):
            self._json(
                {
                    "artifactId": FILE,
                    "id": FILE,
                    "state": "reserved",
                    "uploadUrl": self.server.upload_url,
                    "headers": ALLOWED_HEADERS,
                }
            )
            return
        if self.path.endswith("/upload"):
            self._json(
                {
                    "method": "PUT",
                    "uploadUrl": self.server.upload_url,
                    "headers": ALLOWED_HEADERS,
                    "expiresAt": "2099-01-01T00:00:00Z",
                }
            )
            return
        if self.path.endswith("/complete"):
            self._json({"id": FILE, "state": "ready"})
            return
        self._json({"id": CASE, "revision": 2})

    def do_PUT(self) -> None:
        declared = self.headers.get("Content-Length")
        body = self.rfile.read(int(declared)) if declared is not None else self.rfile.read()
        self.server.puts.append(
            {
                "path": self.path,
                "body": body,
                "authorization": self.headers.get("Authorization"),
                "content_type": self.headers.get("Content-Type"),
                "private_access": self.headers.get("X-Vercel-Blob-Access"),
            }
        )
        self.send_response(200)
        self.end_headers()

    def _discard(self) -> None:
        declared = self.headers.get("Content-Length")
        if declared is not None:
            self.rfile.read(int(declared))

    def _json(self, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:
        return


def _certificate(directory: Path) -> tuple[Path, Path]:
    config = directory / "san.cnf"
    config.write_text(
        "\n".join(
            (
                "[req]",
                "distinguished_name = dn",
                "req_extensions = v3",
                "prompt = no",
                "[dn]",
                "CN = localhost",
                "[v3]",
                "subjectAltName = DNS:localhost,IP:127.0.0.1,IP:::1",
                "basicConstraints = CA:FALSE",
                "keyUsage = digitalSignature,keyEncipherment",
                "extendedKeyUsage = serverAuth",
                "",
            )
        )
    )
    key = directory / "server.key"
    certificate = directory / "server.pem"
    ca = directory / "ca.pem"
    ca_key = directory / "ca.key"
    request = directory / "server.csr"
    subprocess.run(
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            str(ca_key),
            "-out",
            str(ca),
            "-days",
            "1",
            "-subj",
            "/CN=hue-sdk-test-ca",
        ],
        check=True,
        capture_output=True,
    )
    subprocess.run(
        [
            "openssl",
            "req",
            "-new",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            str(key),
            "-out",
            str(request),
            "-config",
            str(config),
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
            str(request),
            "-CA",
            str(ca),
            "-CAkey",
            str(ca_key),
            "-CAcreateserial",
            "-out",
            str(certificate),
            "-days",
            "1",
            "-copy_extensions",
            "copy",
        ],
        check=True,
        capture_output=True,
    )
    bundle = directory / "bundle.pem"
    bundle.write_bytes(Path(certifi.where()).read_bytes() + b"\n" + ca.read_bytes())
    return certificate, key


def _listen(address: tuple[str, int], family: socket.AddressFamily, tls: tuple[Path, Path] | None):
    server = _Capture(address, family)
    if tls is not None:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(tls[0], tls[1])
        server.socket = context.wrap_socket(server.socket, server_side=True)
    thread = Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    thread.start()
    return server, thread


class _World:
    def __init__(self, tmp: Path) -> None:
        certificate = _certificate(tmp)
        self.hue, self._hue_thread = _listen(("127.0.0.1", 0), socket.AF_INET, certificate)
        self.other, self._other_thread = _listen(("127.0.0.1", 0), socket.AF_INET, certificate)
        self.v6_https, self._v6_https_thread = _listen(("::1", 0), socket.AF_INET6, certificate)
        self.v4_http, self._v4_http_thread = _listen(("127.0.0.1", 0), socket.AF_INET, None)
        self.v6_http, self._v6_http_thread = _listen(("::1", 0), socket.AF_INET6, None)
        self.servers = (self.hue, self.other, self.v6_https, self.v4_http, self.v6_http)
        self.threads = (
            self._hue_thread,
            self._other_thread,
            self._v6_https_thread,
            self._v4_http_thread,
            self._v6_http_thread,
        )
        self.origin = f"https://127.0.0.1:{self.hue.server_port}"
        self.bundle = str(tmp / "bundle.pem")

    def close(self) -> None:
        for server in self.servers:
            server.shutdown()
            server.server_close()
        for thread in self.threads:
            thread.join(timeout=2)

    def clear(self) -> None:
        for server in self.servers:
            server.puts.clear()

    def url(self, name: str) -> str:
        other = self.other.server_port
        if name == "foreign_https":
            return f"https://[::1]:{self.v6_https.server_port}/collect"
        if name == "other_port":
            return f"https://127.0.0.1:{other}/collect"
        if name == "loopback_v4":
            return f"http://127.0.0.1:{self.v4_http.server_port}/internal"
        if name == "localhost_http":
            # localhost resolves to ::1 first on this host; the v6 listener is that service.
            return f"http://localhost:{self.v6_http.server_port}/internal"
        if name == "loopback_v6":
            return f"http://[::1]:{self.v6_http.server_port}/internal"
        if name == "encoded_host":
            # urlsplit keeps the percent-encoding; requests decodes it and connects to 127.0.0.1.
            return f"https://127%2e0%2e0%2e1:{other}/collect"
        if name == "reparsed_userinfo":
            # urlsplit sees the Hue origin and a username. requests connects to localhost.
            return f"https://localhost:{other}\\@127.0.0.1:{self.hue.server_port}/collect"
        if name == "origin":
            return f"{self.origin}/upload"
        raise AssertionError(name)

    def delivered(self) -> list[tuple[int, dict[str, Any]]]:
        found = []
        for server in self.servers:
            found.extend((server.server_port, put) for put in server.puts)
        return found


@pytest.fixture(scope="module")
def world(tmp_path_factory: pytest.TempPathFactory):
    previous = requests.adapters.DEFAULT_CA_BUNDLE_PATH
    box = _World(tmp_path_factory.mktemp("upload-url"))
    # Managed uploads ignore REQUESTS_CA_BUNDLE (trust_env is false) and use this path.
    requests.adapters.DEFAULT_CA_BUNDLE_PATH = box.bundle
    yield box
    requests.adapters.DEFAULT_CA_BUNDLE_PATH = previous
    box.close()


@pytest.fixture
def trusted(world: _World, monkeypatch: pytest.MonkeyPatch):
    bundle = world.bundle
    monkeypatch.setenv("REQUESTS_CA_BUNDLE", bundle)
    monkeypatch.setenv("CURL_CA_BUNDLE", bundle)
    proxies = ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "all_proxy")
    for name in proxies:
        monkeypatch.delenv(name, raising=False)
    world.clear()
    for server in world.servers:
        server.upload_url = ""
    return world


def _point(world: _World, name: str) -> None:
    upload = world.url(name)
    for server in world.servers:
        server.upload_url = upload


def _managed(world: _World) -> None:
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(InMemorySpanExporter()))

    def target(_context: Any) -> ManagedTargetResult:
        return ManagedTargetResult(
            output="synthetic",
            files=(ManagedOutputFile("notes.txt", CONTENT_TYPE, DATA, primary=True),),
        )

    def flush() -> bool:
        provider.force_flush()
        return True

    handler = ManagedTargetHandler(
        machine_credential=MACHINE,
        base_url=world.origin,
        target=target,
        flush_telemetry=flush,
        tracer=provider.get_tracer("upload-url-binding"),
    )
    deadline = (
        (datetime.now(timezone.utc) + timedelta(seconds=20))
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )
    try:
        handler.handle(
            {
                "protocolVersion": 1,
                "executionId": EXECUTION,
                "attempt": 1,
                "input": {"query": "synthetic"},
                "config": {},
                "inputFiles": [],
                "deadline": deadline,
                "traceparent": f"00-{TRACE}-1234567890abcdef-01",
            },
            {"Authorization": f"Bearer {MACHINE}", "X-Hue-Invocation-Token": INVOCATION},
        )
    finally:
        provider.shutdown()


def _client(world: _World) -> EvaluationClient:
    return EvaluationClient(world.origin, api_key=PROJECT_KEY, timeout_seconds=5, max_attempts=1)


def _artifact(world: _World) -> None:
    client = _client(world)
    reserved = client.reserve_artifact(
        idempotency_key="synthetic-artifact",
        filename="notes.txt",
        content_type=CONTENT_TYPE,
        byte_size=len(DATA),
        sha256="0" * 64,
    )
    upload = client.request_artifact_upload(reserved["id"])
    client.upload_artifact_bytes(upload, DATA, CONTENT_TYPE)


def _case_file(world: _World, data: bytes | Path) -> None:
    client = _client(world)
    if isinstance(data, Path):
        file = CaseFileWrite(
            role="source", filename="notes.txt", content_type=CONTENT_TYPE, path=data
        )
    else:
        file = CaseFileWrite(
            role="source", filename="notes.txt", content_type=CONTENT_TYPE, data=data
        )
    client.add_case(
        VERSION,
        expected_revision=1,
        external_key="synthetic-case",
        inputs={"query": "synthetic"},
        files=[file],
    )


def _run(action: Callable[[], None]) -> None:
    try:
        action()
    except Exception:
        # A refusal is the fixed behavior. A PUT that already happened is still recorded.
        return


def _assert_nowhere(world: _World) -> None:
    assert world.delivered() == []


@pytest.mark.parametrize("operation", ["managed", "artifact", "case_file"])
@pytest.mark.parametrize("destination", OFF_ORIGIN)
def test_file_bytes_are_not_put_off_the_hue_origin(
    trusted: _World, operation: str, destination: str
):
    _point(trusted, destination)
    if operation == "managed":
        _run(lambda: _managed(trusted))
    elif operation == "artifact":
        _run(lambda: _artifact(trusted))
    else:
        _run(lambda: _case_file(trusted, DATA))
    _assert_nowhere(trusted)


def test_case_file_read_from_disk_is_not_put_to_loopback(trusted: _World, tmp_path: Path):
    path = tmp_path / "notes.txt"
    path.write_bytes(DATA)
    _point(trusted, "loopback_v4")
    _run(lambda: _case_file(trusted, path))
    _assert_nowhere(trusted)


@pytest.mark.parametrize("operation", ["managed", "artifact", "case_file"])
def test_userinfo_that_reparses_to_another_host_is_not_uploaded(trusted: _World, operation: str):
    _point(trusted, "reparsed_userinfo")
    if operation == "managed":
        _run(lambda: _managed(trusted))
    elif operation == "artifact":
        _run(lambda: _artifact(trusted))
    else:
        _run(lambda: _case_file(trusted, DATA))
    _assert_nowhere(trusted)


@pytest.mark.parametrize("operation", ["managed", "artifact", "case_file"])
def test_same_origin_upload_puts_the_file_without_the_hue_credential(
    trusted: _World, operation: str
):
    _point(trusted, "origin")
    if operation == "managed":
        _managed(trusted)
    elif operation == "artifact":
        _artifact(trusted)
    else:
        _case_file(trusted, DATA)
    puts = trusted.delivered()
    assert len(puts) == 1
    _port, put = puts[0]
    assert put["path"] == "/upload"
    assert put["body"] == DATA
    assert put["authorization"] is None
    assert put["content_type"] == CONTENT_TYPE
    assert put["private_access"] == "private"
    assert PROJECT_KEY.encode() not in put["body"]
    assert INVOCATION.encode() not in put["body"]
