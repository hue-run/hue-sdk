"""Receiver limits at a loopback receiver: advertised limits, wire-size batching, values kept up to
the cap, rate-limit holds, wide spans and dropped-record counts. Also run against the wheel."""

from __future__ import annotations

import base64
import os
import time

import pytest
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.trace import Link, set_span_in_context

from hue_sdk import Hue
from hue_sdk.transport import DroppedRecords

KEY = "synthetic-limits-key"
MIB = 1024 * 1024
TRUNCATED_KEY = "hue.truncated"


def noise(length: int) -> str:
    """``length`` characters of random base64: text gzip cannot shrink below about 3/4."""
    return base64.b64encode(os.urandom(length))[:length].decode()


def attrs(span):
    return {attribute.key: attribute.value for attribute in span.attributes}


def listed(span) -> list[str]:
    value = attrs(span).get(TRUNCATED_KEY)
    return [item.string_value for item in value.array_value.values] if value else []


def named(spans, name):
    (span,) = [span for span in spans if span.name == name]
    return span


def trace_requests(receiver):
    """Each trace request's wire size and spans."""
    result = []
    for path, headers, body in receiver.requests:
        if path.endswith("/traces"):
            request = ExportTraceServiceRequest.FromString(body)
            spans = [
                span
                for resource in request.resource_spans
                for scope in resource.scope_spans
                for span in scope.spans
            ]
            result.append((int(headers["X-Wire-Bytes"]), len(body), spans))
    return result


