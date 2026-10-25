from __future__ import annotations

import importlib
import json
import time

import pytest
import requests
from opentelemetry.proto.collector.logs.v1.logs_service_pb2 import ExportLogsServiceRequest
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import SpanLimits, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import Link, SpanContext, SpanKind, TraceFlags
from test_http_capture import BODY, attributes, http_spans
from test_http_capture import app as app

from hue_sdk import Hue

POLICIES = ({}, {"capture_content": False}, {"capture_http_bodies": False})


@pytest.mark.parametrize(
    "value_length,count,mode",
    (
        (16, 0, "missing"),
        (4, 0, "missing"),
        (16, 8, "missing"),
        (4, 8, "missing"),
        (64, 8, "evicted"),
        (64, 8, "ordinary"),
        (64, 8, "invalid"),
        (16, 0, "ordinary"),
    ),
)
def test_provider_dropped_method_keeps_client_names_and_uri_copies_safe(
    receiver, app, value_length, count, mode
):
    limits = SpanLimits(max_attribute_length=value_length, max_attributes=count)
    provider = TracerProvider(shutdown_on_exit=False, span_limits=limits)
    vendor = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(vendor))
    secret = "synthetic_name_secret"
    raw = app.url + "/token/" + secret + "/items"
    name = "ordinary-client-operation" if mode == "ordinary" else "GET " + raw
    values = {"url.full": raw}
    if mode == "evicted":
        values = {"http.request.method": "GET"}
        values.update({f"filler.{index}": "value" for index in range(count)})
        values["url.full"] = raw
    elif mode == "invalid":
        values["http.request.method"] = "/bad"
    try:
        with Hue(
            receiver.url,
            "synthetic-name-gate-key",
            tracer_provider=provider,
            capture_http=False,
            live_spans=False,
        ) as hue:
            with provider.get_tracer("application").start_as_current_span(
                name, kind=SpanKind.CLIENT, attributes=values
            ) as original:
                expected_id = original.get_span_context().span_id.to_bytes(8, "big")
                accepted = dict(original.attributes)
                assert get("requests", raw) == BODY
            assert hue.force_flush()
        (stored,) = [span for span in receiver.spans() if span.span_id == expected_id]
        assert stored.name == (name if mode == "ordinary" else "HTTP")
        assert secret.encode() not in exported_bytes(receiver)
        fields = attributes(stored)
        assert set(fields) <= set(accepted)
        assert len(fields) <= count
        assert "http.request.method" not in fields or mode == "invalid"
        (vendor_span,) = vendor.get_finished_spans()
        assert vendor_span.name == name
        assert dict(vendor_span.attributes) == accepted
        assert len(app.requests) == 1
    finally:
        provider.shutdown()


PATHS = (
    ("bot", "/bot123456789:synthetic_bot_secret/sendMessage"),
    ("bot", "/bot123456789%3Asynthetic_bot_secret/sendMessage"),
    ("bot", "/%62ot123456789%3Asynthetic_bot_secret/sendMessage"),
    ("webhook", "/services/TTEAM123/BHOOK456/synthetic_webhook_secret"),
    ("webhook-trailing", "/services/TTEAM123/BHOOK456/synthetic_webhook_secret/"),
    ("webhook-trailing", "/services/TTEAM123/BHOOK456/synthetic_webhook_secret///"),
    ("webhook", "/%73ervices/%54TEAM123/BHOOK456/%73ynthetic_webhook_secret"),
    ("label", "/token/synthetic_label_secret/items"),
    ("label", "/%74oken/%73ynthetic_label_secret/items"),
    ("label", "/token/secret/items"),
    ("label", "/token//secret/items"),
    ("label", "/token/secret%2Ftoken/items"),
    ("prefixed", "/v1/ghp_synthetic_prefixed_secret/items"),
    ("prefixed", "/v1/sk-synthetic_prefixed_secret/items"),
    ("prefixed", "/v1/xoxb-synthetic_prefixed_secret/items"),
    ("prefixed", "/v1/prefix-ghp_synthetic_prefixed_secret-suffix/items"),
    ("encoded-bot", "/api/bot123456789%3Asynthetic_bot_secret%2FsendMessage"),
    ("encoded-webhook", "/root/services%2FTTEAM123%2FBHOOK456%2Fsynthetic_webhook_secret"),
    ("encoded-label", "/token%2Fsynthetic_label_secret/items"),
    ("unchanged", "/v1/messages/msg_123/550e8400-e29b-41d4-a716-446655440000/a%2Fb"),
    ("unchanged", "/teams/TTEAM123/hooks/BHOOK456/messages/msg_123"),
    ("unchanged", "/services/TTEAM123/BHOOK456/items/suffix"),
)


