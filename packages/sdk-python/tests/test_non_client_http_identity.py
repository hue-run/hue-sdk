"""URL credentials on spans Hue did not create must not leave the process.

A borrowed tracer provider exports every span that ends on it, including HTTP
server spans from the application's instrumentor. Those spans carry the request
URL. The export copy has to apply the same URL sanitizer client spans already
get: drop userinfo, query strings and fragments, mask credential path segments,
and omit the URL when sanitizing fails.
"""

from __future__ import annotations

import time

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import SpanKind
from test_http_capture import attributes

from hue_sdk import Hue

QUERY = "synthetic_oauth_code"
USERINFO = "synthetic_userinfo"
PATH_SECRET = "synthetic_path_secret"
RAW = (
    f"https://synthetic-user:{USERINFO}@example.test"
    f"/token/{PATH_SECRET}/callback?code={QUERY}#synthetic-fragment"
)
SAFE = "https://example.test/token/[redacted]/callback"
SAFE_PATH = "/token/[redacted]/callback"
NON_CLIENT = (
    SpanKind.SERVER,
    SpanKind.INTERNAL,
    SpanKind.PRODUCER,
    SpanKind.CONSUMER,
)


def _fields(span):
    return attributes(span)


def _exported(receiver) -> bytes:
    return b"".join(body for path, _, body in receiver.requests if path.endswith("/traces"))


def _secrets_absent(payload: bytes) -> None:
    for secret in (QUERY, USERINFO, PATH_SECRET, "synthetic-fragment"):
        assert secret.encode() not in payload


@pytest.mark.parametrize("kind", NON_CLIENT)
@pytest.mark.parametrize("capture_content", (True, False))
def test_borrowed_provider_strips_non_client_url_credentials(receiver, kind, capture_content):
    provider = TracerProvider(shutdown_on_exit=False)
    vendor = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(vendor))
    path = f"/token/{PATH_SECRET}/callback"
    aliases = {
        "url.full": RAW,
        "http.url": RAW,
        "http.target": f"{path}?code={QUERY}",
        "url.path": path,
        "url.query": f"code={QUERY}",
    }

    def redact(key, value):
        if key in {"url.full", "http.url"}:
            return value.replace("/callback", "/done")
        return value

    try:
        with Hue(
            receiver.url,
            "synthetic-http-key",
            tracer_provider=provider,
            capture_http=False,
            capture_content=capture_content,
            live_spans=False,
            redactor=redact,
        ) as hue:
            with provider.get_tracer("application-http").start_as_current_span(
                "GET " + RAW,
                kind=kind,
                attributes={"http.request.method": "GET", **aliases},
            ):
                pass
            assert hue.force_flush()
        (span,) = receiver.spans()
        fields = _fields(span)
        assert fields["url.full"] == fields["http.url"] == SAFE.replace("/callback", "/done")
        assert (
            fields["http.target"] == fields["url.path"] == SAFE_PATH.replace("/callback", "/done")
        )
        assert "url.query" not in fields
        assert span.name == "GET"
        _secrets_absent(_exported(receiver))
        (original,) = vendor.get_finished_spans()
        assert original.name == "GET " + RAW
        assert original.attributes["url.full"] == RAW
        assert original.attributes["url.query"] == f"code={QUERY}"
    finally:
        provider.shutdown()


@pytest.mark.parametrize(
    "attributes_in",
    (
        {
            "http.method": "GET",
            "http.url": RAW,
            "http.target": f"/token/{PATH_SECRET}/callback",
        },
        {
            "http.request.method": "GET",
            "url.path": f"/token/{PATH_SECRET}/callback",
            "url.query": f"code={QUERY}",
        },
        {
            "http.method": "GET",
            "http.target": f"/token/{PATH_SECRET}/callback?code={QUERY}",
        },
    ),
)
def test_server_spans_lose_each_url_alias_instrumentation_sets(receiver, attributes_in):
    """Default ASGI stores the query on http.url; stable semconv stores url.query;
    WSGI stores the request target, query included, on http.target."""
    provider = TracerProvider(shutdown_on_exit=False)
    try:
        with Hue(
            receiver.url,
            "synthetic-http-key",
            tracer_provider=provider,
            capture_http=False,
            live_spans=False,
        ) as hue:
            with provider.get_tracer("application-http").start_as_current_span(
                "GET",
                kind=SpanKind.SERVER,
                attributes=attributes_in,
            ):
                pass
            assert hue.force_flush()
        (span,) = receiver.spans()
        fields = _fields(span)
        assert "url.query" not in fields
        if "http.url" in attributes_in or "url.full" in attributes_in:
            assert fields.get("http.url", fields.get("url.full")) == SAFE
        if "http.target" in attributes_in:
            assert fields["http.target"] == SAFE_PATH
        if "url.path" in attributes_in:
            assert fields["url.path"] == SAFE_PATH
        assert span.name == "GET"
        _secrets_absent(_exported(receiver))
    finally:
        provider.shutdown()


def test_unsanitizable_server_url_is_omitted(receiver):
    provider = TracerProvider(shutdown_on_exit=False)
    raw = f"https://synthetic-user:{USERINFO}@/callback?code={QUERY}"
    try:
        with Hue(
            receiver.url,
            "synthetic-http-key",
            tracer_provider=provider,
            capture_http=False,
            live_spans=False,
        ) as hue:
            with provider.get_tracer("application-http").start_as_current_span(
                "GET",
                kind=SpanKind.SERVER,
                attributes={"http.request.method": "GET", "url.full": raw, "http.url": raw},
            ):
                pass
            assert hue.force_flush()
        (span,) = receiver.spans()
        fields = _fields(span)
        assert "url.full" not in fields
        assert "http.url" not in fields
        assert "url.query" not in fields
        assert span.name == "GET"
        assert QUERY.encode() not in _exported(receiver)
    finally:
        provider.shutdown()


def test_server_span_name_does_not_keep_the_request_url(receiver):
    provider = TracerProvider(shutdown_on_exit=False)
    try:
        with Hue(
            receiver.url,
            "synthetic-http-key",
            tracer_provider=provider,
            capture_http=False,
            live_spans=False,
        ) as hue:
            with provider.get_tracer("application-http").start_as_current_span(
                RAW, kind=SpanKind.SERVER
            ):
                pass
            assert hue.force_flush()
        (span,) = receiver.spans()
        assert span.name == "HTTP"
        _secrets_absent(_exported(receiver))
    finally:
        provider.shutdown()


def test_open_server_span_placeholder_strips_the_request_url(receiver):
    provider = TracerProvider(shutdown_on_exit=False)
    span = None
    try:
        with Hue(
            receiver.url,
            "synthetic-http-key",
            tracer_provider=provider,
            capture_http=False,
            live_spans=True,
        ) as hue:
            span = provider.get_tracer("hue-run").start_span(
                "GET " + RAW,
                kind=SpanKind.SERVER,
                attributes={
                    "http.request.method": "GET",
                    "url.full": RAW,
                    "url.query": f"code={QUERY}",
                },
            )
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline and not receiver.spans():
                time.sleep(0.05)
            assert hue.force_flush()
        pending = [item for item in receiver.spans() if item.end_time_unix_nano == 0]
        assert pending, "an open server span on Hue's tracer is announced"
        fields = _fields(pending[0])
        assert fields["url.full"] == SAFE
        assert "url.query" not in fields
        assert pending[0].name == "GET"
        _secrets_absent(_exported(receiver))
    finally:
        if span is not None:
            span.end()
        provider.shutdown()
