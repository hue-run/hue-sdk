"""Two loopback services and assertions against the SDK's actual OTLP export."""

from __future__ import annotations

import gzip
import json
from contextlib import ExitStack, contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from urllib.parse import parse_qs, urlsplit

from main import run
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest

from hue_sdk import Hue

MESSAGES = [
    {
        "id": f"synthetic-{index}",
        "threadId": f"thread-{index}",
        "labelIds": ["INBOX", "UNREAD"],
        "snippet": f"Synthetic message {index} for the inbox example.",
        "payload": {
            "mimeType": "text/plain",
            "headers": [{"name": "Subject", "value": f"Synthetic subject {index}"}],
            "body": {"size": 5, "data": "aGVsbG8"},
        },
    }
    for index in range(1, 6)
]


@contextmanager
def serve(handler):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def verify(options: dict[str, bool]) -> None:
    exports = []
    exported_bodies: list[bytes] = []
    reads: list[str] = []
    acknowledgements: list[str] = []

    class Handler(BaseHTTPRequestHandler):
        def reply(self, status: int, body: bytes, content_type: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Hue-Pending-Spans", "1")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args: object) -> None:
            pass

    class GmailHandler(Handler):
        def do_GET(self) -> None:
            assert self.headers.get("Authorization") == "Bearer synthetic-gmail-access-token"
            assert self.headers.get("traceparent") is None, "Capture must not inject traceparent."
            route = urlsplit(self.path)
            prefix = "/gmail/v1/users/me/messages"
            if route.path == prefix and parse_qs(route.query) == {
                "maxResults": ["5"],
                "q": ["is:unread"],
            }:
                payload = {
                    "messages": [{"id": m["id"], "threadId": m["threadId"]} for m in MESSAGES],
                    "resultSizeEstimate": len(MESSAGES),
                }
            else:
                payload = next((m for m in MESSAGES if route.path == f"{prefix}/{m['id']}"), None)
                if payload is None or parse_qs(route.query) != {"format": ["full"]}:
                    self.reply(404, b"{}", "application/json")
                    return
            reads.append(self.path)
            self.reply(200, json.dumps(payload).encode(), "application/json")

    class ReceiverHandler(Handler):
        def do_POST(self) -> None:
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            if self.headers.get("Content-Encoding") == "gzip":
                body = gzip.decompress(body)
            exported_bodies.append(body)
            if self.path == "/api/v1/otlp/v1/traces":
                request = ExportTraceServiceRequest.FromString(body)
                exports.extend(
                    span
                    for resource in request.resource_spans
                    for scope in resource.scope_spans
                    for span in scope.spans
                    if span.end_time_unix_nano
                )
            elif self.path != "/api/v1/otlp/v1/logs":
                self.reply(404, b"", "application/x-protobuf")
                return
            acknowledgements.append(f"POST {self.path} 200")
            self.reply(200, b"", "application/x-protobuf")

    with ExitStack() as stack:
        gmail_url = stack.enter_context(serve(GmailHandler))
        receiver_url = stack.enter_context(serve(ReceiverHandler))
        with Hue(
            base_url=receiver_url,
            api_key="synthetic-verify-key",
            service_name="gmail-summary-python",
            **options,
        ) as hue:
            trace_id, summary = run(hue, gmail_url, "synthetic-gmail-access-token")
            if not hue.force_flush():
                raise RuntimeError("Telemetry export did not complete successfully.")

    def attributes(span):
        return {
            item.key: item.value.string_value
            if item.value.WhichOneof("value") == "string_value"
            else item.value.int_value
            for item in span.attributes
        }

    assert summary == {"count": 5, "ids": [m["id"] for m in MESSAGES]}, summary
    assert len(reads) == 6, reads
    tools = [s for s in exports if attributes(s).get("gen_ai.operation.name") == "execute_tool"]
    assert len(tools) == 1, f"Expected one tool span, got {len(tools)}."
    assert all(s.trace_id.hex() == trace_id for s in exports), "All spans must share one trace."
    tool_attrs = attributes(tools[0])
    if options.get("capture_content", True):
        assert json.loads(tool_attrs["gen_ai.tool.call.arguments"]) == {
            "query": "is:unread",
            "limit": 5,
        }
        assert json.loads(tool_attrs["gen_ai.tool.call.result"]) == summary
    else:
        assert "gen_ai.tool.call.arguments" not in tool_attrs
        assert "gen_ai.tool.call.result" not in tool_attrs
    clients = [s for s in exports if s.kind == 3]
    expected_clients = 6 if options.get("capture_http", True) else 0
    assert len(clients) == expected_clients, (
        f"Expected {expected_clients} HTTP spans, got {len(clients)}."
    )
    assert len(exports) == 2 + expected_clients, f"Unexpected exported spans: {len(exports)}."
    bodies = options.get("capture_content", True) and options.get("capture_http_bodies", True)
    for span in clients:
        attrs = attributes(span)
        assert span.parent_span_id == tools[0].span_id, "HTTP span must be a tool child."
        assert attrs["http.request.method"] == "GET"
        assert attrs["http.response.status_code"] == 200
        assert attrs["url.full"].startswith(f"{gmail_url}/gmail/v1/users/me/messages")
        assert "?" not in attrs["url.full"], "The URL must omit query values."
        if bodies:
            assert json.loads(attrs["input.value"]) == (
                {"maxResults": "5", "q": "is:unread"}
                if attrs["url.full"].endswith("/messages")
                else {"format": "full"}
            )
            output = json.loads(attrs["output.value"])
            assert output == (
                {
                    "messages": [{"id": m["id"], "threadId": m["threadId"]} for m in MESSAGES],
                    "resultSizeEstimate": 5,
                }
                if attrs["url.full"].endswith("/messages")
                else next(m for m in MESSAGES if attrs["url.full"].endswith(f"/{m['id']}"))
            )
        else:
            assert "input.value" not in attrs and "output.value" not in attrs
    wire = b"".join(exported_bodies)
    assert b"synthetic-gmail-access-token" not in wire, "Gmail authorization must not be exported."
    assert b"synthetic-verify-key" not in wire, "Hue authorization must not be exported."
    if not bodies or not options.get("capture_http", True):
        assert b"Synthetic message " not in wire and b"Synthetic subject " not in wire
    assert acknowledgements, "The receiver must acknowledge a real OTLP export."
    print(
        json.dumps(
            {
                "mode": "offline",
                "trace_id": trace_id,
                "summary": summary,
                "http_spans": len(clients),
                "http_bodies": bodies,
                "exported": True,
            }
        )
    )
    for acknowledgement in acknowledgements:
        print(acknowledgement)