def get(transport, url):
    if transport == "requests":
        with requests.Session() as client:
            return client.get(url).content
    module = importlib.import_module(transport)
    with module.Client(trust_env=False) as client:
        return client.get(url).content


def expected_path(kind, actual):
    if kind == "bot":
        return "/bot[redacted]/sendMessage"
    if kind == "webhook":
        return actual.rsplit("/", 1)[0] + "/[redacted]"
    if kind == "webhook-trailing":
        trimmed = actual.rstrip("/")
        return trimmed.rsplit("/", 1)[0] + "/[redacted]" + actual[len(trimmed) :]
    if kind == "label":
        parts = actual.split("/")
        index = next(index for index in range(2, len(parts)) if parts[index])
        parts[index] = "[redacted]"
        return "/".join(parts)
    if kind == "prefixed":
        return "/v1/[redacted]/items"
    if kind == "encoded-bot":
        return "/api/[redacted]"
    if kind == "encoded-webhook":
        return "/root/[redacted]"
    if kind == "encoded-label":
        return "/[redacted]/items"
    return actual


def exported_bytes(receiver):
    return b"".join(body for path, _, body in receiver.requests if path.endswith("/traces"))


@pytest.mark.parametrize("transport", ("requests", "httpx"))
@pytest.mark.parametrize("borrowed", (False, True))
@pytest.mark.parametrize("policy", POLICIES)
def test_capability_paths_are_safe_in_the_entire_export_without_changing_requests(
    receiver, app, transport, borrowed, policy
):
    provider = TracerProvider(shutdown_on_exit=False)
    vendor = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(vendor))
    options = {"tracer_provider": provider} if borrowed else {}
    urls = [
        app.url + path + "?token=synthetic_query_secret#synthetic-fragment" for _, path in PATHS
    ]
    try:
        for url in urls:
            assert get(transport, url) == BODY
        baseline = app.requests[:]
        with Hue(receiver.url, "synthetic-http-key", live_spans=False, **options, **policy) as hue:
            for url in urls:
                assert get(transport, url) == BODY
            assert hue.force_flush()
        assert app.requests[len(PATHS) :] == baseline
        assert all(
            "traceparent" not in {key.lower() for key in headers} for _, headers, _ in app.requests
        )
        spans = http_spans(receiver)
        assert len(spans) == len(PATHS)
        for span, (kind, _), (actual, _, _) in zip(spans, PATHS, baseline, strict=True):
            fields = attributes(span)
            path = actual.partition("?")[0]
            assert fields["url.full"] == app.url + expected_path(kind, path)
            assert span.name == "GET"
            assert fields["http.response.status_code"] == 200
        payload = exported_bytes(receiver)
        for secret in (
            b"bot123456789",
            b"synthetic_bot_secret",
            b"synthetic_webhook_secret",
            b"%73ynthetic_webhook_secret",
            b"synthetic_label_secret",
            b"%73ynthetic_label_secret",
            b"synthetic_prefixed_secret",
            b"synthetic_query_secret",
            b"synthetic-fragment",
        ):
            assert secret not in payload
    finally:
        provider.shutdown()


