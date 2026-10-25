from __future__ import annotations

import gc
import json
import weakref
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

import pytest
import requests
from opentelemetry.exporter.otlp.proto.common.trace_encoder import encode_spans
from opentelemetry.sdk.trace import SpanLimits, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import SpanKind

from hue_sdk import Hue
from hue_sdk._http_bounds import SpanBounds, cuts_for, limits_for, mark_cut, remember_span
from hue_sdk.snapshots import snapshot_pending_span, snapshot_span
from hue_sdk.transport import PENDING_PARENT_KEY, PENDING_SPAN_TYPE_KEY

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


@pytest.fixture
def http_echo():
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers["Content-Length"]))
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(5)


@pytest.mark.parametrize("max_attribute_length", (16, 4, 40))
@pytest.mark.parametrize("max_attributes", (8, 0))
@pytest.mark.parametrize("large", (False, True))
def test_borrowed_sdk_cuts_remain_structured_without_restoring_dropped_attributes(
    receiver, http_echo, max_attribute_length, max_attributes, large
):
    provider = TracerProvider(
        shutdown_on_exit=False,
        span_limits=SpanLimits(
            max_attribute_length=max_attribute_length, max_attributes=max_attributes
        ),
    )
    other = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(other))
    body = (
        b'{"text":"' + b"x" * (1024 * 1024 + 1) + b'"}'
        if large
        else b'{"id":"synthetic-item","text":"ordinary-json-content"}'
    )
    try:
        with Hue(
            receiver.url,
            "synthetic-short-cap-key",
            tracer_provider=provider,
            live_spans=False,
        ) as hue:
            response = requests.post(
                http_echo + "/echo", data=body, headers={"Content-Type": "application/json"}
            )
            assert response.content == body
            assert hue.force_flush()
        (original,) = other.get_finished_spans()
        accepted = original.attributes
        (wire,) = receiver.spans()
        fields = {item.key: item.value for item in wire.attributes}
        assert len(fields) <= len(accepted) <= max_attributes
        assert set(fields).issubset(accepted)
        if max_attributes == 0:
            assert not fields
            return
        for key in ("input.value", "output.value"):
            assert key in accepted
            assert len(accepted[key]) <= max_attribute_length
            assert_cut(fields[key], len(body))
        if "hue.truncated" in accepted:
            keys = [item.string_value for item in fields["hue.truncated"].array_value.values]
            assert keys == ["input.value", "output.value"]
        else:
            assert "hue.truncated" not in fields
        assert receiver.blob_requests == 0
    finally:
        provider.shutdown()


def test_sdk_cut_facts_follow_the_source_span_lifetime_and_effective_policy():
    provider = TracerProvider(
        shutdown_on_exit=False,
        span_limits=SpanLimits(
            max_attributes=8, max_attribute_length=16, max_span_attribute_length=4
        ),
    )
    other = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(other))
    try:
        source = provider.get_tracer("third-party-http").start_span("GET", kind=SpanKind.CLIENT)
        reference = weakref.ref(source)
        remember_span(source)
        mark_cut(source, "input.value", 53)
        assert limits_for(source) == SpanBounds(value_length=4, attribute_count=8)
        source.end()
        (view,) = other.get_finished_spans()
        assert cuts_for(view) == {"input.value": 53}
        assert limits_for(view) == SpanBounds(value_length=4, attribute_count=8)
        del source
        gc.collect()
        assert reference() is None
        assert not cuts_for(view)
        assert limits_for(view) == SpanBounds(value_length=4, attribute_count=8)
    finally:
        provider.shutdown()


@pytest.mark.parametrize("max_attribute_length", (16, 4))
@pytest.mark.parametrize("max_attributes", (8, 0))
def test_live_and_finished_sdk_cuts_keep_structured_facts_and_dropped_keys(
    max_attribute_length, max_attributes
):
    provider = TracerProvider(
        shutdown_on_exit=False,
        span_limits=SpanLimits(
            max_attribute_length=max_attribute_length, max_attributes=max_attributes
        ),
    )
    source = provider.get_tracer("third-party-http").start_span(
        "GET",
        kind=SpanKind.CLIENT,
        attributes={
            **HTTP_ATTRIBUTES,
            "http.request.body.size": CUT["hue.truncated_bytes"],
            "http.response.body.size": CUT["hue.truncated_bytes"],
            "output.mime_type": "application/json",
        },
    )
    try:
        accepted = dict(source.attributes)
        remember_span(source)
        for key in ("input.value", "output.value"):
            mark_cut(source, key, CUT["hue.truncated_bytes"])
        pending = snapshot_pending_span(source)
        source.end()
        finished = snapshot_span(source)
        for copy in (pending, finished):
            wire = encode_spans((copy,)).resource_spans[0].scope_spans[0].spans[0]
            fields = {item.key: item.value for item in wire.attributes}
            copied_keys = set(fields) - {PENDING_SPAN_TYPE_KEY, PENDING_PARENT_KEY}
            assert copied_keys.issubset(accepted)
            assert len(copied_keys) <= max_attributes
            if max_attributes == 0:
                assert not copied_keys
                continue
            for key in ("input.value", "output.value"):
                assert_cut(fields[key])
            assert [item.string_value for item in fields["hue.truncated"].array_value.values] == [
                "input.value",
                "output.value",
            ]
        assert dict(source.attributes) == accepted
    finally:
        if source.is_recording():
            source.end()
        provider.shutdown()
