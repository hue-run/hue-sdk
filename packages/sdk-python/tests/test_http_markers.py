from __future__ import annotations

import json

import pytest
from opentelemetry.exporter.otlp.proto.common.trace_encoder import encode_spans
from opentelemetry.sdk.trace import SpanLimits, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import SpanKind

from hue_sdk import Hue
from hue_sdk.snapshots import snapshot_pending_span, snapshot_span

CUT = {"hue.truncated": True, "hue.truncated_bytes": 1024 * 1024 + 1}
CUT_TEXT = json.dumps(CUT, separators=(",", ":"))
HTTP_ATTRIBUTES = {
    "http.request.method": "GET",
    "url.full": "https://example.com/items",
    "input.value": CUT_TEXT,
    "output.value": CUT_TEXT,
    "hue.truncated": ["input.value", "output.value"],
}


def assert_cut(value, size=CUT["hue.truncated_bytes"]):
    assert value.WhichOneof("value") == "kvlist_value"
    fields = {item.key: item.value for item in value.kvlist_value.values}
    assert fields["hue.truncated"].bool_value is True
    assert fields["hue.truncated_bytes"].int_value == size


@pytest.mark.parametrize("scope", ("hue-run", "third-party-http"))
@pytest.mark.parametrize("capture_content", (True, False))
@pytest.mark.parametrize("max_attribute_length", (None, 40))
def test_http_cut_exports_as_a_structured_placeholder_without_mutating_other_exporters(
    receiver, scope, capture_content, max_attribute_length
):
    provider = TracerProvider(
        shutdown_on_exit=False, span_limits=SpanLimits(max_attribute_length=max_attribute_length)
    )
    other = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(other))
    try:
        with Hue(
            receiver.url,
            "synthetic-http-marker-key",
            tracer_provider=provider,
            capture_content=capture_content,
            live_spans=False,
        ) as hue:
            with provider.get_tracer(scope).start_as_current_span(
                "GET",
                kind=SpanKind.CLIENT,
                attributes={
                    **HTTP_ATTRIBUTES,
                    "http.request.body.size": CUT["hue.truncated_bytes"],
                    "http.response.body.size": CUT["hue.truncated_bytes"],
                },
            ):
                pass
            assert hue.force_flush()
        (wire_span,) = receiver.spans()
        fields = {item.key: item.value for item in wire_span.attributes}
        for key in ("input.value", "output.value"):
            if capture_content:
                assert_cut(fields[key])
            else:
                assert key not in fields
        assert receiver.blob_requests == 0
        (original,) = other.get_finished_spans()
        expected = CUT_TEXT if max_attribute_length is None else CUT_TEXT[:max_attribute_length]
        assert original.attributes["input.value"] == expected
        assert original.attributes["output.value"] == expected
    finally:
        provider.shutdown()


@pytest.mark.parametrize("scope", ("hue-run", "third-party-http"))
def test_live_http_cut_uses_the_same_structured_placeholder(scope):
    provider = TracerProvider(shutdown_on_exit=False)
    span = provider.get_tracer(scope).start_span(
        "GET", kind=SpanKind.CLIENT, attributes=HTTP_ATTRIBUTES
    )
    try:
        pending = snapshot_pending_span(span)
        wire = encode_spans((pending,)).resource_spans[0].scope_spans[0].spans[0]
        fields = {item.key: item.value for item in wire.attributes}
        assert_cut(fields["input.value"])
        assert_cut(fields["output.value"])
    finally:
        span.end()
        provider.shutdown()


@pytest.mark.parametrize(
    "kind, changes",
    (
        (SpanKind.INTERNAL, {}),
        (SpanKind.CLIENT, {"http.request.method": None}),
        (SpanKind.CLIENT, {"hue.truncated": []}),
    ),
)
def test_only_explicit_http_cuts_become_placeholders(kind, changes):
    provider = TracerProvider(shutdown_on_exit=False)
    values = {
        key: value for key, value in {**HTTP_ATTRIBUTES, **changes}.items() if value is not None
    }
    span = provider.get_tracer("third-party-http").start_span("GET", kind=kind, attributes=values)
    span.end()
    try:
        wire = encode_spans((snapshot_span(span),)).resource_spans[0].scope_spans[0].spans[0]
        fields = {item.key: item.value for item in wire.attributes}
        assert fields["output.value"].WhichOneof("value") == "string_value"
        assert fields["output.value"].string_value == values["output.value"]
    finally:
        provider.shutdown()


@pytest.mark.parametrize(
    "value, body_size, expected_size",
    (
        ('{"partial":"é', None, 14),
        ('{"partial":', 487, 487),
        ('{"hue.truncated":true,"other":1}', None, 32),
        ('{"hue.truncated":true,"hue.truncated_bytes":true}', None, 49),
        ('{"hue.truncated":true,"hue.truncated_bytes":-1}', None, 47),
    ),
)
def test_explicit_cut_prefixes_cannot_export_as_complete_bodies(value, body_size, expected_size):
    provider = TracerProvider(shutdown_on_exit=False)
    values = {**HTTP_ATTRIBUTES, "output.value": value}
    if body_size is not None:
        values["http.response.body.size"] = body_size
    span = provider.get_tracer("third-party-http").start_span(
        "GET", kind=SpanKind.CLIENT, attributes=values
    )
    span.end()
    try:
        wire = encode_spans((snapshot_span(span),)).resource_spans[0].scope_spans[0].spans[0]
        fields = {item.key: item.value for item in wire.attributes}
        assert_cut(fields["output.value"], expected_size)
    finally:
        provider.shutdown()