@pytest.mark.parametrize("transport", ("requests", "httpx"))
@pytest.mark.parametrize("policy", POLICIES)
def test_url_callback_protects_borrowed_stable_and_legacy_identity_without_mutating_other_exporters(
    receiver, app, transport, policy
):
    provider = TracerProvider(shutdown_on_exit=False)
    vendor = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(vendor))
    raw = (
        app.url.replace("http://", "http://synthetic-user:synthetic-password@")
        + "/bot123456789:synthetic_bot_secret/sendMessage/opaque/synthetic-custom-opaque"
        "?token=synthetic_query_secret#synthetic-fragment"
    )
    original_name = "GET " + raw
    calls = []

    def redact(key, value):
        if key == "url.full":
            calls.append(value)
            return value.replace("/synthetic-custom-opaque", "/[custom-redacted]")
        return value

    try:
        with Hue(
            receiver.url,
            "synthetic-http-key",
            live_spans=False,
            tracer_provider=provider,
            redactor=redact,
            **policy,
        ) as hue:
            with provider.get_tracer("application").start_as_current_span(
                original_name,
                kind=SpanKind.CLIENT,
                attributes={
                    "http.request.method": "GET",
                    "http.method": "GET",
                    "url.full": raw,
                    "http.url": raw,
                },
                links=[
                    Link(
                        SpanContext(1, 2, False, TraceFlags(1)),
                        attributes={"app.id": "synthetic-link"},
                    )
                ],
            ) as original:
                original.add_event("synthetic-event", {"app.id": "synthetic-event"})
                assert get(transport, raw) == BODY
                context = original.get_span_context()
            (vendor_span,) = vendor.get_finished_spans()
            vendor_attributes = dict(vendor_span.attributes)
            assert hue.force_flush()
        (span,) = http_spans(receiver)
        fields = attributes(span)
        expected = app.url + "/bot[redacted]/sendMessage/opaque/[custom-redacted]"
        assert fields["url.full"] == expected
        assert fields["http.url"] == expected
        assert span.name == "GET"
        assert span.span_id == context.span_id.to_bytes(8, "big")
        assert calls == [app.url + "/bot[redacted]/sendMessage/opaque/synthetic-custom-opaque"]
        assert vendor.get_finished_spans()[0] is vendor_span
        assert dict(vendor_span.attributes) == vendor_attributes
        assert vendor_span.get_span_context() == context
        assert vendor_span.attributes["url.full"] == raw
        assert vendor_span.attributes["http.url"] == raw
        assert vendor_span.name == original_name
        (event,) = span.events
        assert event.name == vendor_span.events[0].name == "synthetic-event"
        (link,) = span.links
        assert link.trace_id == (1).to_bytes(16, "big")
        assert link.span_id == (2).to_bytes(8, "big")
        payload = exported_bytes(receiver)
        for secret in (
            b"synthetic_bot_secret",
            b"synthetic-custom-opaque",
            b"synthetic-password",
            b"synthetic_query_secret",
            b"synthetic-fragment",
        ):
            assert secret not in payload
        assert len(app.requests) == 1
        assert app.requests[0][0].startswith("/bot123456789")
        assert "traceparent" not in {key.lower() for key in app.requests[0][1]}
    finally:
        provider.shutdown()


