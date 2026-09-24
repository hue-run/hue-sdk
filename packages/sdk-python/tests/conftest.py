from __future__ import annotations

import gzip
import json
import time
from collections import deque
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock, Thread

import pytest
from opentelemetry.proto.collector.logs.v1.logs_service_pb2 import ExportLogsServiceRequest
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest


@dataclass
class Receiver:
    url: str = ""
    delay_seconds: float = 0
    # Send each response one byte at a time with this pause, so no single read waits long.
    trickle_seconds: float = 0
    # A receiver that predates live spans (an older Hue or a generic collector) omits the
    # Hue-Pending-Spans header from its default trace acknowledgements.
    legacy: bool = False
    requests: list[tuple[str, dict[str, str], bytes]] = field(default_factory=list)
    replies: deque[tuple[int, bytes, dict[str, str]]] = field(default_factory=deque)
    lock: Lock = field(default_factory=Lock)

    def reply(self, status: int, body: bytes = b"", **headers: str) -> None:
        with self.lock:
            self.replies.append((status, body, headers))

    def spans(self):
        result = []
        for path, _, body in self.requests:
            if path.endswith("/traces"):
                request = ExportTraceServiceRequest.FromString(body)
                result.extend(
                    span
                    for resource in request.resource_spans
                    for scope in resource.scope_spans
                    for span in scope.spans
                )
        return result

    def logs(self):
        result = []
        for path, _, body in self.requests:
            if path.endswith("/logs"):
                request = ExportLogsServiceRequest.FromString(body)
                result.extend(
                    log
                    for resource in request.resource_logs
                    for scope in resource.scope_logs
                    for log in scope.log_records
                )
        return result


@pytest.fixture
def receiver():
    state = Receiver()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.respond()

        def do_POST(self):
            self.respond()

        def respond(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            # Store decoded bytes so content assertions inspect what the wire carried, and the
            # raw wire length so cap assertions check what was actually sent.
            headers = dict(self.headers)
            headers["X-Wire-Bytes"] = str(len(body))
            if self.headers.get("Content-Encoding") == "gzip":
                body = gzip.decompress(body)
            with state.lock:
                state.requests.append((self.path, headers, body))
                if state.replies:
                    status, result, headers = state.replies.popleft()
                elif self.path == "/api/v1/projects/current":
                    status, result, headers = (
                        200,
                        json.dumps(
                            {
                                "id": "00000000-0000-4000-8000-000000000001",
                                "name": "Synthetic SDK project",
                                "slug": "synthetic-sdk",
                                "organizationId": "00000000-0000-4000-8000-000000000002",
                            }
                        ).encode(),
                        {"Content-Type": "application/json", "Cache-Control": "no-store"},
                    )
                else:
                    status, result, headers = 200, b"", {"Content-Type": "application/x-protobuf"}
                    if self.path.endswith("/traces") and not state.legacy:
                        # A current Hue marks every trace acknowledgement this way.
                        headers["Hue-Pending-Spans"] = "1"
            time.sleep(state.delay_seconds)
            if state.trickle_seconds:
                head = "".join(
                    [
                        f"{self.protocol_version} {status} Reply\r\n",
                        *(f"{key}: {value}\r\n" for key, value in headers.items()),
                        f"Content-Length: {len(result)}\r\n\r\n",
                    ]
                )
                try:
                    for byte in head.encode() + result:
                        self.wfile.write(bytes([byte]))
                        time.sleep(state.trickle_seconds)
                except OSError:
                    pass  # The client gave up and shut the connection.
                return
            self.send_response(status)
            for key, value in headers.items():
                self.send_header(key, value)
            self.send_header("Content-Length", str(len(result)))
            self.end_headers()
            self.wfile.write(result)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    state.url = f"http://127.0.0.1:{server.server_port}"
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield state
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
