"""Two loopback services and assertions against the SDK's actual OTLP export."""

from __future__ import annotations

import gzip
import json
from contextlib import ExitStack, contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from urllib.parse import parse_qs, urlsplit

import requests
from main import run
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest

from hue_sdk import Hue

NEXT_PAGE_TOKEN = "synthetic-next-page"
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


def verify(options: dict[str, bool], *, model_scope: bool = False, canonical: bool = False) -> None:
    fixture_name = None
    max_results = 5
    messages = MESSAGES
    listing = {
        "messages": [{"id": m["id"], "threadId": m["threadId"]} for m in messages],
        "resultSizeEstimate": len(messages),
        "nextPageToken": NEXT_PAGE_TOKEN,
    }
    if canonical:
        fixture = json.loads(
            (
                Path(__file__).resolve().parents[1] / "fixtures" / "canonical-gmail-v2.json"
            ).read_text()
        )
        fixture_name = fixture["name"]
        max_results = fixture["maxResults"]
        messages, listing = fixture["messages"], fixture["list"]
    exports = []
    exported_bodies: list[bytes] = []
    reads: list[str] = []
    provider_reads: list[str] = []
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
        def do_POST(self) -> None:
            assert self.path == "/v1/synthetic-model"
            assert self.headers.get("traceparent") is None, "Capture must not inject traceparent."
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            assert body["prompt"] == f"synthetic-provider-request-{len(provider_reads)}"
            provider_reads.append(body["prompt"])
            self.reply(
                200,
                json.dumps({"completion": "synthetic-provider-response"}).encode(),
                "application/json",
            )

        def do_GET(self) -> None:
            assert self.headers.get("Authorization") == "Bearer synthetic-gmail-access-token"
            assert self.headers.get("traceparent") is None, "Capture must not inject traceparent."
            route = urlsplit(self.path)
            prefix = "/gmail/v1/users/me/messages"
            if route.path == prefix and parse_qs(route.query) == {
                "maxResults": [str(max_results)],
                "q": ["is:unread"],
            }:
                payload = listing
            else:
                payload = next((m for m in messages if route.path == f"{prefix}/{m['id']}"), None)
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
            if model_scope:
                with hue.model("synthetic-model", provider="synthetic") as model:
                    model.set_input({"task": "Summarize five unread Gmail messages."})
                    with requests.Session() as provider:
                        before = provider.post(
                            f"{gmail_url}/v1/synthetic-model",
                            json={"prompt": "synthetic-provider-request-0"},
                            timeout=15,
                        )
                        before.raise_for_status()
                        assert before.json() == {"completion": "synthetic-provider-response"}
                        trace_id, summary = run(
                            hue, gmail_url, "synthetic-gmail-access-token", max_results=max_results
                        )
                        after = provider.post(
                            f"{gmail_url}/v1/synthetic-model",
                            json={"prompt": "synthetic-provider-request-1"},
                            timeout=15,
                        )
                        after.raise_for_status()
                        assert after.json() == {"completion": "synthetic-provider-response"}
                    model.set_output(summary)
            else:
                trace_id, summary = run(
                    hue, gmail_url, "synthetic-gmail-access-token", max_results=max_results
                )
            if not hue.force_flush():
                raise RuntimeError("Telemetry export did not complete successfully.")

    def attributes(span):
        return {
            item.key: item.value.string_value
            if item.value.WhichOneof("value") == "string_value"
            else item.value.int_value
            for item in span.attributes
        }

    assert summary == {"count": 5, "ids": [m["id"] for m in messages]}, summary
    assert len(reads) == 6, reads
    tools = [s for s in exports if attributes(s).get("gen_ai.operation.name") == "execute_tool"]
    assert len(tools) == 1, f"Expected one tool span, got {len(tools)}."
    assert all(s.trace_id.hex() == trace_id for s in exports), "All spans must share one trace."
    tool_attrs = attributes(tools[0])
    if options.get("capture_content", True):
        assert json.loads(tool_attrs["gen_ai.tool.call.arguments"]) == {
            "query": "is:unread",
            "limit": max_results,
        }
        assert json.loads(tool_attrs["gen_ai.tool.call.result"]) == summary
    else:
        assert "gen_ai.tool.call.arguments" not in tool_attrs
        assert "gen_ai.tool.call.result" not in tool_attrs
    models = [s for s in exports if attributes(s).get("gen_ai.operation.name") == "chat"]
    assert len(models) == int(model_scope)
    if model_scope:
        assert len(provider_reads) == 2
        model_attrs = attributes(models[0])
        assert model_attrs["gen_ai.provider.name"] == "synthetic"
        assert model_attrs["gen_ai.request.model"] == "synthetic-model"
    clients = [s for s in exports if "http.request.method" in attributes(s)]
    expected_clients = (8 if model_scope else 6) if options.get("capture_http", True) else 0
    assert len(clients) == expected_clients, (
        f"Expected {expected_clients} HTTP spans, got {len(clients)}."
    )
    provider_clients = [s for s in clients if attributes(s)["http.request.method"] == "POST"]
    assert len(provider_clients) == (2 if model_scope and options.get("capture_http", True) else 0)
    assert len(exports) == 2 + int(model_scope) + expected_clients, (
        f"Unexpected exported spans: {len(exports)}."
    )
    bodies = (
        options.get("capture_http", True)
        and options.get("capture_content", True)
        and options.get("capture_http_bodies", True)
    )
    for span in clients:
        attrs = attributes(span)
        assert span.kind == 3, "HTTP spans must have CLIENT kind."
        assert attrs["http.response.status_code"] == 200
        if attrs["http.request.method"] == "POST":
            assert model_scope and span.parent_span_id == models[0].span_id
            assert attrs["url.full"] == f"{gmail_url}/v1/synthetic-model"
            assert "input.value" not in attrs and "output.value" not in attrs
            continue
        assert span.parent_span_id == tools[0].span_id, "Gmail HTTP span must be a tool child."
        assert attrs["http.request.method"] == "GET"
        assert attrs["url.full"].startswith(f"{gmail_url}/gmail/v1/users/me/messages")
        assert "?" not in attrs["url.full"], "The URL must omit query values."
        if bodies:
            assert json.loads(attrs["input.value"]) == (
                {"maxResults": str(max_results), "q": "is:unread"}
                if attrs["url.full"].endswith("/messages")
                else {"format": "full"}
            )
            output = json.loads(attrs["output.value"])
            assert output == (
                listing
                if attrs["url.full"].endswith("/messages")
                else next(m for m in messages if attrs["url.full"].endswith(f"/{m['id']}"))
            ), output
        else:
            assert "input.value" not in attrs and "output.value" not in attrs
    wire = b"".join(exported_bodies)
    assert b"synthetic-gmail-access-token" not in wire, "Gmail authorization must not be exported."
    assert b"synthetic-verify-key" not in wire, "Hue authorization must not be exported."
    assert b"synthetic-provider-request-" not in wire
    assert b"synthetic-provider-response" not in wire
    if not bodies:
        assert b"Synthetic message " not in wire and b"Synthetic subject " not in wire
        assert NEXT_PAGE_TOKEN.encode() not in wire
    assert acknowledgements, "The receiver must acknowledge a real OTLP export."
    evidence = {
        "mode": "model-scope" if model_scope else "offline",
        "trace_id": trace_id,
        "summary": summary,
        "http_spans": len(clients),
        "http_bodies": bodies,
        "exported": True,
    }
    if fixture_name is not None:
        evidence["fixture"] = fixture_name
    print(json.dumps(evidence))
    for acknowledgement in acknowledgements:
        print(acknowledgement)