@pytest.mark.parametrize("policy", POLICIES)
@pytest.mark.parametrize("failure", ("none", "invalid", "raise"))
def test_failed_url_callback_omits_both_aliases_without_raw_fallback(
    receiver, app, policy, failure
):
    provider = TracerProvider(shutdown_on_exit=False)
    vendor = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(vendor))
    raw = app.url + "/token/synthetic_callback_secret/items"
    calls = []

    def redact(key, value):
        if key != "url.full":
            return value
        calls.append(value)
        if failure == "raise":
            raise RuntimeError("synthetic-redactor-failure")
        return None if failure == "none" else "not-an-http-url"

    try:
        with Hue(
            receiver.url,
            "synthetic-http-key",
            live_spans=False,
            tracer_provider=provider,
            redactor=redact,
            **policy,
        ) as hue:
            with provider.get_tracer("application").start_as_current_span(
                "GET " + raw,
                kind=SpanKind.CLIENT,
                attributes={"http.request.method": "GET", "url.full": raw, "http.url": raw},
            ):
                assert get("requests", raw) == BODY
            hue.force_flush()
        (span,) = http_spans(receiver)
        fields = attributes(span)
        assert "url.full" not in fields
        assert "http.url" not in fields
        assert span.name == "GET"
        assert calls == [app.url + "/token/[redacted]/items"]
        assert b"synthetic_callback_secret" not in exported_bytes(receiver)
        (original,) = vendor.get_finished_spans()
        assert original.name == "GET " + raw
        assert original.attributes["url.full"] == raw and original.attributes["http.url"] == raw
    finally:
        provider.shutdown()


@pytest.mark.parametrize("policy", POLICIES)
@pytest.mark.parametrize("method_key", ("http.request.method", "http.method"))
def test_dropped_url_attributes_cannot_leave_capability_secrets_in_the_http_span_name(
    receiver, app, policy, method_key
):
    provider = TracerProvider(shutdown_on_exit=False, span_limits=SpanLimits(max_attributes=1))
    vendor = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(vendor))
    raw = app.url + "/token/synthetic_dropped_url_secret/items"
    calls = []

    def redact(key, value):
        if key == "url.full":
            calls.append(value)
        return value

    try:
        with Hue(
            receiver.url,
            "synthetic-http-key",
            live_spans=False,
            capture_http=False,
            tracer_provider=provider,
            redactor=redact,
            **policy,
        ) as hue:
            with provider.get_tracer("application").start_as_current_span(
                "GET " + raw,
                kind=SpanKind.CLIENT,
                attributes={"url.full": raw, "http.url": raw, method_key: "GET"},
            ):
                assert get("requests", raw) == BODY
            assert hue.force_flush()
        (span,) = receiver.spans()
        fields = attributes(span)
        assert span.name == "GET"
        assert fields[method_key] == "GET"
        assert "url.full" not in fields and "http.url" not in fields
        assert span.dropped_attributes_count == 2
        assert calls == []
        assert b"synthetic_dropped_url_secret" not in exported_bytes(receiver)
        (original,) = vendor.get_finished_spans()
        assert original.name == "GET " + raw
        assert original.dropped_attributes == 2
        assert dict(original.attributes) == {method_key: "GET"}
        assert len(app.requests) == 1
    finally:
        provider.shutdown()


@pytest.mark.parametrize("policy", POLICIES)
@pytest.mark.parametrize("legacy_action", ("rewrite", "none", "raise"))
def test_legacy_url_callback_follows_canonical_callback_and_protects_both_aliases(
    receiver, app, policy, legacy_action
):
    provider = TracerProvider(shutdown_on_exit=False)
    vendor = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(vendor))
    raw = app.url + "/opaque/synthetic-custom-opaque"
    calls = []

    def redact(key, value):
        if key == "url.full":
            calls.append((key, value))
            return value.replace("/synthetic-custom-opaque", "/[canonical-redacted]")
        if key == "http.url":
            calls.append((key, value))
            if legacy_action == "raise":
                raise RuntimeError("synthetic-legacy-redactor-failure")
            if legacy_action == "none":
                return None
            return value.replace("/[canonical-redacted]", "/[legacy-redacted]")
        return value

    try:
        with Hue(
            receiver.url,
            "synthetic-http-key",
            live_spans=False,
            tracer_provider=provider,
            redactor=redact,
            **policy,
        ) as hue:
            with provider.get_tracer("application").start_as_current_span(
                "GET " + raw,
                kind=SpanKind.CLIENT,
                attributes={"http.request.method": "GET", "url.full": raw, "http.url": raw},
            ):
                assert get("requests", raw) == BODY
            hue.force_flush()
        (span,) = http_spans(receiver)
        fields = attributes(span)
        canonical = app.url + "/opaque/[canonical-redacted]"
        assert calls == [("url.full", raw), ("http.url", canonical)]
        if legacy_action == "rewrite":
            expected = app.url + "/opaque/[legacy-redacted]"
            assert fields["url.full"] == fields["http.url"] == expected
        else:
            assert "url.full" not in fields and "http.url" not in fields
        assert span.name == "GET"
        assert b"synthetic-custom-opaque" not in exported_bytes(receiver)
        (original,) = vendor.get_finished_spans()
        assert original.name == "GET " + raw
        assert original.attributes["url.full"] == original.attributes["http.url"] == raw
    finally:
        provider.shutdown()


