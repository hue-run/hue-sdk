from __future__ import annotations

import json
from contextlib import nullcontext
from importlib import import_module

import pytest
from opentelemetry import trace
from opentelemetry.context import Context
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import NonRecordingSpan, SpanKind
from test_http_capture import BODY, attributes, drive, http_spans
from test_http_capture import app as app

from hue_sdk import Hue


class ApplicationSpanProxy(NonRecordingSpan):
    def __init__(self, span):
        super().__init__(span.get_span_context())
        self._wrapped = span
        self.kind = span.kind

    @property
    def attributes(self):
        return self._wrapped.attributes

    def is_recording(self):
        return self._wrapped.is_recording()

    def set_attribute(self, key, value):
        self._wrapped.set_attribute(key, value)


@pytest.mark.parametrize("transport", ("requests", "httpx", "httpx2"))
@pytest.mark.parametrize(
    "mode",
    (
        "owned-normal",
        "owned-foreign-tool",
        "owned-foreign-http",
        "owned-same-trace-child",
        "borrowed-application-tool",
        "borrowed-matching-http",
    ),
)
def test_http_parent_preserves_owned_helpers_and_borrowed_application_context(
    receiver, app, transport, mode
):
    application_provider = TracerProvider(shutdown_on_exit=False)
    foreign_exporter = InMemorySpanExporter()
    application_provider.add_span_processor(SimpleSpanProcessor(foreign_exporter))
    borrowed = mode.startswith("borrowed-")
    client_options = {"tracer_provider": application_provider} if borrowed else {}
    url = app.url + "/parent/" + transport
    matching_http = mode.endswith("http")
    try:
        with Hue(
            receiver.url, "synthetic-http-parent-key", live_spans=False, **client_options
        ) as hue:
            with hue.span("request", parent_context=Context()) as root:
                with hue.tool("app-call") as tool:
                    local = mode == "owned-same-trace-child"
                    tracer = hue.tracer if local else application_provider.get_tracer("application")
                    scope = (
                        nullcontext(tool.otel_span)
                        if mode == "owned-normal"
                        else tracer.start_as_current_span(
                            "application-call",
                            context=None if local else Context(),
                            kind=SpanKind.CLIENT if matching_http else SpanKind.INTERNAL,
                            attributes=(
                                {"http.request.method": "POST", "url.full": url}
                                if matching_http
                                else {}
                            ),
                        )
                    )
                    with scope as active:
                        selected = (
                            ApplicationSpanProxy(active) if mode == "owned-foreign-http" else active
                        )
                        with trace.use_span(selected, end_on_exit=False):
                            previous = trace.get_current_span()
                            assert drive(transport, url) == BODY
                            assert trace.get_current_span() is previous
                        active_context = active.get_span_context()
                root_trace = bytes.fromhex(root.trace_id)
                tool_id = bytes.fromhex(tool.span_id)
            assert hue.force_flush()
        (wire,) = http_spans(receiver)
        fields = attributes(wire)
        assert fields["url.full"] == url
        assert json.loads(fields["input.value"]) == {"user_id": "synthetic-user", "count": 2}
        assert json.loads(fields["output.value"]) == json.loads(BODY)
        if mode in {"owned-normal", "owned-foreign-tool", "owned-foreign-http"}:
            assert wire.trace_id == root_trace
            assert wire.parent_span_id == tool_id
        elif mode == "borrowed-matching-http":
            assert wire.trace_id == active_context.trace_id.to_bytes(16, "big")
            assert wire.span_id == active_context.span_id.to_bytes(8, "big")
        else:
            assert wire.trace_id == active_context.trace_id.to_bytes(16, "big")
            assert wire.parent_span_id == active_context.span_id.to_bytes(8, "big")
        if mode.startswith("owned-foreign-"):
            foreign_id = active_context.span_id.to_bytes(8, "big")
            assert foreign_id not in {span.span_id for span in receiver.spans()}
            assert wire.trace_id != active_context.trace_id.to_bytes(16, "big")
            (foreign_span,) = foreign_exporter.get_finished_spans()
            assert "input.value" not in foreign_span.attributes
            assert "output.value" not in foreign_span.attributes
        assert len(app.requests) == 1
        assert app.requests[0][2] == b'{"user_id":"synthetic-user","count":2}'
        assert "traceparent" not in {key.lower() for key in app.requests[0][1]}
    finally:
        application_provider.shutdown()


@pytest.mark.parametrize("module_name", ("httpx", "httpx2"))
def test_owned_http_preserves_foreign_context_inside_the_real_transport(receiver, app, module_name):
    module = import_module(module_name)
    observed = []

    class ObservedTransport(module.HTTPTransport):
        def handle_request(self, request):
            observed.append(trace.get_current_span())
            return super().handle_request(request)

    application_provider = TracerProvider(shutdown_on_exit=False)
    foreign_exporter = InMemorySpanExporter()
    application_provider.add_span_processor(SimpleSpanProcessor(foreign_exporter))
    url = app.url + "/transport-context"
    try:
        with Hue(receiver.url, "synthetic-http-parent-key", live_spans=False) as hue:
            with hue.span("request", parent_context=Context()) as root:
                with hue.tool("app-call") as tool:
                    with application_provider.get_tracer("application").start_as_current_span(
                        "application-http",
                        context=Context(),
                        kind=SpanKind.CLIENT,
                        attributes={"http.request.method": "POST", "url.full": url},
                    ) as active:
                        selected = ApplicationSpanProxy(active)
                        with trace.use_span(selected, end_on_exit=False):
                            with module.Client(transport=ObservedTransport()) as client:
                                response = client.post(url, json={"id": "synthetic-input"})
                                assert response.content == BODY
                        assert observed == [selected]
            assert hue.force_flush()
        (wire,) = http_spans(receiver)
        fields = attributes(wire)
        assert wire.trace_id == bytes.fromhex(root.trace_id)
        assert wire.parent_span_id == bytes.fromhex(tool.span_id)
        assert json.loads(fields["input.value"]) == {"id": "synthetic-input"}
        assert json.loads(fields["output.value"]) == json.loads(BODY)
        (foreign_span,) = foreign_exporter.get_finished_spans()
        assert "input.value" not in foreign_span.attributes
        assert "output.value" not in foreign_span.attributes
        assert len(app.requests) == 1
    finally:
        application_provider.shutdown()
