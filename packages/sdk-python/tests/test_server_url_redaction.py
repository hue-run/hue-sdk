"""Incoming request URLs on non-client spans must not export query secrets."""

from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from urllib.parse import parse_qsl, urlencode, urlsplit

import pytest
import requests
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.trace import SpanKind
from test_http_identity import exported_bytes

from hue_sdk import Hue

# Query keys @opentelemetry/instrumentation-http@0.223.0 replaces before recording url.query
# (build/src/internal-types.js DEFAULT_QUERY_STRINGS_TO_REDACT). "code" is not one of them.
INSTRUMENTATION_REDACTED_QUERY_KEYS = {
    "sig",
    "Signature",
    "AWSAccessKeyId",
    "X-Goog-Signature",
    "X-Amz-Signature",
    "X-Amz-Credential",
    "X-Amz-Security-Token",
}

QUERY_SECRET = "synthetic-oauth-code"
URL_KEYS = ("url.full", "http.url", "http.target", "url.path", "url.query", "resource.name")
ABSOLUTE_KEYS = ("url.full", "http.url", "resource.name")


def _redact_query(search: str) -> str:
    pairs = []
    for key, value in parse_qsl(search, keep_blank_values=True):
        pairs.append((key, "REDACTED" if key in INSTRUMENTATION_REDACTED_QUERY_KEYS else value))
    return urlencode(pairs)


def _incoming_attributes(path: str, host: str) -> dict[str, str]:
    """URL attributes an incoming server span carries into Hue.

    instrumentation-http 0.223.0 getIncomingRequestAttributes sets url.path and url.query.
    getAbsoluteUrl builds the absolute URL that version stores as url.full on client spans.
    http.url, http.target and an HTTP resource.name are the other aliases left in place for
    every other span kind.
    """
    parsed = urlsplit(path)
    query = _redact_query(parsed.query) if parsed.query else ""
    target = parsed.path + (f"?{query}" if query else "")
    full = f"http://{host}{target}"
    attributes = {
        "http.request.method": "GET",
        "url.scheme": "http",
        "url.path": parsed.path or "/",
        "url.full": full,
        "http.url": full,
        "http.target": target,
        "resource.name": full,
    }
    if query:
        attributes["url.query"] = query
    return attributes


def _fields(span) -> dict[str, str]:
    result = {}
    for item in span.attributes:
        if item.value.HasField("string_value"):
            result[item.key] = item.value.string_value
    return result


@pytest.mark.parametrize(
    "kind",
    (SpanKind.SERVER, SpanKind.INTERNAL, SpanKind.PRODUCER, SpanKind.CONSUMER, SpanKind.CLIENT),
)
@pytest.mark.parametrize("capture_content", (True, False))
@pytest.mark.parametrize("passthrough_redactor", (False, True))
def test_incoming_urls_drop_query_secrets_before_export(
    receiver, kind, capture_content, passthrough_redactor
):
    provider = TracerProvider(shutdown_on_exit=False)
    tracer = provider.get_tracer("incoming-http")
    server: ThreadingHTTPServer | None = None
    thread: Thread | None = None

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            host = self.headers.get("Host", "127.0.0.1")
            attributes = _incoming_attributes(self.path, host)
            tracer.start_span("GET", kind=kind, attributes=attributes).end()
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")

        def log_message(self, format: str, *args: object) -> None:
            return

    unparsable = f"http://[?code={QUERY_SECRET}"
    try:
        with Hue(
            receiver.url,
            "synthetic-http-key",
            tracer_provider=provider,
            capture_http=False,
            capture_content=capture_content,
            live_spans=False,
            redactor=(lambda _key, value: value) if passthrough_redactor else None,
        ) as hue:
            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            thread = Thread(
                target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True
            )
            thread.start()
            host, port = server.server_address
            response = requests.get(
                f"http://{host}:{port}/callback?code={QUERY_SECRET}&sig=synthetic-listed-signature&page=2",
                timeout=5,
            )
            assert response.status_code == 200
            tracer.start_span(
                "unparsable",
                kind=kind,
                attributes={
                    "http.request.method": "GET",
                    "url.full": unparsable,
                    "http.url": unparsable,
                    "http.target": f"/?code={QUERY_SECRET}",
                    "url.path": f"/?code={QUERY_SECRET}",
                    "url.query": f"code={QUERY_SECRET}",
                    "resource.name": unparsable,
                },
            ).end()
            assert hue.force_flush()
        payload = exported_bytes(receiver)
        assert QUERY_SECRET.encode() not in payload
        spans = [span for span in receiver.spans() if span.name in {"GET", "unparsable"}]
        assert spans
        for span in spans:
            fields = _fields(span)
            for key in URL_KEYS:
                if key in fields:
                    assert QUERY_SECRET not in fields[key]
            if span.name == "unparsable":
                for key in ABSOLUTE_KEYS:
                    assert key not in fields
    finally:
        if server is not None:
            server.shutdown()
            server.server_close()
        if thread is not None:
            thread.join(timeout=5)
        provider.shutdown()