@pytest.mark.parametrize("capture_content", (True, False))
def test_live_http_identity_is_safe_before_the_span_finishes(receiver, app, capture_content):
    raw = app.url + "/bot123456789:synthetic_bot_secret/opaque/synthetic-live-opaque"
    expected = app.url + "/bot[redacted]/opaque/[custom-redacted]"
    calls = []

    def redact(key, value):
        if key == "url.full":
            calls.append(value)
            return value.replace("/synthetic-live-opaque", "/[custom-redacted]")
        return value

    with Hue(
        receiver.url, "synthetic-http-key", capture_content=capture_content, redactor=redact
    ) as hue:
        with hue.span(
            "GET " + raw,
            kind=SpanKind.CLIENT,
            attributes={"http.request.method": "GET", "url.full": raw, "http.url": raw},
        ):
            assert get("requests", raw) == BODY
            deadline = time.monotonic() + 3
            while not any(span.end_time_unix_nano == 0 for span in http_spans(receiver)):
                assert time.monotonic() < deadline, "live HTTP placeholder was not exported"
                time.sleep(0.01)
            for span in http_spans(receiver):
                fields = attributes(span)
                assert span.name == "GET"
                assert fields["url.full"] == fields["http.url"] == expected
            assert b"synthetic_bot_secret" not in exported_bytes(receiver)
            assert b"synthetic-live-opaque" not in exported_bytes(receiver)
        assert hue.force_flush()
    assert calls
    assert all("synthetic_bot_secret" not in value for value in calls)
    assert all(span.name == "GET" for span in http_spans(receiver))
    assert b"synthetic_bot_secret" not in exported_bytes(receiver)
    assert b"synthetic-live-opaque" not in exported_bytes(receiver)


@pytest.mark.parametrize("policy", POLICIES)
def test_path_callback_controls_every_present_identity_alias_without_changing_vendor_span(
    receiver, app, policy
):
    provider = TracerProvider(shutdown_on_exit=False)
    vendor = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(vendor))
    path = "/bot123456789:synthetic_alias_secret/opaque/synthetic-alias-opaque"
    raw = app.url + path + "?token=synthetic_alias_query#synthetic-alias-fragment"
    aliases = {
        "url.full": raw,
        "http.url": raw,
        "http.target": path + "?token=synthetic_alias_query",
        "url.path": path,
        "url.query": "token=synthetic_alias_query",
    }
    calls = []

    def redact(key, value):
        if key in aliases:
            calls.append((key, value))
        if key == "url.path":
            return value.replace("/synthetic-alias-opaque", "/[path-redacted]")
        return value

    try:
        with Hue(
            receiver.url,
            "synthetic-http-key",
            live_spans=False,
            tracer_provider=provider,
            redactor=redact,
            **policy,
        ) as hue:
            with provider.get_tracer("application").start_as_current_span(
                "GET " + raw,
                kind=SpanKind.CLIENT,
                attributes={"http.request.method": "GET", **aliases},
            ):
                assert get("requests", raw) == BODY
            assert hue.force_flush()
        (span,) = http_spans(receiver)
        fields = attributes(span)
        safe_path = "/bot[redacted]/opaque/[path-redacted]"
        assert fields["url.full"] == fields["http.url"] == app.url + safe_path
        assert fields["http.target"] == fields["url.path"] == safe_path
        assert "url.query" not in fields
        assert span.name == "GET"
        assert [key for key, _ in calls] == ["url.full", "http.url", "http.target", "url.path"]
        (original,) = vendor.get_finished_spans()
        assert original.name == "GET " + raw
        assert {key: original.attributes[key] for key in aliases} == aliases
        payload = exported_bytes(receiver)
        for secret in (
            b"synthetic_alias_secret",
            b"synthetic-alias-opaque",
            b"synthetic_alias_query",
        ):
            assert secret not in payload
        assert app.requests[0][0].startswith(path)
    finally:
        provider.shutdown()


