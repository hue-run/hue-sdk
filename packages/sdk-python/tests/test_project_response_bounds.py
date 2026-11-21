"""Project and media responses must stay bounded.

These tests fail while a Hue origin can crash the caller with a nested JSON
array, or make project validation read a body larger than the cap below.
"""

from __future__ import annotations

import json
import socket
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Event, Thread

import pytest

from hue_sdk import Hue, Project, ProjectValidationError
from hue_sdk.evals import EvaluationClient, MediaFetchError

KEY = "synthetic-local-project-key"
TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
SHA256 = "ab" * 32
# Same bound as a signaled SafeSession response (transport.py) and the
# TypeScript project check. A project document fits in it.
PROJECT_BODY_CAP = 65_536
# urllib3 reads 64 KiB per chunk, and the kernel send buffer can accept one
# more small write after the client stops.
READ_AHEAD = 65_536 + 8_192


def _nested_array() -> bytes:
    """The smallest nested array this interpreter refuses, inside the cap.

    A cap alone still parses this body, so the caller must treat the parser's
    RecursionError as a validation failure.
    """
    low, high = 1, PROJECT_BODY_CAP // 2
    failing: int | None = None
    while low <= high:
        depth = (low + high) // 2
        sample = "[" * depth + "]" * depth
        try:
            json.loads(sample)
        except RecursionError:
            failing = depth
            high = depth - 1
        else:
            low = depth + 1
    if failing is None:
        raise AssertionError(
            "json.loads accepted every nested array that fits in the project body cap "
            f"on Python {sys.version.split()[0]}"
        )
    body = ("[" * failing + "]" * failing).encode()
    assert len(body) <= PROJECT_BODY_CAP
    return body


def _oversized_project() -> bytes:
    padding = PROJECT_BODY_CAP + READ_AHEAD + 1
    name = b"n" * padding
    return (
        b'{"id":"00000000-0000-4000-8000-000000000001","name":"'
        + name
        + b'","slug":"synthetic","organizationId":"00000000-0000-4000-8000-000000000002"}'
    )


class _Origin:
    def __init__(self, body: bytes, *, chunked: bool) -> None:
        self.body = body
        self.chunked = chunked
        self.sent = 0
        self.path: str | None = None
        self.done = Event()
        self.url = ""


def _serve(origin: _Origin) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            if self.path != "/api/v1/projects/current" and not self.path.startswith(
                "/api/v1/traces/"
            ):
                self.send_error(404)
                return
            self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            self.connection.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 4096)
            self.connection.settimeout(5)
            origin.path = self.path
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            if origin.chunked:
                self.send_header("Transfer-Encoding", "chunked")
            else:
                self.send_header("Content-Length", str(len(origin.body)))
            self.end_headers()
            view = memoryview(origin.body)
            offset = 0
            try:
                while offset < len(view):
                    chunk = view[offset : offset + 4096]
                    if origin.chunked:
                        self.wfile.write(f"{len(chunk):x}\r\n".encode())
                        self.wfile.write(chunk)
                        self.wfile.write(b"\r\n")
                    else:
                        self.wfile.write(chunk)
                    self.wfile.flush()
                    offset += len(chunk)
                    origin.sent = offset
                if origin.chunked:
                    self.wfile.write(b"0\r\n\r\n")
                    self.wfile.flush()
            except OSError:
                pass
            finally:
                origin.done.set()

        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length", "0"))
            if length:
                self.rfile.read(length)
            self.send_response(200)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, format: str, *args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    origin.url = f"http://127.0.0.1:{server.server_port}"
    thread = Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    thread.start()
    server.thread = thread  # type: ignore[attr-defined]
    return server


@contextmanager
def _origin(body: bytes, *, chunked: bool = False) -> Iterator[_Origin]:
    origin = _Origin(body, chunked=chunked)
    server = _serve(origin)
    try:
        yield origin
    finally:
        server.shutdown()
        server.server_close()
        server.thread.join(timeout=5)  # type: ignore[attr-defined]


def test_a_small_project_response_validates() -> None:
    body = json.dumps(
        {
            "id": "00000000-0000-4000-8000-000000000001",
            "name": "Synthetic SDK project",
            "slug": "synthetic-sdk",
            "organizationId": "00000000-0000-4000-8000-000000000002",
        }
    ).encode()
    with _origin(body) as origin:
        with Hue(origin.url, KEY, capture_content=False) as hue:
            project = hue.validate_project()
    assert isinstance(project, Project)
    assert project.slug == "synthetic-sdk"
    assert origin.path == "/api/v1/projects/current"


def test_nested_project_json_is_a_validation_error() -> None:
    body = _nested_array()
    with _origin(body) as origin:
        with Hue(origin.url, KEY, capture_content=False) as hue:
            with pytest.raises(ProjectValidationError):
                hue.validate_project()
    assert origin.path == "/api/v1/projects/current"
    assert origin.sent == len(body)


def test_project_validation_stops_at_the_body_cap() -> None:
    body = _oversized_project()
    assert len(body) > PROJECT_BODY_CAP + READ_AHEAD
    with _origin(body, chunked=True) as origin:
        with Hue(origin.url, KEY, capture_content=False, export_timeout_seconds=5) as hue:
            with pytest.raises(ProjectValidationError):
                hue.validate_project()
        assert origin.done.wait(2)
        assert origin.path == "/api/v1/projects/current"
        assert 0 < origin.sent <= PROJECT_BODY_CAP + READ_AHEAD
        assert origin.sent < len(body)


def test_nested_media_grant_is_a_fetch_error() -> None:
    body = _nested_array()
    with _origin(body) as origin:
        client = EvaluationClient(origin.url, KEY)
        with pytest.raises(MediaFetchError):
            client.media.fetch(sha256=SHA256, trace_id=TRACE_ID)
    assert origin.path is not None and origin.path.startswith("/api/v1/traces/")
    assert origin.sent == len(body)