def test_advertised_limits_are_adopted_from_any_response_clamped_and_never_exceeded(receiver):
    # A refusal advertises too; a value cap of 1,000 bytes is clamped to 256 KiB.
    receiver.reply(503, **{"Retry-After": "0", "Hue-Max-Value-Bytes": "1000"})
    with Hue(
        receiver.url, KEY, capture_content=True, live_spans=False, max_queue_bytes=64 * MIB
    ) as hue:
        with hue.span("first"):
            pass
        assert hue.force_flush()
        span = hue.tracer.start_span("capped")
        span.set_attribute("output.value", "v" * (300 * 1024))
        span.end()
        assert hue.force_flush()
        capped = named(receiver.spans(), "capped")
        assert attrs(capped)["output.value"].string_value == "v" * (256 * 1024)
        assert listed(capped) == ["output.value"]

        # A receiver that raises its limits: a 1.5 MiB value stays whole, and a record gzip
        # cannot shrink to 1 MiB travels whole in one request, over 1 MiB on the wire.
        receiver.advertise = {
            "Hue-Max-Request-Bytes": str(4 * MIB),
            "Hue-Max-Decoded-Bytes": str(16 * MIB),
            "Hue-Max-Value-Bytes": str(2 * MIB),
        }
        with hue.span("raised"):
            pass
        assert hue.force_flush()
        text = "w" * (3 * MIB // 2)
        random = noise(9 * MIB // 5)
        span = hue.tracer.start_span("wide")
        span.set_attribute("output.value", text)
        span.set_attribute("input.value", random)
        span.end()
        assert hue.force_flush()
        ((wire, _, spans),) = [
            entry for entry in trace_requests(receiver) if any(s.name == "wide" for s in entry[2])
        ]
        assert MIB < wire <= 4 * MIB
        wide = named(spans, "wide")
        assert attrs(wide)["output.value"].string_value == text
        assert attrs(wide)["input.value"].string_value == random
        assert listed(wide) == []

        # Lowered again, the lower limits are kept.
        receiver.advertise = {
            "Hue-Max-Request-Bytes": str(MIB),
            "Hue-Max-Decoded-Bytes": str(4 * MIB),
            "Hue-Max-Value-Bytes": str(MIB),
        }
        with hue.span("lowered"):
            pass
        assert hue.force_flush()
        span = hue.tracer.start_span("narrow")
        span.set_attribute("output.value", text)
        span.set_attribute("input.value", noise(9 * MIB // 5))
        span.end()
        assert hue.force_flush()
        ((wire, _, spans),) = [
            entry for entry in trace_requests(receiver) if any(s.name == "narrow" for s in entry[2])
        ]
        assert wire <= MIB
        narrow = named(spans, "narrow")
        assert attrs(narrow)["output.value"].string_value == "w" * MIB
        assert listed(narrow) == ["output.value", "input.value"]
        assert hue.export_status.ok


def test_a_record_over_the_wire_limit_sheds_its_largest_content_values_measured_after_gzip(
    receiver,
):
    provider = TracerProvider(shutdown_on_exit=False)
    with Hue(
        receiver.url, KEY, capture_content=True, tracer_provider=provider, live_spans=False
    ) as hue:
        values = {
            "gen_ai.output.messages": noise(1000 * 1024),
            "ai.prompt": noise(900 * 1024),
            "output.value": noise(800 * 1024),
        }
        span = provider.get_tracer("third-party").start_span("chat")
        for key, value in values.items():
            span.set_attribute(key, value)
        span.set_attribute("gen_ai.request.model", "synthetic-model")
        span.end()
        # 3 MiB of compressible text in another record: sent whole, though over 1 MiB before gzip.
        whole = provider.get_tracer("third-party").start_span("whole")
        for key in values:
            whole.set_attribute(key, "c" * (1000 * 1024))
        whole.end()
        assert hue.force_flush()
        assert hue.export_status.ok
    requests = trace_requests(receiver)
    assert all(wire <= MIB and decoded <= 4 * MIB for wire, decoded, _ in requests)
    spans = [span for _, _, request in requests for span in request]
    chat = attrs(named(spans, "chat"))
    # The two largest are shed, largest first, as the receiver's marker; the rest reach Hue whole.
    for key in ("gen_ai.output.messages", "ai.prompt"):
        marker = {item.key: item.value for item in chat[key].kvlist_value.values}
        assert marker["hue.truncated"].bool_value is True
        assert marker["hue.truncated_bytes"].int_value == len(values[key])
    assert chat["output.value"].string_value == values["output.value"]
    assert chat["gen_ai.request.model"].string_value == "synthetic-model"
    assert listed(named(spans, "chat")) == ["gen_ai.output.messages", "ai.prompt"]
    kept = named(spans, "whole")
    assert listed(kept) == []
    assert all(attrs(kept)[key].string_value == "c" * (1000 * 1024) for key in values)


def test_a_2_mb_input_is_kept_cut_to_the_value_cap_and_listed(receiver):
    provider = TracerProvider(shutdown_on_exit=False)
    with Hue(
        receiver.url, KEY, capture_content=True, tracer_provider=provider, live_spans=False
    ) as hue:
        # A third-party instrumentation's 2 MB input, once a record over 1 MiB dropped whole.
        span = provider.get_tracer("openinference").start_span("llm")
        span.set_attribute("input.value", "é" * 1_000_000)
        span.set_attribute("llm.model_name", "synthetic-model")
        span.end()
        # And the helper's own.
        with hue.span("helper") as helper:
            helper.set_input("q" * 2_000_000)
        assert hue.force_flush()
        assert hue.export_status.ok
    spans = receiver.spans()
    llm = named(spans, "llm")
    value = attrs(llm)["input.value"].string_value
    assert MIB - 4 < len(value.encode("utf-8")) <= MIB
    assert set(value) == {"é"}
    assert attrs(llm)["llm.model_name"].string_value == "synthetic-model"
    assert listed(llm) == ["input.value"]
    helper = named(spans, "helper")
    stored = attrs(helper)["input.value"].string_value
    assert len(stored.encode("utf-8")) == MIB and stored.startswith('"qqq')
    assert listed(helper) == ["input.value"]


def test_a_429_past_the_request_deadline_is_held_and_sent_after_its_retry_after(receiver):
    receiver.reply(429, **{"Retry-After": "30"})
    with Hue(receiver.url, KEY, capture_content=False, live_spans=False) as hue:
        with hue.span("held"):
            pass
        started = time.monotonic()
        # Refused for its rate and held: still queued, nothing lost or reported.
        assert not hue.force_flush(timeout_millis=2000)
        status = hue.export_status
        assert status.queued_trace_records == 1 and status.failed_trace_batches == 0
        assert hue.force_flush(timeout_millis=60_000)
        assert time.monotonic() - started >= 29.5
        assert hue.export_status.ok
        assert hue.export_issues() == ()
    assert len(receiver.requests) == 2
    assert receiver.requests[0][2] == receiver.requests[1][2]
    assert [span.name for span in receiver.spans()] == ["held", "held"]


def test_a_429_longer_than_the_hold_loses_its_records_at_once_and_counts_them_on_the_root(
    receiver,
):
    receiver.reply(429, **{"Retry-After": "61"})
    with Hue(receiver.url, KEY, capture_content=False, live_spans=False) as hue:
        with hue.span("agent turn"):
            with hue.span("step"):
                pass
            started = time.monotonic()
            assert not hue.force_flush(timeout_millis=10_000)
            assert time.monotonic() - started < 5
            (issue,) = [issue for issue in hue.export_issues() if issue.kind == "failed"]
            assert issue.count == 1
            assert issue.message.startswith("Hue limited the telemetry rate")
        hue.force_flush()
    root = named(receiver.spans(), "agent turn")
    assert attrs(root)["hue.sdk.dropped_records"].int_value == 1


def test_owned_spans_keep_2000_attributes_events_and_links(receiver):
    with Hue(receiver.url, KEY, capture_content=False, live_spans=False) as hue:
        target = hue.tracer.start_span("target")
        target.end()
        links = [Link(target.get_span_context(), {"app.link": index}) for index in range(300)]
        span = hue.tracer.start_span("wide", links=links)
        for index in range(2001):
            span.set_attribute(f"app.field.{index}", index)
        for index in range(300):
            span.add_event(f"step {index}")
        span.add_event("wide event", {f"app.key.{index}": index for index in range(200)})
        span.end()
        assert hue.force_flush()
    wide = named(receiver.spans(), "wide")
    # OpenTelemetry's default keeps 128 of each; the client keeps 2,000 and counts the rest.
    assert len(wide.attributes) == 2000
    assert wide.dropped_attributes_count == 1
    assert len(wide.events) == 301 and len(wide.events[-1].attributes) == 200
    assert len(wide.links) == 300


def test_an_environment_span_limit_still_wins(receiver, monkeypatch):
    monkeypatch.setenv("OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT", "10")
    with Hue(receiver.url, KEY, capture_content=False, live_spans=False) as hue:
        span = hue.tracer.start_span("configured")
        for index in range(20):
            span.set_attribute(f"app.field.{index}", index)
        span.add_event("event", {f"app.key.{index}": index for index in range(200)})
        span.end()
        assert hue.force_flush()
    configured = named(receiver.spans(), "configured")
    assert len(configured.attributes) == 10
    assert len(configured.events[0].attributes) == 200


def test_records_dropped_from_the_queue_are_counted_on_the_trace_root(receiver):
    with Hue(receiver.url, KEY, capture_content=False, live_spans=False, max_queue_size=2) as hue:
        with hue.span("agent turn"):
            for index in range(5):
                with hue.span(f"step-{index}"):
                    pass
            assert not hue.force_flush()
        hue.force_flush()
    names = [span.name for span in receiver.spans()]
    assert names == ["step-0", "step-1", "agent turn"]
    root = named(receiver.spans(), "agent turn")
    assert attrs(root)["hue.sdk.dropped_records"].int_value == 3


def test_a_record_too_large_without_its_content_is_counted_on_the_trace_root(receiver):
    with Hue(receiver.url, KEY, capture_content=False, live_spans=False) as hue:
        with hue.span("agent turn"):
            with hue.span("custom step") as step:
                # 1,500 KB of metadata gzip cannot fit into 1 MiB; metadata is never shed.
                for index in range(6):
                    step.set_attribute(f"custom.blob.{index}", noise(250_000))
            assert not hue.force_flush()
        hue.force_flush()
    assert [span.name for span in receiver.spans()] == ["agent turn"]
    root = named(receiver.spans(), "agent turn")
    assert attrs(root)["hue.sdk.dropped_records"].int_value == 1


def test_an_owned_span_with_2000_events_of_several_attributes_is_exported_whole(receiver):
    with Hue(receiver.url, KEY, capture_content=True, live_spans=False) as hue:
        span = hue.tracer.start_span("many events")
        for index in range(2000):
            span.add_event(
                f"step {index}",
                {
                    "app.step": index,
                    "app.kind": "tool",
                    "app.ok": True,
                    "app.note": f"note {index}",
                    "app.cost": index / 10,
                },
            )
        span.end()
        assert hue.force_flush()
        assert hue.export_status.ok
    record = named(receiver.spans(), "many events")
    assert len(record.events) == 2000
    assert len(record.events[-1].attributes) == 5
    assert record.dropped_events_count == 0


def test_a_span_whose_events_outgrow_the_queue_budget_keeps_its_newest_events(receiver):
    with Hue(receiver.url, KEY, capture_content=True, live_spans=False, max_queue_bytes=MIB) as hue:
        target = hue.tracer.start_span("target")
        target.end()
        assert hue.force_flush()
        links = [
            Link(target.get_span_context(), {"app.link": index, "app.note": "l" * 1000})
            for index in range(600)
        ]
        span = hue.tracer.start_span("long turn", links=links)
        span.set_attribute("output.value", "the final answer")
        # About 2 MB of events: twice the record's budget.
        for index in range(2000):
            span.add_event(f"step {index}", {"app.note": "n" * 1000})
        span.end()
        assert hue.force_flush()
        assert hue.export_status.ok
    record = named(receiver.spans(), "long turn")
    assert attrs(record)["output.value"].string_value == "the final answer"
    kept = len(record.events)
    assert 100 < kept < 2000
    assert record.events[-1].name == "step 1999"
    assert record.events[0].name == f"step {2000 - kept}"
    assert record.dropped_events_count == 2000 - kept
    # The events took what the budget held, so the links, copied after them, were left out.
    assert len(record.links) + record.dropped_links_count == 600
    assert record.dropped_links_count > 0


def test_batches_stay_at_4_mib_under_a_higher_advertised_decoded_limit(receiver):
    _batches_under_advertised_limit(receiver, 8 * MIB, 4 * MIB)


def test_batches_stay_within_a_lower_advertised_decoded_limit(receiver):
    _batches_under_advertised_limit(receiver, 2 * MIB, 2 * MIB)


def _batches_under_advertised_limit(receiver, decoded: int, target: int) -> None:
    receiver.advertise = {
        "Hue-Max-Request-Bytes": str(4 * MIB),
        "Hue-Max-Decoded-Bytes": str(decoded),
    }
    with Hue(
        receiver.url, KEY, capture_content=True, live_spans=False, max_queue_bytes=32 * MIB
    ) as hue:
        with hue.span("adopt"):
            pass
        assert hue.force_flush()
        # 7.2 MB of text that compresses well: one request under the advertised ceiling alone.
        for index in range(12):
            with hue.span(f"record-{index}") as span:
                span.set_output("x" * 600_000)
        assert hue.force_flush()
        assert hue.export_status.ok
    requests = trace_requests(receiver)[1:]
    assert sum(len(spans) for _, _, spans in requests) == 12
    assert len(requests) >= -(-12 * 600_000 // target)
    assert all(decoded_size <= target for _, decoded_size, _ in requests)


def test_a_record_with_1500_incompressible_content_values_sheds_the_fewest_in_bounded_time(
    receiver,
):
    with Hue(receiver.url, KEY, capture_content=True, live_spans=False) as hue:
        # A long conversation flattened into 3 MB of messages, about 2.3 MB after gzip.
        span = hue.tracer.start_span("conversation")
        for index in range(1500):
            span.set_attribute(f"llm.input_messages.{index}.message.content", noise(2000))
        span.end()
        started = time.monotonic()
        assert hue.force_flush(timeout_millis=60_000)
        # Shedding one value per encoding and compression took over a minute and a half here.
        assert time.monotonic() - started < 30
        assert hue.export_status.ok
    ((wire, _, spans),) = trace_requests(receiver)
    assert MIB - 32 * 1024 < wire <= MIB
    record = named(spans, "conversation")
    shed = listed(record)
    assert 500 < len(shed) < 1500
    assert all(attrs(record)[key].HasField("kvlist_value") for key in shed)


@pytest.mark.parametrize(("status", "retry_after"), [(429, "3"), (503, "1")])
def test_a_request_over_limits_a_refusal_lowered_is_split_before_it_is_sent_again(
    receiver, status, retry_after
):
    lowered = {"Hue-Max-Request-Bytes": str(MIB), "Hue-Max-Decoded-Bytes": str(MIB)}
    receiver.reply(status, **{"Retry-After": retry_after, **lowered})
    receiver.advertise = dict(lowered)
    with Hue(
        receiver.url, KEY, capture_content=True, live_spans=False, export_timeout_seconds=2
    ) as hue:
        # 2.4 MB that compresses well: one request under the 4 MiB decoded limit it was sent at.
        for index in range(6):
            with hue.span(f"record-{index}") as span:
                span.set_output("x" * 400_000)
        assert hue.force_flush(timeout_millis=30_000)
        assert hue.export_status.ok
    refused, *resent = trace_requests(receiver)
    assert refused[1] > MIB
    assert len(resent) > 1
    assert all(decoded <= MIB for _, decoded, _ in resent)
    assert sum(len(spans) for _, _, spans in resent) == 6


def test_a_root_carries_the_records_an_earlier_request_of_the_same_export_lost(receiver):
    # One export of both spans, which gzip cannot fit into one request: the child's request is
    # refused for longer than an export holds it, and the root follows in a second request.
    receiver.reply(429, **{"Retry-After": "61"})
    with Hue(receiver.url, KEY, capture_content=False, live_spans=False) as hue:
        root = hue.tracer.start_span("agent turn")
        step = hue.tracer.start_span("step", context=set_span_in_context(root))
        step.set_attribute("custom.blob", noise(750_000))
        step.end()
        root.set_attribute("custom.blob", noise(750_000))
        root.end()
        assert not hue.force_flush()
    assert len(trace_requests(receiver)) == 2
    exported = named(receiver.spans()[-1:], "agent turn")
    assert attrs(exported)["hue.sdk.dropped_records"].int_value == 1


def test_an_acknowledged_root_consumes_only_the_count_it_carried():
    dropped = DroppedRecords()
    span = TracerProvider(shutdown_on_exit=False).get_tracer("t").start_span("lost")
    trace_id = format(span.get_span_context().trace_id, "032x")
    span.end()
    dropped.count([span, span])
    assert dropped.of(trace_id) == 2
    dropped.consume({trace_id: 1})
    # A record lost while the root's request was in flight is still counted.
    assert dropped.of(trace_id) == 1
    dropped.consume({trace_id: 1})
    assert dropped.of(trace_id) == 0


def test_a_span_whose_numeric_events_outgrow_the_queue_budget_keeps_its_newest_events(receiver):
    with Hue(
        receiver.url, KEY, capture_content=False, live_spans=False, max_queue_bytes=MIB
    ) as hue:
        span = hue.tracer.start_span("measurements")
        # About 2.2 MB encoded: twice the record's budget, in values that encode larger than
        # their eight bytes.
        for index in range(100):
            span.add_event(f"sample {index}", {"app.values": [index + 0.5] * 2000})
        span.end()
        assert hue.force_flush()
        assert hue.export_status.ok
    record = named(receiver.spans(), "measurements")
    kept = len(record.events)
    assert 0 < kept < 100
    assert record.events[-1].name == "sample 99"
    assert record.dropped_events_count == 100 - kept