def test_failed_path_callback_omits_all_identity_aliases(receiver, app):
    provider = TracerProvider(shutdown_on_exit=False)
    raw_path = "/token/synthetic_path_callback_secret/items"
    raw = app.url + raw_path
    uri_keys = ("url.full", "http.url", "http.target", "url.path", "url.query")

    def redact(key, value):
        if key == "url.path":
            raise RuntimeError("synthetic-path-redactor-failure")
        return value

    try:
        with Hue(
            receiver.url,
            "synthetic-http-key",
            live_spans=False,
            capture_content=False,
            tracer_provider=provider,
            redactor=redact,
        ) as hue:
            with provider.get_tracer("application").start_as_current_span(
                "GET " + raw,
                kind=SpanKind.CLIENT,
                attributes={
                    "http.request.method": "GET",
                    "url.full": raw,
                    "http.url": raw,
                    "http.target": raw_path,
                    "url.path": raw_path,
                    "url.query": "token=synthetic_path_callback_secret",
                },
            ):
                assert get("requests", raw) == BODY
            hue.force_flush()
        (span,) = http_spans(receiver)
        fields = attributes(span)
        assert all(key not in fields for key in uri_keys)
        assert span.name == "GET"
        assert b"synthetic_path_callback_secret" not in exported_bytes(receiver)
    finally:
        provider.shutdown()


def test_path_only_http_identity_uses_path_hooks_without_inventing_a_full_url(receiver, app):
    provider = TracerProvider(shutdown_on_exit=False)
    vendor = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(vendor))
    raw_path = "/token/synthetic_path_only_secret/opaque/synthetic-path-opaque"
    calls = []

    def redact(key, value):
        if key in {"url.full", "http.url", "http.target", "url.path"}:
            calls.append(key)
        if key == "url.path":
            return value.replace("/synthetic-path-opaque", "/[path-redacted]")
        return value

    try:
        with Hue(
            receiver.url,
            "synthetic-http-key",
            live_spans=False,
            capture_http=False,
            tracer_provider=provider,
            redactor=redact,
        ) as hue:
            with provider.get_tracer("application").start_as_current_span(
                "GET " + raw_path,
                kind=SpanKind.CLIENT,
                attributes={
                    "http.request.method": "GET",
                    "http.target": raw_path + "?token=synthetic_path_only_query",
                    "url.path": raw_path,
                    "url.query": "token=synthetic_path_only_query",
                },
            ):
                assert get("requests", app.url + raw_path) == BODY
            assert hue.force_flush()
        (span,) = http_spans(receiver)
        fields = attributes(span)
        assert (
            fields["http.target"]
            == fields["url.path"]
            == "/token/[redacted]/opaque/[path-redacted]"
        )
        assert "url.full" not in fields and "http.url" not in fields and "url.query" not in fields
        assert calls == ["http.target", "url.path"]
        assert span.name == "GET"
        assert b"synthetic_path_only" not in exported_bytes(receiver)
        assert b"synthetic-path-opaque" not in exported_bytes(receiver)
        (original,) = vendor.get_finished_spans()
        assert original.attributes["url.path"] == raw_path
        assert original.name == "GET " + raw_path
    finally:
        provider.shutdown()


