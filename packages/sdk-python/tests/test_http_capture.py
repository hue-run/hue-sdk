from __future__ import annotations

import asyncio
import gzip
import json
import subprocess
import sys
import urllib.request
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Event, Thread
from urllib.parse import urlsplit

import pytest
import requests
from opentelemetry import trace
from opentelemetry.context import attach, detach
from opentelemetry.sdk.trace import SpanProcessor, TracerProvider
from opentelemetry.trace import SpanKind

from hue_sdk import Hue
from hue_sdk._otel_compat import export_context

PAYLOAD = {"ok": True, "items": [{"id": "synthetic-item", "text": "héllo"}]}
BODY = json.dumps(PAYLOAD, ensure_ascii=False).encode()
TRANSPORTS = ("requests", "httpx", "httpx-async", "urllib", "aiohttp", "httplib2", "urllib3")


@dataclass
class App:
    url: str = ""
    body: bytes = BODY
    content_type: str = "application/json"
    status: int = 200
    requests: list = field(default_factory=list)
    routes: dict[str, bytes] = field(default_factory=dict)
    body_gate: Event | None = None
    incomplete: bool = False
    redirects: dict[str, str] = field(default_factory=dict)


@pytest.fixture
def app():
    state = App()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self):
            self.respond()

        def do_POST(self):
            self.respond()

        def respond(self):
            if self.headers.get("Transfer-Encoding") == "chunked":
                chunks = []
                while size := int(self.rfile.readline().split(b";", 1)[0], 16):
                    chunks.append(self.rfile.read(size))
                    assert self.rfile.read(2) == b"\r\n"
                assert self.rfile.readline() == b"\r\n"
                body = b"".join(chunks)
            else:
                body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            state.requests.append((self.path, dict(self.headers), body))
            result = state.routes.get(urlsplit(self.path).path, state.body)
            if self.path.startswith("/gzip"):
                result = gzip.compress(result, mtime=0)
            redirected = state.redirects.get(urlsplit(self.path).path)
            self.send_response(302 if redirected else state.status)
            if redirected:
                self.send_header("Location", redirected)
            self.send_header("Content-Type", state.content_type)
            chunked = self.path.startswith("/chunked")
            self.send_header(
                "Transfer-Encoding" if chunked else "Content-Length",
                "chunked" if chunked else str(len(result) + (7 if state.incomplete else 0)),
            )
            if state.incomplete:
                self.send_header("Connection", "close")
                self.close_connection = True
            self.send_header("Notion-Version", "2022-06-28")
            self.send_header("Set-Cookie", "synthetic-response-cookie=private")
            if self.path.startswith("/gzip"):
                self.send_header("Content-Encoding", "gzip")
            self.end_headers()
            if state.body_gate is not None:
                state.body_gate.wait(timeout=5)
            try:
                for offset in range(0, len(result), 8192):
                    chunk = result[offset : offset + 8192]
                    if chunked:
                        self.wfile.write(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
                    else:
                        self.wfile.write(chunk)
                if chunked:
                    self.wfile.write(b"0\r\n\r\n")
            except (BrokenPipeError, ConnectionResetError):
                pass

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    state.url = f"http://127.0.0.1:{server.server_port}"
    thread = Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    thread.start()
    try:
        yield state
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def attributes(span):
    def value(item):
        kind = item.WhichOneof("value")
        if kind == "array_value":
            return [value(member) for member in item.array_value.values]
        if kind == "kvlist_value":
            return {member.key: value(member.value) for member in item.kvlist_value.values}
        return getattr(item, kind)

    return {item.key: value(item.value) for item in span.attributes}


def http_spans(receiver):
    return [span for span in receiver.spans() if "http.request.method" in attributes(span)]


def drive(kind, url, *, stream=False, body=b'{"user_id":"synthetic-user","count":2}'):
    headers = {"Content-Type": "application/json", "Notion-Version": "2022-06-28"}
    if kind == "requests":
        with requests.Session() as client:
            with client.post(url, data=body, headers=headers, stream=stream) as response:
                return b"".join(response.iter_content(7)) if stream else response.content
    if kind in ("httpx", "httpx-async"):
        import httpx

        if kind == "httpx":
            with httpx.Client(trust_env=False) as client:
                request = client.build_request("POST", url, content=body, headers=headers)
                response = client.send(request, stream=stream)
                try:
                    return b"".join(response.iter_bytes(7)) if stream else response.content
                finally:
                    response.close()

        async def run():
            async with httpx.AsyncClient(trust_env=False) as client:
                request = client.build_request("POST", url, content=body, headers=headers)
                response = await client.send(request, stream=stream)
                try:
                    if stream:
                        return b"".join([part async for part in response.aiter_bytes(7)])
                    return response.content
                finally:
                    await response.aclose()

        return asyncio.run(run())
    if kind == "urllib":
        request = urllib.request.Request(url, data=body, headers=headers)
        with urllib.request.urlopen(request) as response:
            if stream:
                chunks = []
                while chunk := response.read(7):
                    chunks.append(chunk)
                return b"".join(chunks)
            return response.read()
    if kind == "aiohttp":
        import aiohttp

        async def run():
            async with aiohttp.ClientSession() as client:
                async with client.post(url, data=body, headers=headers) as response:
                    if stream:
                        return b"".join([part async for part in response.content.iter_chunked(7)])
                    return await response.read()

        return asyncio.run(run())
    if kind == "httplib2":
        import httplib2

        client = httplib2.Http(proxy_info=None)
        try:
            _, result = client.request(url, "POST", body=body, headers=headers)
            return result
        finally:
            client.close()
    if kind == "urllib3":
        import urllib3

        with urllib3.PoolManager() as client:
            response = client.request(
                "POST", url, body=body, headers=headers, preload_content=not stream
            )
            try:
                return b"".join(response.stream(7)) if stream else response.data
            finally:
                response.close()
    raise AssertionError(kind)


@pytest.mark.parametrize("kind", TRANSPORTS)
@pytest.mark.parametrize("stream", (False, True))
def test_each_transport_preserves_consumer_bytes_and_records_one_exchange(
    receiver, app, kind, stream
):
    url = app.url + "/exchange?maxResults=5&tag=first&tag=second&empty="
    baseline = drive(kind, url, stream=stream)
    with Hue(receiver.url, "synthetic-http-key", live_spans=False) as hue:
        with hue.span("application") as parent:
            actual = drive(kind, url, stream=stream)
        assert hue.force_flush()
    assert actual == baseline == BODY
    assert len(app.requests) == 2
    assert app.requests[0] == app.requests[1]
    assert all(
        "traceparent" not in {key.lower() for key in headers} for _, headers, _ in app.requests
    )
    (span,) = http_spans(receiver)
    assert span.kind == 3  # OTLP CLIENT
    assert span.parent_span_id.hex() == parent.span_id
    fields = attributes(span)
    assert fields["http.request.method"] == "POST"
    assert fields["url.full"] == app.url + "/exchange"
    assert fields["http.response.status_code"] == 200
    assert fields["server.address"] == "127.0.0.1"
    assert fields["server.port"] == int(app.url.rsplit(":", 1)[1])
    assert json.loads(fields["input.value"]) == {
        "maxResults": "5",
        "tag": ["first", "second"],
        "empty": "",
        "user_id": "synthetic-user",
        "count": 2,
    }
    assert json.loads(fields["output.value"]) == PAYLOAD
    assert fields["output.mime_type"] == "application/json"
    assert fields["http.request.body.size"] == len(app.requests[-1][2])
    assert fields["http.response.body.size"] == len(BODY)
    assert len(receiver.spans()) == 2  # No capture of exports, nor nested urllib3 work.


@pytest.mark.parametrize(
    ("options", "identity"),
    [
        ({"capture_http": False}, False),
        ({"enabled": False}, False),
        ({"capture_http_bodies": False}, True),
        ({"capture_content": False}, True),
        ({"capture_content": False, "capture_http_bodies": True}, True),
    ],
)
def test_capture_switches_preserve_http_behavior_and_metadata_only(
    receiver, app, options, identity
):
    with Hue(receiver.url, "synthetic-http-key", live_spans=False, **options) as hue:
        assert drive("requests", app.url + "/private?user_id=synthetic-query") == BODY
        assert hue.force_flush()
    spans = http_spans(receiver)
    assert len(spans) == int(identity)
    if identity:
        fields = attributes(spans[0])
        assert fields["url.full"] == app.url + "/private"
        assert "input.value" not in fields
        assert "output.value" not in fields
    assert all(b"synthetic-query" not in body for _, _, body in receiver.requests)


def test_no_http_spans_in_model_or_export_context(receiver, app):
    with Hue(receiver.url, "synthetic-http-key", live_spans=False) as hue:
        with hue.model("synthetic-model", provider="synthetic"):
            assert drive("requests", app.url + "/model") == BODY
        token = attach(export_context())
        try:
            assert drive("requests", app.url + "/suppressed") == BODY
        finally:
            detach(token)
        with hue.tracer.start_as_current_span(
            "foreign model", attributes={"gen_ai.operation.name": "chat"}
        ):
            assert drive("requests", app.url + "/foreign-model") == BODY
        assert hue.force_flush()
    assert len(app.requests) == 3
    assert http_spans(receiver) == []


@pytest.mark.parametrize("kind", tuple(kind for kind in TRANSPORTS if kind != "urllib"))
def test_non_success_status_preserves_the_response(receiver, app, kind):
    app.status = 503
    baseline = drive(kind, app.url + "/unavailable")
    with Hue(receiver.url, "synthetic-http-key", live_spans=False) as hue:
        assert drive(kind, app.url + "/unavailable") == baseline == BODY
        assert hue.force_flush()
    (span,) = http_spans(receiver)
    assert attributes(span)["http.response.status_code"] == 503


def test_original_transport_exception_is_raised_once(receiver, app, monkeypatch):
    error = requests.ConnectionError("synthetic-connection-failure")
    calls = []

    def fail(*_args, **_kwargs):
        calls.append(True)
        raise error

    with monkeypatch.context() as patch:
        patch.setattr(requests.adapters.HTTPAdapter, "send", fail)
        with Hue(receiver.url, "synthetic-http-key", live_spans=False) as hue:
            with pytest.raises(requests.ConnectionError) as caught:
                requests.get(app.url + "/failed")
            assert caught.value is error
            assert calls == [True]
            # Restore the real transport for the exporter, whose sessions use HTTPAdapter.send.
            patch.undo()
            assert hue.force_flush()
    (span,) = http_spans(receiver)
    assert span.status.code == 2
    assert app.requests == []


def test_query_and_body_credentials_are_scrubbed_but_identity_fields_remain(receiver, app):
    request_body = {
        "user_id": "synthetic-user",
        "team_id": "synthetic-team",
        "password": "synthetic-password",
        "api_key": "synthetic-secret",
    }
    with Hue(receiver.url, "synthetic-http-key", live_spans=False) as hue:
        drive(
            "requests",
            app.url + "/private?user_id=synthetic-query&api_key=synthetic-query-secret#fragment",
            body=json.dumps(request_body).encode(),
        )
        assert hue.force_flush()
    (span,) = http_spans(receiver)
    fields = attributes(span)
    assert fields["url.full"] == app.url + "/private"
    input_value = json.loads(fields["input.value"])
    assert input_value["user_id"] == "synthetic-user"
    assert input_value["team_id"] == "synthetic-team"
    payload = b"".join(body for _, _, body in receiver.requests)
    for forbidden in (b"synthetic-password", b"synthetic-secret", b"synthetic-query-secret"):
        assert forbidden not in payload
    assert b"synthetic-response-cookie" not in payload


def test_raw_url_userinfo_and_headers_are_observed_without_exporting_credentials(receiver, app):
    target = app.url.replace("http://", "http://synthetic-user:synthetic-password@")
    with Hue(receiver.url, "synthetic-http-key", live_spans=False) as hue:
        response = requests.get(
            target + "/userinfo?api_key=synthetic-url-secret#synthetic-fragment",
            headers={
                "Cookie": "synthetic-cookie=private",
                "Notion-Version": "2022-06-28",
                "Traceparent": "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
            },
        )
        assert response.content == BODY
        assert hue.force_flush()
    fields = attributes(http_spans(receiver)[0])
    assert fields["url.full"] == app.url + "/userinfo"
    assert fields["http.request.header.notion_version"] == "2022-06-28"
    assert fields["http.response.header.notion_version"] == "2022-06-28"
    actual_headers = {key.lower(): value for key, value in app.requests[0][1].items()}
    assert (
        actual_headers["traceparent"] == "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01"
    )
    assert actual_headers["cookie"] == "synthetic-cookie=private"
    assert "authorization" in actual_headers
    payload = b"".join(body for _, _, body in receiver.requests)
    for forbidden in (
        b"synthetic-password",
        b"synthetic-url-secret",
        b"synthetic-cookie",
        b"synthetic-fragment",
    ):
        assert forbidden not in payload


def test_summary_tool_records_six_http_children_with_query_and_wire_result(receiver, app):
    messages = [{"id": f"synthetic-message-{index}"} for index in range(5)]
    app.routes["/gmail/v1/users/me/messages"] = json.dumps({"messages": messages}).encode()
    for message in messages:
        app.routes["/gmail/v1/users/me/messages/" + message["id"]] = json.dumps(
            {**message, "snippet": "synthetic-body"}
        ).encode()
    with Hue(receiver.url, "synthetic-http-key", live_spans=False) as hue:
        with hue.tool("summarize_inbox") as tool:
            listing = requests.get(
                app.url + "/gmail/v1/users/me/messages?maxResults=5&q=is%3Aunread"
            ).json()
            for message in listing["messages"]:
                result = requests.get(
                    app.url + "/gmail/v1/users/me/messages/" + message["id"] + "?format=full"
                ).json()
                assert result["id"] == message["id"]
            tool.set_output(
                {"count": len(messages), "ids": [message["id"] for message in messages]}
            )
        assert hue.force_flush()
    spans = http_spans(receiver)
    assert len(spans) == len(app.requests) == 6
    assert all(span.parent_span_id.hex() == tool.span_id for span in spans)
    listing_fields = attributes(spans[0])
    assert json.loads(listing_fields["input.value"]) == {"maxResults": "5", "q": "is:unread"}
    assert json.loads(listing_fields["output.value"]) == {"messages": messages}
    for span in spans[1:]:
        fields = attributes(span)
        assert json.loads(fields["input.value"]) == {"format": "full"}
        assert json.loads(fields["output.value"])["snippet"] == "synthetic-body"
    assert all("?" not in attributes(span)["url.full"] for span in spans)
    assert len(receiver.spans()) == 7


def test_existing_redactor_receives_both_http_content_fields(receiver, app):
    calls = []

    def redact(key, value):
        calls.append((key, value))
        if key == "input.value":
            return {"user_id": "synthetic-redacted-input"}
        if key == "output.value":
            return {"body": "synthetic-redacted-output"}
        return value

    with Hue(receiver.url, "synthetic-http-key", live_spans=False, redactor=redact) as hue:
        assert drive("requests", app.url + "/redact") == BODY
        assert hue.force_flush()
    fields = attributes(http_spans(receiver)[0])
    assert json.loads(fields["input.value"]) == {"user_id": "synthetic-redacted-input"}
    assert json.loads(fields["output.value"]) == {"body": "synthetic-redacted-output"}
    assert {key for key, _ in calls} >= {"input.value", "output.value"}
    payload = b"".join(body for _, _, body in receiver.requests)
    assert b"synthetic-user" not in payload and b"synthetic-item" not in payload


def test_failing_redactor_omits_http_content_without_changing_response(receiver, app):
    def redact(key, value):
        if key in ("input.value", "output.value"):
            raise ValueError("synthetic-redactor-failure")
        return value

    with Hue(receiver.url, "synthetic-http-key", live_spans=False, redactor=redact) as hue:
        assert drive("requests", app.url + "/redact") == BODY
        assert not hue.force_flush()
        assert hue.export_status.instrumentation_failures >= 2
    fields = attributes(http_spans(receiver)[0])
    assert "input.value" not in fields and "output.value" not in fields
    payload = b"".join(body for _, _, body in receiver.requests)
    assert b"synthetic-user" not in payload and b"synthetic-item" not in payload


@pytest.mark.parametrize("kind", ("requests", "httpx"))
def test_streaming_request_body_is_never_read_ahead_or_replayed(receiver, app, kind):
    reads = []

    def chunks():
        for chunk in (b'{"user_id":', b'"synthetic-stream-user"}'):
            reads.append(chunk)
            yield chunk

    assert drive(kind, app.url + "/streamed-request", body=chunks()) == BODY
    with Hue(receiver.url, "synthetic-http-key", live_spans=False) as hue:
        assert drive(kind, app.url + "/streamed-request", body=chunks()) == BODY
        assert hue.force_flush()
    assert app.requests[0] == app.requests[1]
    assert app.requests[0][2] == b'{"user_id":"synthetic-stream-user"}'
    assert len(reads) == 4
    assert len(http_spans(receiver)) == 1


def test_oversized_request_uses_the_same_bounded_marker(receiver, app):
    request = json.dumps({"text": "x" * (1024 * 1024 + 1)}).encode()
    with Hue(receiver.url, "synthetic-http-key", live_spans=False) as hue:
        assert drive("requests", app.url + "/large-request", body=request) == BODY
        assert hue.force_flush()
    fields = attributes(http_spans(receiver)[0])
    assert fields["input.value"] == {
        "hue.truncated": True,
        "hue.truncated_bytes": len(request),
    }
    assert fields["http.request.body.size"] == len(request)
    assert "input.value" in fields["hue.truncated"]
    assert receiver.blob_requests == 0


@pytest.mark.parametrize("kind", TRANSPORTS)
def test_oversized_body_is_marked_without_losing_http_identity(receiver, app, kind):
    app.body = b"x" * (1024 * 1024 + 71)
    app.content_type = "text/plain"
    with Hue(receiver.url, "synthetic-http-key", live_spans=False) as hue:
        assert drive(kind, app.url + "/large") == app.body
        assert hue.force_flush()
    fields = attributes(http_spans(receiver)[0])
    assert fields["http.response.body.size"] == len(app.body)
    output = fields["output.value"]
    assert output == {"hue.truncated": True, "hue.truncated_bytes": len(app.body)}
    assert "output.value" in fields["hue.truncated"]
    assert receiver.blob_requests == 0


def test_redactor_cannot_turn_a_truncated_http_body_into_complete_evidence(receiver, app):
    app.body = b"x" * (1024 * 1024 + 37)
    app.content_type = "text/plain"
    callbacks = []

    def redact(key, value):
        if key == "output.value":
            callbacks.append(value)
            return {}
        return value

    with Hue(receiver.url, "synthetic-http-key", live_spans=False, redactor=redact) as hue:
        assert drive("requests", app.url + "/redacted-cut") == app.body
        assert hue.force_flush()
    fields = attributes(http_spans(receiver)[0])
    assert callbacks == [{"hue.truncated": True, "hue.truncated_bytes": len(app.body)}]
    assert fields["output.value"] == {
        "hue.truncated": True,
        "hue.truncated_bytes": len(app.body),
    }
    assert "output.value" in fields["hue.truncated"]


@pytest.mark.parametrize("kind", TRANSPORTS)
def test_binary_response_records_size_without_body(receiver, app, kind):
    app.body = bytes(range(256))
    app.content_type = "application/octet-stream"
    with Hue(receiver.url, "synthetic-http-key", live_spans=False) as hue:
        assert drive(kind, app.url + "/binary") == app.body
        assert hue.force_flush()
    fields = attributes(http_spans(receiver)[0])
    assert fields["http.response.body.size"] == 256
    assert "output.value" not in fields


@pytest.mark.parametrize("kind", ("requests", "httpx", "httpx-async", "aiohttp", "urllib3"))
def test_gzip_decode_behavior_is_unchanged(receiver, app, kind):
    baseline = drive(kind, app.url + "/gzip")
    with Hue(receiver.url, "synthetic-http-key", live_spans=False) as hue:
        assert drive(kind, app.url + "/gzip") == baseline == BODY
        assert hue.force_flush()
    fields = attributes(http_spans(receiver)[0])
    assert json.loads(fields["output.value"]) == PAYLOAD


@pytest.mark.parametrize("kind", TRANSPORTS)
def test_chunked_response_is_observed_without_changing_framing(receiver, app, kind):
    value = {"items": [{"index": index, "text": "synthetic-chunk"} for index in range(700)]}
    app.body = json.dumps(value).encode()
    baseline = drive(kind, app.url + "/chunked", stream=True)
    with Hue(receiver.url, "synthetic-http-key", live_spans=False) as hue:
        assert drive(kind, app.url + "/chunked", stream=True) == baseline == app.body
        assert hue.force_flush()
    fields = attributes(http_spans(receiver)[0])
    assert json.loads(fields["output.value"]) == value
    assert fields["http.response.body.size"] == len(app.body)


def test_complete_text_between_sixteen_kib_and_one_mib_keeps_its_content(receiver, app):
    value = {"text": "synthetic-long-body-" * 2000, "user_id": "synthetic-user"}
    app.body = json.dumps(value).encode()
    with Hue(receiver.url, "synthetic-http-key", live_spans=False) as hue:
        assert drive("requests", app.url + "/long-text") == app.body
        assert hue.force_flush()
    fields = attributes(http_spans(receiver)[0])
    assert json.loads(fields["output.value"]) == value
    assert "output.value" not in fields.get("hue.truncated", [])


@pytest.mark.parametrize("kind", ("requests", "urllib3", "httpx", "httpx-async"))
def test_raw_compressed_reads_preserve_bytes_and_record_size_only(receiver, app, kind):
    def read():
        url = app.url + "/gzip"
        if kind == "requests":
            with requests.get(url, stream=True) as response:
                return response.raw.read(decode_content=False)
        if kind == "urllib3":
            import urllib3

            with urllib3.PoolManager() as client:
                response = client.request("GET", url, preload_content=False)
                try:
                    return response.read(decode_content=False)
                finally:
                    response.close()
        import httpx

        if kind == "httpx":
            with httpx.Client(trust_env=False) as client:
                with client.stream("GET", url) as response:
                    return b"".join(response.iter_raw())

        async def run():
            async with httpx.AsyncClient(trust_env=False) as client:
                async with client.stream("GET", url) as response:
                    return b"".join([chunk async for chunk in response.aiter_raw()])

        return asyncio.run(run())

    baseline = read()
    with Hue(receiver.url, "synthetic-http-key", live_spans=False) as hue:
        assert read() == baseline
        assert hue.force_flush()
    assert gzip.decompress(baseline) == BODY
    fields = attributes(http_spans(receiver)[0])
    assert fields["http.response.body.size"] == len(baseline)
    assert "output.value" not in fields


@pytest.mark.parametrize(
    ("session_auto", "request_auto"), ((False, None), (True, False), (False, True))
)
def test_aiohttp_decompression_choice_preserves_bytes_and_honest_capture(
    receiver, app, session_auto, request_auto
):
    import aiohttp

    async def read():
        async with aiohttp.ClientSession(auto_decompress=session_auto) as client:
            options = {} if request_auto is None else {"auto_decompress": request_auto}
            async with client.get(app.url + "/gzip", **options) as response:
                return await response.read()

    baseline = asyncio.run(read())
    with Hue(receiver.url, "synthetic-http-key", live_spans=False) as hue:
        assert asyncio.run(read()) == baseline
        assert hue.force_flush()
    fields = attributes(http_spans(receiver)[0])
    assert fields["http.response.body.size"] == len(baseline)
    decoded = session_auto if request_auto is None else request_auto
    if decoded:
        assert baseline == BODY
        assert json.loads(fields["output.value"]) == PAYLOAD
    else:
        assert gzip.decompress(baseline) == BODY
        assert "output.value" not in fields


@pytest.mark.parametrize(
    "kind", ("requests", "httpx", "httpx-async", "urllib", "aiohttp", "urllib3")
)
def test_response_read_failure_preserves_the_client_exception(receiver, app, kind):
    app.incomplete = True
    with pytest.raises(Exception) as baseline:
        drive(kind, app.url + "/incomplete", stream=kind != "urllib")
    with Hue(receiver.url, "synthetic-http-key", live_spans=False) as hue:
        with pytest.raises(type(baseline.value)):
            drive(kind, app.url + "/incomplete", stream=kind != "urllib")
        assert hue.force_flush()
    (span,) = http_spans(receiver)
    fields = attributes(span)
    assert "output.value" not in fields or isinstance(fields["output.value"], dict)


def test_urllib_silent_short_read_keeps_partial_body_marked(receiver, app):
    app.incomplete = True
    baseline = drive("urllib", app.url + "/short-read", stream=True)
    with Hue(receiver.url, "synthetic-http-key", live_spans=False) as hue:
        assert drive("urllib", app.url + "/short-read", stream=True) == baseline == BODY
        assert hue.force_flush()
    fields = attributes(http_spans(receiver)[0])
    assert fields["output.value"]["hue.truncated"] is True
    assert "output.value" in fields["hue.truncated"]


@pytest.mark.parametrize("kind", ("aiohttp", "httpx"))
def test_async_response_cancellation_preserves_task_and_context(receiver, app, kind):
    app.body_gate = Event()

    async def run():
        started = asyncio.Event()

        async def read():
            if kind == "aiohttp":
                import aiohttp

                async with aiohttp.ClientSession() as client:
                    async with client.get(app.url + "/cancelled") as response:
                        started.set()
                        await response.read()
            else:
                import httpx

                async with httpx.AsyncClient(trust_env=False) as client:
                    async with client.stream("GET", app.url + "/cancelled") as response:
                        started.set()
                        await response.aread()

        task = asyncio.create_task(read())
        await asyncio.wait_for(started.wait(), timeout=2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert task.cancelled()

    with Hue(receiver.url, "synthetic-http-key", live_spans=False) as hue:
        try:
            with hue.span("cancelled scope"):
                asyncio.run(run())
        finally:
            app.body_gate.set()
        with hue.span("after cancellation") as after:
            assert drive("requests", app.url + "/after-cancel") == BODY
        assert hue.force_flush()
    spans = http_spans(receiver)
    assert len(spans) == 2
    normal = next(span for span in spans if attributes(span)["url.full"].endswith("/after-cancel"))
    assert normal.parent_span_id.hex() == after.span_id


def test_shutdown_finishes_orphan_response_without_reading_it(receiver, app):
    hue = Hue(receiver.url, "synthetic-http-key", live_spans=False)
    response = urllib.request.urlopen(app.url + "/orphan")
    try:
        assert hue.shutdown()
        (span,) = http_spans(receiver)
        assert "output.value" not in attributes(span)
        assert response.read() == BODY
    finally:
        response.close()
        hue.shutdown_safe()


@pytest.mark.parametrize("kind", TRANSPORTS)
def test_redirects_record_each_actual_wire_url_and_status(receiver, app, kind):
    app.redirects["/redirect"] = app.url + "/final?tag=redirected"

    def request():
        url = app.url + "/redirect?tag=original"
        if kind == "requests":
            return requests.get(url).content
        if kind in ("httpx", "httpx-async"):
            import httpx

            if kind == "httpx":
                with httpx.Client(follow_redirects=True, trust_env=False) as client:
                    return client.get(url).content

            async def run():
                async with httpx.AsyncClient(follow_redirects=True, trust_env=False) as client:
                    return (await client.get(url)).content

            return asyncio.run(run())
        if kind == "urllib":
            with urllib.request.urlopen(url) as response:
                return response.read()
        if kind == "aiohttp":
            import aiohttp

            async def run():
                async with aiohttp.ClientSession() as client:
                    async with client.get(url) as response:
                        return await response.read()

            return asyncio.run(run())
        if kind == "httplib2":
            import httplib2

            client = httplib2.Http(proxy_info=None)
            try:
                return client.request(url)[1]
            finally:
                client.close()
        import urllib3

        with urllib3.PoolManager() as client:
            return client.request("GET", url).data

    assert request() == BODY
    baseline = app.requests[:]
    with Hue(receiver.url, "synthetic-http-key", live_spans=False) as hue:
        assert request() == BODY
        assert hue.force_flush()
    assert app.requests[2:] == baseline
    spans = http_spans(receiver)
    assert len(spans) == 2
    recorded = sorted(
        (attributes(span)["url.full"], attributes(span)["http.response.status_code"])
        for span in spans
    )
    assert recorded == [(app.url + "/final", 200), (app.url + "/redirect", 302)]


@pytest.mark.parametrize("kind", ("requests", "httpx"))
@pytest.mark.parametrize("failure", (False, True))
def test_foreign_processor_error_preserves_http_result_or_original_error(
    receiver, app, monkeypatch, kind, failure
):
    class BrokenProcessor(SpanProcessor):
        def on_end(self, _span):
            raise RuntimeError("synthetic-processor-failure")

    provider = TracerProvider(shutdown_on_exit=False)
    provider.add_span_processor(BrokenProcessor())
    error = requests.ConnectionError("synthetic-request-failure")

    def fail(*_args, **_kwargs):
        raise error

    try:
        with monkeypatch.context() as patch:
            if failure and kind == "requests":
                patch.setattr(requests.adapters.HTTPAdapter, "send", fail)
            with Hue(
                receiver.url, "synthetic-http-key", live_spans=False, tracer_provider=provider
            ) as hue:
                if kind == "requests":
                    if failure:
                        with pytest.raises(requests.ConnectionError) as caught:
                            requests.get(app.url + "/processor")
                        assert caught.value is error
                        patch.undo()
                    else:
                        assert requests.get(app.url + "/processor").content == BODY
                else:
                    import httpx

                    error = httpx.RequestError("synthetic-request-failure")
                    transport = httpx.MockTransport(fail) if failure else None
                    with httpx.Client(transport=transport, trust_env=False) as client:
                        if failure:
                            with pytest.raises(httpx.RequestError) as caught:
                                client.get(app.url + "/processor")
                            assert caught.value is error
                        else:
                            assert client.get(app.url + "/processor").content == BODY
                assert not hue.force_flush()
                assert hue.export_status.instrumentation_failures >= 1
    finally:
        provider.shutdown()


def test_urllib_readinto_and_iteration_preserve_bytes(receiver, app):
    with Hue(receiver.url, "synthetic-http-key", live_spans=False) as hue:
        with urllib.request.urlopen(app.url + "/readinto") as response:
            chunks = []
            buffer = bytearray(7)
            while count := response.readinto(buffer):
                chunks.append(bytes(buffer[:count]))
            assert b"".join(chunks) == BODY
        with urllib.request.urlopen(app.url + "/iterate") as response:
            assert b"".join(response) == BODY
        assert hue.force_flush()
    assert len(http_spans(receiver)) == 2
    assert all(
        json.loads(attributes(span)["output.value"]) == PAYLOAD for span in http_spans(receiver)
    )


def test_unread_and_partly_read_streams_close_without_extra_reads(receiver, app):
    with Hue(receiver.url, "synthetic-http-key", live_spans=False) as hue:
        for path, count in (("/unread", 0), ("/partial", 7)):
            with urllib.request.urlopen(app.url + path) as response:
                if count:
                    assert response.read(count) == BODY[:count]
        assert hue.force_flush()
    assert len(http_spans(receiver)) == 2
    for span in http_spans(receiver):
        fields = attributes(span)
        assert "output.value" not in fields or "synthetic-item" not in fields["output.value"]


def test_existing_matching_client_span_receives_content_without_nested_span(receiver, app):
    provider = TracerProvider(shutdown_on_exit=False)
    try:
        with Hue(
            receiver.url, "synthetic-http-key", tracer_provider=provider, live_spans=False
        ) as hue:
            with provider.get_tracer("application").start_as_current_span(
                "existing HTTP",
                kind=SpanKind.CLIENT,
                attributes={"http.request.method": "POST", "url.full": app.url + "/existing"},
            ):
                assert drive("requests", app.url + "/existing") == BODY
            assert hue.force_flush()
        (span,) = http_spans(receiver)
        assert span.name == "existing HTTP"
        assert json.loads(attributes(span)["output.value"]) == PAYLOAD
        assert trace.get_tracer_provider() is not provider
        with provider.get_tracer("application").start_as_current_span("still open") as span:
            assert span.is_recording()
    finally:
        provider.shutdown()


def test_multiple_clients_shutdown_and_reinstall_preserve_capture(receiver, app):
    original_send = requests.adapters.HTTPAdapter.send
    original_finders = sys.meta_path[:]
    first = Hue(receiver.url, "synthetic-http-key", live_spans=False)
    patched_send = requests.adapters.HTTPAdapter.send
    second = Hue(receiver.url, "synthetic-http-key", live_spans=False)
    assert requests.adapters.HTTPAdapter.send is patched_send
    try:
        with first.span("first"):
            drive("requests", app.url + "/first")
        assert first.force_flush()
        first.shutdown()
        with second.span("second"):
            drive("requests", app.url + "/second")
        assert second.force_flush()
    finally:
        first.shutdown_safe()
        second.shutdown_safe()
    with Hue(receiver.url, "synthetic-http-key", live_spans=False) as third:
        drive("requests", app.url + "/third")
        assert third.force_flush()
    assert sorted(attributes(span)["url.full"] for span in http_spans(receiver)) == [
        app.url + "/first",
        app.url + "/second",
        app.url + "/third",
    ]
    assert drive("requests", app.url + "/after-shutdown") == BODY
    assert requests.adapters.HTTPAdapter.send is original_send
    assert sys.meta_path == original_finders


def test_shutdown_preserves_later_application_wrapper(receiver, app):
    original = requests.adapters.HTTPAdapter.send
    hue = Hue(receiver.url, "synthetic-http-key", live_spans=False)
    wrapped = requests.adapters.HTTPAdapter.send
    calls = []

    def application_send(*args, **kwargs):
        calls.append(True)
        return wrapped(*args, **kwargs)

    requests.adapters.HTTPAdapter.send = application_send
    try:
        assert hue.shutdown()
        assert requests.adapters.HTTPAdapter.send is application_send
        assert drive("requests", app.url + "/after-shutdown") == BODY
        assert calls == [True]
    finally:
        hue.shutdown_safe()
        requests.adapters.HTTPAdapter.send = original


def test_slack_sync_and_async_clients_record_real_transports(receiver, app, monkeypatch):
    from slack_sdk import WebClient
    from slack_sdk.web.async_client import AsyncWebClient

    for key in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY"):
        monkeypatch.delenv(key, raising=False)
    with Hue(receiver.url, "synthetic-http-key", live_spans=False) as hue:
        client = WebClient(token="synthetic-slack-token", base_url=app.url + "/slack/")
        assert client.chat_postMessage(channel="synthetic-channel", text="hello")["ok"]

        async def run():
            client = AsyncWebClient(token="synthetic-slack-token", base_url=app.url + "/slack/")
            return await client.chat_postMessage(channel="synthetic-channel", text="hello")

        assert asyncio.run(run())["ok"]
        assert hue.force_flush()
    assert len(http_spans(receiver)) == 2
    for span in http_spans(receiver):
        fields = attributes(span)
        assert json.loads(fields["input.value"])["channel"] == "synthetic-channel"
        assert json.loads(fields["output.value"]) == PAYLOAD
    assert all(b"synthetic-slack-token" not in body for _, _, body in receiver.requests)


def test_aiohttp_custom_serializer_runs_once_and_captures_actual_relative_request(receiver, app):
    import aiohttp

    serialized = []

    def serialize(value):
        serialized.append(value.copy())
        return json.dumps({**value, "serialization": len(serialized)})

    async def run():
        async with aiohttp.ClientSession(base_url=app.url, json_serialize=serialize) as client:
            value = {"user_id": "synthetic-original"}
            value["user_id"] = "synthetic-changed-before-send"
            async with client.post("/relative?tag=synthetic-tag", json=value) as response:
                assert await response.read() == BODY

    with Hue(receiver.url, "synthetic-http-key", live_spans=False) as hue:
        asyncio.run(run())
        assert hue.force_flush()
    assert serialized == [{"user_id": "synthetic-changed-before-send"}]
    (path, _, body) = app.requests[0]
    assert path == "/relative?tag=synthetic-tag"
    sent = json.loads(body)
    assert sent == {"user_id": "synthetic-changed-before-send", "serialization": 1}
    fields = attributes(http_spans(receiver)[0])
    assert fields["url.full"] == app.url + "/relative"
    assert json.loads(fields["input.value"]) == {"tag": "synthetic-tag", **sent}


def test_google_api_client_httplib2_and_authorized_session(receiver, app):
    import httplib2
    from google.auth.credentials import AnonymousCredentials
    from google.auth.transport.requests import AuthorizedSession
    from googleapiclient.http import HttpRequest

    class AuthorizedHttp:
        def __init__(self):
            self.session = AuthorizedSession(AnonymousCredentials())

        def request(self, uri, method="GET", body=None, headers=None, **_kwargs):
            result = self.session.request(method, uri, data=body, headers=headers)
            response = httplib2.Response({"status": str(result.status_code), **result.headers})
            return response, result.content

    def postprocess(_response, body):
        return json.loads(body)

    stock = httplib2.Http(proxy_info=None)
    authorized = AuthorizedHttp()
    try:
        with Hue(receiver.url, "synthetic-http-key", live_spans=False) as hue:
            for transport in (stock, authorized):
                request = HttpRequest(
                    transport,
                    postprocess,
                    app.url + "/gmail/v1/users/me/messages?maxResults=5",
                    method="GET",
                )
                assert request.execute(num_retries=0) == PAYLOAD
            assert hue.force_flush()
        assert len(http_spans(receiver)) == 2
        assert all(
            json.loads(attributes(span)["output.value"]) == PAYLOAD for span in http_spans(receiver)
        )
    finally:
        stock.close()
        authorized.session.close()


def test_pipedream_uses_real_httpx_transport(receiver, app):
    from pipedream import Pipedream

    with Hue(receiver.url, "synthetic-http-key", live_spans=False) as hue:
        client = Pipedream(base_url=app.url, access_token="synthetic-pipedream-token")
        result = client.actions.run(id="synthetic-action", external_user_id="synthetic-user")
        assert result is not None
        assert hue.force_flush()
    (span,) = http_spans(receiver)
    fields = attributes(span)
    assert fields["http.request.method"] == "POST"
    assert json.loads(fields["input.value"])["external_user_id"] == "synthetic-user"
    assert json.loads(fields["output.value"]) == PAYLOAD


def test_import_hook_instruments_clients_first_imported_after_hue(receiver, app):
    script = """
import json, sys
from hue_sdk import Hue
assert 'aiohttp' not in sys.modules and 'httpx' not in sys.modules
with Hue(sys.argv[1], 'synthetic-http-key', live_spans=False) as hue:
    import asyncio, aiohttp, httpx
    with httpx.Client(trust_env=False) as client:
        assert client.get(sys.argv[2] + '/late-httpx').json()['ok']
    async def run():
        async with aiohttp.ClientSession() as client:
            async with client.get(sys.argv[2] + '/late-aiohttp') as response:
                assert (await response.json())['ok']
    asyncio.run(run())
    assert hue.force_flush()
"""
    subprocess.run([sys.executable, "-c", script, receiver.url, app.url], check=True, timeout=20)
    assert len(http_spans(receiver)) == 2