def test_whole_url_body_values_scrub_capabilities_and_keep_body_callback_control(receiver, app):
    ordinary = app.url + "/v1/messages/msg_123/a%2Fb"
    custom = app.url + "/opaque/synthetic-body-opaque"
    request_value = {
        "link": app.url + "/bot123456789:synthetic_body_secret/sendMessage",
        "ordinary": ordinary,
        "custom": custom,
    }
    response_value = {
        "link": app.url + "/services/TTEAM123/BHOOK456/synthetic_body_webhook_secret",
        "ordinary": ordinary,
        "custom": custom,
    }
    app.body = json.dumps(response_value).encode()
    calls = {}

    def redact(key, value):
        if key in {"input.value", "output.value"}:
            calls[key] = value
            return {**value, "custom": "[body-redacted]"}
        return value

    with Hue(receiver.url, "synthetic-http-key", live_spans=False, redactor=redact) as hue:
        assert requests.post(app.url + "/body-links", json=request_value).json() == response_value
        assert hue.force_flush()
    fields = attributes(http_spans(receiver)[0])
    recorded_input = json.loads(fields["input.value"])
    recorded_output = json.loads(fields["output.value"])
    assert recorded_input["link"] == app.url + "/bot[redacted]/sendMessage"
    assert recorded_output["link"] == app.url + "/services/TTEAM123/BHOOK456/[redacted]"
    assert recorded_input["ordinary"] == recorded_output["ordinary"] == ordinary
    assert recorded_input["custom"] == recorded_output["custom"] == "[body-redacted]"
    assert calls["input.value"]["link"] == recorded_input["link"]
    assert calls["output.value"]["link"] == recorded_output["link"]
    assert json.loads(app.requests[0][2]) == request_value
    payload = exported_bytes(receiver)
    for secret in (
        b"synthetic_body_secret",
        b"synthetic_body_webhook_secret",
        b"synthetic-body-opaque",
    ):
        assert secret not in payload


@pytest.mark.parametrize("location", ("span", "resource"))
def test_url_resource_name_is_filtered_without_changing_plain_labels_or_vendor_resources(
    receiver, app, location
):
    raw = (
        app.url + "/bot123456789:synthetic_resource_secret/opaque/synthetic-resource-opaque"
        "?token=synthetic_resource_query"
    )
    label = "synthetic-resource-label"
    resource_attributes = {
        "service.name": "synthetic-service",
        "resource.name": raw if location == "resource" else label,
    }
    schema = "https://example.test/schema"
    resource = Resource(resource_attributes, schema_url=schema)
    provider = TracerProvider(shutdown_on_exit=False, resource=resource)
    vendor = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(vendor))
    calls = []

    def redact(key, value):
        if key in {"url.full", "resource.name"}:
            calls.append((key, value))
        if key == "resource.name":
            return value.replace("/synthetic-resource-opaque", "/[resource-redacted]")
        return value

    try:
        with Hue(
            receiver.url,
            "synthetic-http-key",
            capture_content=location == "span",
            tracer_provider=provider,
            redactor=redact,
        ) as hue:
            with hue.span(
                "operation",
                attributes={"resource.name": raw if location == "span" else label},
            ):
                hue.logger_provider.get_logger("resource-filter").emit(
                    body="synthetic-log",
                    attributes={"resource.name": raw if location == "span" else label},
                )
                assert get("requests", app.url + "/resource-check") == BODY
                deadline = time.monotonic() + 3
                while not any(
                    span.name == "operation" and span.end_time_unix_nano == 0
                    for span in receiver.spans()
                ):
                    assert time.monotonic() < deadline, "live resource placeholder was not exported"
                    time.sleep(0.01)
            assert hue.force_flush()
        expected = app.url + "/bot[redacted]/opaque/[resource-redacted]"
        operation = next(span for span in receiver.spans() if span.name == "operation")
        assert attributes(operation)["resource.name"] == (expected if location == "span" else label)
        groups = [
            group
            for path, _, body in receiver.requests
            if path.endswith("/traces")
            for group in ExportTraceServiceRequest.FromString(body).resource_spans
        ]
        assert groups
        for group in groups:
            fields = attributes(group.resource)
            assert fields["resource.name"] == (expected if location == "resource" else label)
            assert fields["service.name"] == "synthetic-service"
            assert group.schema_url == schema
        log_groups = [
            group
            for path, _, body in receiver.requests
            if path.endswith("/logs")
            for group in ExportLogsServiceRequest.FromString(body).resource_logs
        ]
        assert log_groups
        for group in log_groups:
            assert attributes(group.resource)["resource.name"] == (
                expected if location == "resource" else label
            )
            for scope_logs in group.scope_logs:
                for log in scope_logs.log_records:
                    assert attributes(log)["resource.name"] == (
                        expected if location == "span" else label
                    )
        assert any(key == "resource.name" for key, _ in calls)
        assert all(value != label for _, value in calls)
        assert all("synthetic_resource_secret" not in value for _, value in calls)
        original = next(span for span in vendor.get_finished_spans() if span.name == "operation")
        assert original.resource is resource
        assert dict(original.resource.attributes) == resource_attributes
        assert original.resource.schema_url == schema
        assert original.attributes["resource.name"] == (raw if location == "span" else label)
        payload = exported_bytes(receiver)
        for secret in (
            b"synthetic_resource_secret",
            b"synthetic-resource-opaque",
            b"synthetic_resource_query",
        ):
            assert secret not in payload
        assert len(app.requests) == 1
    finally:
        provider.shutdown()


@pytest.mark.parametrize(("value_length", "span_length"), ((16, None), (64, 4)))
@pytest.mark.parametrize("count", (8, 0))
def test_live_and_final_uri_callbacks_cannot_expand_the_sdk_attribute_budget(
    receiver, value_length, span_length, count
):
    limits = SpanLimits(
        max_attributes=count,
        max_attribute_length=value_length,
        max_span_attribute_length=span_length,
    )
    original_limits = (limits.max_attributes, limits.max_span_attribute_length)
    provider = TracerProvider(shutdown_on_exit=False, span_limits=limits)
    vendor = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(vendor))
    raw = "http://x.test/a"
    aliases = ("url.full", "http.url", "http.target", "url.path", "url.query")
    calls = []

    def redact(key, value):
        if key == "url.full":
            calls.append(value)
            return value + "/synthetic-callback-expansion-over-the-sdk-limit"
        return value

    try:
        with Hue(
            receiver.url,
            "synthetic-http-key",
            capture_http=False,
            tracer_provider=provider,
            redactor=redact,
        ) as hue:
            with hue.span(
                "GET",
                kind=SpanKind.CLIENT,
                attributes={
                    "http.request.method": "GET",
                    "url.full": raw,
                    "http.url": raw,
                    "http.target": "/a",
                    "url.path": "/a",
                    "url.query": "q=synthetic",
                },
            ) as active:
                accepted = dict(active.otel_span.attributes)
                deadline = time.monotonic() + 3
                while not any(span.end_time_unix_nano == 0 for span in receiver.spans()):
                    assert time.monotonic() < deadline, "live budget placeholder was not exported"
                    time.sleep(0.01)
                for span in receiver.spans():
                    assert all(key not in attributes(span) for key in aliases)
            assert hue.force_flush()
        (finished,) = [span for span in receiver.spans() if span.end_time_unix_nano]
        fields = attributes(finished)
        assert all(key not in fields for key in aliases)
        assert len(fields) <= len(accepted) <= count
        assert set(fields) <= set(accepted)
        if count == 8 and span_length is None:
            assert accepted["url.full"] == raw
            assert calls
        else:
            assert calls == []
        (original,) = vendor.get_finished_spans()
        assert dict(original.attributes) == accepted
        assert (limits.max_attributes, limits.max_span_attribute_length) == original_limits
        assert b"synthetic-callback-expansion" not in exported_bytes(receiver)
    finally:
        provider.shutdown()
