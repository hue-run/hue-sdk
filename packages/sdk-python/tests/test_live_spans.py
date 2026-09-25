from __future__ import annotations

import json
import os
import signal
import sys
import time
import warnings
from threading import Event, Lock, Thread

import pytest
from opentelemetry import trace
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
    ExportTraceServiceResponse,
)
from opentelemetry.sdk.trace import SpanLimits, SpanProcessor, TracerProvider

from hue_sdk import ExportStatus, Hue, create_hue_safe

KEY = "synthetic-local-project-key"
SETUP_KEY = "hue_setup_test_setup-0123456789abcdef01234567_" + "s" * 43
# What a current Hue sends with every trace acknowledgement; an older one omits it.
CURRENT = {"Hue-Pending-Spans": "1"}


def attrs(span):
    return {attribute.key: attribute.value for attribute in span.attributes}


def wait_for(condition, timeout=5.0):
    deadline = time.monotonic() + timeout
    while not condition():
        assert time.monotonic() < deadline, "condition was not reached"
        time.sleep(0.01)


def queued(hue, count):
    return lambda: hue.export_status.queued_trace_records == count


def split_placeholders(receiver):
    spans = receiver.spans()
    pending = {span.name: span for span in spans if span.end_time_unix_nano == 0}
    real = {span.name: span for span in spans if span.end_time_unix_nano}
    return pending, real


def request_ends(body):
    request = ExportTraceServiceRequest.FromString(body)
    return sorted(
        span.end_time_unix_nano == 0
        for resource in request.resource_spans
        for scope in resource.scope_spans
        for span in scope.spans
    )


def rejection(count, message):
    response = ExportTraceServiceResponse()
    response.partial_success.rejected_spans = count
    response.partial_success.error_message = message
    return response.SerializeToString()


def test_live_placeholders_announce_open_spans_with_start_time_input(receiver):
    with Hue(receiver.url, KEY, capture_content=True) as hue:
        with hue.context(session_id="conversation"):
            with hue.span("agent.run") as root:
                # Helper input set just after entering still reaches the placeholder.
                root.set_input({"question": "What is 2 + 2?"})
                with hue.model("test-model", provider="synthetic") as model:
                    model.set_input([{"role": "user", "content": "What is 2 + 2?"}])
                    model.set_attribute("gen_ai.system_instructions", "Answer briefly.")
                    model.set_attribute("gen_ai.tool.definitions", "[]")
                    model.set_attribute("custom.large", "x" * 70_000)
                    model.set_attribute("custom.small", "kept")
                    wait_for(queued(hue, 2))
                    assert hue.force_flush()
                    assert all(span.end_time_unix_nano == 0 for span in receiver.spans())
        assert hue.force_flush()
    pending, real = split_placeholders(receiver)
    assert len(receiver.spans()) == 4
    for name in ("agent.run", "chat test-model"):
        placeholder, span = pending[name], real[name]
        assert placeholder.trace_id == span.trace_id
        assert placeholder.parent_span_id == span.span_id
        assert placeholder.span_id not in {item.span_id for item in real.values()}
        assert placeholder.start_time_unix_nano == span.start_time_unix_nano
        assert (placeholder.kind, placeholder.flags) == (span.kind, span.flags)
        assert placeholder.status.code == 0 and not placeholder.events
        assert attrs(placeholder)["hue.span_type"].string_value == "pending_span"
        assert attrs(placeholder)["gen_ai.conversation.id"].string_value == "conversation"
        assert "hue.span_type" not in attrs(span)
    root, model = pending["agent.run"], pending["chat test-model"]
    assert root.span_id != model.span_id
    assert "hue.pending_parent_id" not in attrs(root)
    assert json.loads(attrs(root)["input.value"].string_value) == {"question": "What is 2 + 2?"}
    assert attrs(model)["hue.pending_parent_id"].string_value == real["agent.run"].span_id.hex()
    assert "gen_ai.input.messages" in attrs(model)
    assert attrs(model)["custom.small"].string_value == "kept"
    for trimmed in ("gen_ai.system_instructions", "gen_ai.tool.definitions", "custom.large"):
        assert trimmed not in attrs(model)
        assert trimmed in attrs(real["chat test-model"])


def test_placeholder_is_dropped_when_its_span_ends_before_export(receiver):
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        with hue.span("agent.run"):
            wait_for(queued(hue, 1))
        # The placeholder and its now-finished span share a batch; only the span is sent.
        assert hue.force_flush()
        assert hue.export_status.ok
    assert [(span.name, span.end_time_unix_nano > 0) for span in receiver.spans()] == [
        ("agent.run", True)
    ]


def test_markers_are_written_after_redaction_and_reserved_on_real_spans(receiver):
    def hostile_redactor(_field, _value):
        span = trace.get_current_span()
        span.set_attribute("hue.span_type", "forged")
        span.set_attribute("hue.pending_parent_id", "ffffffffffffffff")
        return {"redacted": True}

    with Hue(receiver.url, KEY, capture_content=True, redactor=hostile_redactor) as hue:
        with hue.span("agent.run") as root:
            root.set_input("sensitive-input")
            with hue.tool("lookup") as tool:
                tool.set_input({"query": "sensitive-input"})
                wait_for(queued(hue, 2))
                assert hue.force_flush()
        assert hue.force_flush()
    pending, real = split_placeholders(receiver)
    root, tool = pending["agent.run"], pending["execute_tool lookup"]
    assert attrs(root)["hue.span_type"].string_value == "pending_span"
    assert "hue.pending_parent_id" not in attrs(root)
    assert attrs(tool)["hue.span_type"].string_value == "pending_span"
    assert attrs(tool)["hue.pending_parent_id"].string_value == real["agent.run"].span_id.hex()
    assert json.loads(attrs(root)["input.value"].string_value) == {"redacted": True}
    for span in real.values():
        assert "hue.span_type" not in attrs(span)
        assert "hue.pending_parent_id" not in attrs(span)
    assert b"sensitive-input" not in b"".join(body for _, _, body in receiver.requests)


def test_placeholders_follow_the_helper_content_policy(receiver):
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        with hue.model("test-model", provider="synthetic") as model:
            model.set_input([{"role": "user", "content": "sensitive-question"}])
            wait_for(queued(hue, 1))
            assert hue.force_flush()
        assert hue.force_flush()
    pending, _ = split_placeholders(receiver)
    assert attrs(pending["chat test-model"])["gen_ai.request.model"].string_value == "test-model"
    assert "gen_ai.input.messages" not in attrs(pending["chat test-model"])
    assert b"sensitive-question" not in b"".join(body for _, _, body in receiver.requests)


@pytest.mark.parametrize("capture_content", [True, False])
def test_placeholders_apply_the_content_policy_to_third_party_attributes(receiver, capture_content):
    content = {
        "gen_ai.input.messages": '[{"role":"user","content":"private-question"}]',
        "input.value": "private-input",
        "llm.input_messages.0.message.content": "private-message",
        "ai.prompt": "private-prompt",
        "traceloop.entity.input": "private-entity",
    }
    with Hue(receiver.url, KEY, capture_content=capture_content) as hue:
        span = hue.tracer_provider.get_tracer("third-party").start_span(
            "chat synthetic-model",
            attributes={"gen_ai.operation.name": "chat", "gen_ai.request.model": "synthetic"},
        )
        try:
            # An instrumentor records the request on the open span, outside Hue's helpers.
            span.set_attributes(content)
            wait_for(queued(hue, 1))
            assert hue.force_flush()
            (placeholder,) = receiver.spans()
        finally:
            span.end()
        assert hue.force_flush()
    keys = attrs(placeholder)
    assert placeholder.end_time_unix_nano == 0
    assert keys["hue.span_type"].string_value == "pending_span"
    assert keys["gen_ai.request.model"].string_value == "synthetic"
    assert {key for key in content if key in keys} == (set(content) if capture_content else set())
    placeholder_request = receiver.requests[0][2]
    assert (b"private-" in placeholder_request) is capture_content


@pytest.mark.parametrize("reply", ["http-error", "rejected"])
def test_failed_placeholder_only_export_is_not_a_failure(receiver, reply):
    if reply == "http-error":
        receiver.reply(400)
    else:
        receiver.reply(200, rejection(1, "Invalid pending span placeholder"), **CURRENT)
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        with hue.span("agent.run"):
            wait_for(queued(hue, 1))
            assert hue.force_flush()
        assert hue.force_flush()
        status = hue.export_status
        assert status.ok and status.failed_trace_batches == 0
        assert status.dropped_trace_records == 0
        assert not status.live_spans_rejected
    assert len(receiver.spans()) == 2


def test_failed_batch_with_finished_spans_still_fails(receiver):
    receiver.reply(400)
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        with hue.span("agent.run"):
            wait_for(queued(hue, 1))
            with hue.span("finished-step"):
                pass
            assert not hue.force_flush()
            assert hue.export_status.failed_trace_batches == 1


def test_receiver_without_live_spans_turns_them_off_without_failing(receiver):
    receiver.reply(200, rejection(1, "Invalid span start or end timestamp"))
    assert ExportStatus(0, 0).live_spans_rejected is False
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        with hue.span("agent.run"):
            wait_for(queued(hue, 1))
            with hue.span("finished-step"):
                pass
            # One request carries the placeholder and a finished span; only the placeholder
            # is rejected, so the stored span is not reported as a failure.
            assert hue.force_flush()
            status = hue.export_status
            assert status.live_spans_rejected and status.ok
            assert status.failed_trace_batches == 0
            with hue.span("after-rejection"):
                time.sleep(0.8)
                assert hue.export_status.queued_trace_records == 0
        assert hue.force_flush()
    assert request_ends(receiver.requests[0][2]) == [False, True]
    pending, real = split_placeholders(receiver)
    assert list(pending) == ["agent.run"]
    assert sorted(real) == ["after-rejection", "agent.run", "finished-step"]


def test_mixed_rejection_by_older_receiver_fails_and_turns_live_spans_off(receiver):
    # One placeholder rejected by timestamp plus one finished span rejected for another reason.
    receiver.reply(200, rejection(2, "Invalid span start or end timestamp Other reason"))
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        with hue.span("agent.run"):
            wait_for(queued(hue, 1))
            with hue.span("finished-step"):
                pass
            with hue.span("second-step"):
                pass
            assert not hue.force_flush()
            status = hue.export_status
            assert status.live_spans_rejected and status.failed_trace_batches == 1
            with hue.span("after-rejection"):
                time.sleep(0.8)
                assert hue.export_status.queued_trace_records == 0
        hue.force_flush()
    assert request_ends(receiver.requests[0][2]) == [False, False, True]
    pending, _ = split_placeholders(receiver)
    assert list(pending) == ["agent.run"]


def test_receiver_without_the_header_gets_placeholders_in_one_export_only(receiver):
    # A generic collector accepts everything but never sends the header.
    receiver.legacy = True
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        with hue.span("agent.run"):
            wait_for(queued(hue, 1))
            assert hue.force_flush()
            status = hue.export_status
            assert status.live_spans_rejected and status.ok
            with hue.span("after-downgrade"):
                time.sleep(0.8)
                assert hue.export_status.queued_trace_records == 0
        assert hue.force_flush()
    pending, real = split_placeholders(receiver)
    assert list(pending) == ["agent.run"]
    assert sorted(real) == ["after-downgrade", "agent.run"]


def test_current_receiver_timestamp_rejection_fails_and_keeps_live_spans(receiver):
    # The text an older receiver gives placeholders, here about a finished span's timestamps.
    receiver.reply(200, rejection(1, "Invalid span start or end timestamp"), **CURRENT)
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        with hue.span("agent.run"):
            with hue.span("agent.step"):
                wait_for(queued(hue, 2))
                with hue.span("bad-timestamp"):
                    pass
                assert not hue.force_flush()
                status = hue.export_status
                assert status.failed_trace_batches == 1
                assert not status.live_spans_rejected
                with hue.span("later"):
                    wait_for(queued(hue, 1))
                    hue.force_flush()
        hue.force_flush()
    assert request_ends(receiver.requests[0][2]) == [False, True, True]
    pending, _ = split_placeholders(receiver)
    assert sorted(pending) == ["agent.run", "agent.step", "later"]


def test_live_spans_option_is_validated_and_forwarded_by_the_safe_constructor(receiver):
    with pytest.raises(TypeError, match="live_spans"):
        Hue(receiver.url, KEY, capture_content=False, live_spans="no")
    fallback = create_hue_safe(receiver.url, KEY, capture_content=False, live_spans="no")
    assert not fallback.enabled and not fallback.export_status.ok
    assert receiver.requests == []


@pytest.mark.parametrize(
    "factory,key,options",
    [
        (Hue, SETUP_KEY, {}),
        (Hue, KEY, {"live_spans": False}),
        (create_hue_safe, KEY, {"live_spans": False}),
    ],
)
def test_live_spans_opt_out_and_setup_keys_send_no_placeholders(receiver, factory, key, options):
    with factory(receiver.url, key, capture_content=False, **options) as hue:
        assert hue.enabled
        with hue.span("agent.run"):
            time.sleep(0.8)
            assert hue.export_status.queued_trace_records == 0
        assert hue.force_flush()
    assert [span.end_time_unix_nano > 0 for span in receiver.spans()] == [True]


@pytest.mark.parametrize("limit", [{"max_queue_size": 3}, {"max_queue_bytes": 1000}])
def test_placeholders_use_at_most_a_quarter_of_the_queue_and_are_never_dropped(receiver, limit):
    # One placeholder would exceed a quarter of this queue, so real records keep all of it.
    with Hue(receiver.url, KEY, capture_content=False, **limit) as hue:
        with hue.span("agent.run"):
            time.sleep(0.8)
            assert hue.export_status.queued_trace_records == 0
        assert hue.force_flush()
        assert hue.export_status.dropped_trace_records == 0
    assert [span.end_time_unix_nano > 0 for span in receiver.spans()] == [True]


def test_queued_placeholders_are_not_counted_when_shutdown_discards_the_queue(
    receiver, monkeypatch
):
    from hue_sdk.transport import SafeSession

    started, release = Event(), Event()
    calls = []
    original_request = SafeSession._request

    def blocked_request(session, method, url, **kwargs):
        if session.signal == "traces":
            calls.append(1)
            if len(calls) == 1:
                started.set()
                assert release.wait(10), "test did not release the blocked HTTP worker"
        return original_request(session, method, url, **kwargs)

    monkeypatch.setattr(SafeSession, "_request", blocked_request)
    hue = Hue(receiver.url, KEY, capture_content=False, export_timeout_seconds=0.3)
    processor = hue._span_processor
    try:
        with hue.span("ambiguous"):
            pass
        # The timed-out request keeps the only HTTP worker, so later records stay queued.
        assert not hue.force_flush(timeout_millis=1500)
        assert started.is_set()
        with hue.span("running"):
            wait_for(queued(hue, 1))
        assert hue.export_status.queued_trace_records == 2
        assert not hue.shutdown_safe(timeout_millis=500)
        # Only the finished span counts as dropped; its placeholder was advisory.
        assert processor.status == (1, 0, 0)
        assert hue.export_status.dropped_trace_records == 1
        assert len(calls) == 1
    finally:
        release.set()
        hue.shutdown_safe()


def test_span_filtered_before_on_end_is_forgotten(receiver):
    class ForwardStartOnly(SpanProcessor):
        """A customer wrapper that forwards every start but filters this span's end."""

        def __init__(self, inner):
            self.inner = inner

        def on_start(self, span, parent_context=None):
            self.inner.on_start(span, parent_context)

    hue = Hue(receiver.url, KEY, capture_content=False)
    provider = TracerProvider(shutdown_on_exit=False)
    provider.add_span_processor(ForwardStartOnly(hue._span_processor))
    try:
        span = provider.get_tracer("customer").start_span(
            "chat", attributes={"gen_ai.operation.name": "chat"}
        )
        wait_for(queued(hue, 1))
        span.end()
        # Its queued placeholder would never resolve, so it is discarded, not sent.
        assert hue.force_flush()
        assert hue.export_status.queued_trace_records == 0
        assert hue.export_status.dropped_trace_records == 0
        assert receiver.spans() == []
    finally:
        assert hue.shutdown()
        provider.shutdown()


def test_only_hue_and_ai_spans_are_announced(receiver):
    provider = TracerProvider(shutdown_on_exit=False)
    hue = Hue(receiver.url, KEY, capture_content=False, tracer_provider=provider)
    tracer = provider.get_tracer("framework-instrumentation")
    try:
        with tracer.start_as_current_span("GET /chat"):
            with tracer.start_as_current_span("SELECT messages"):
                with tracer.start_as_current_span(
                    "chat model", attributes={"gen_ai.operation.name": "chat"}
                ):
                    with tracer.start_as_current_span("ai.streamText"):
                        with tracer.start_as_current_span(
                            "workflow", attributes={"traceloop.entity.name": "agent"}
                        ):
                            with tracer.start_as_current_span(
                                "retrieve", attributes={"llm.system": "synthetic"}
                            ):
                                with hue.span("agent.step"):
                                    wait_for(queued(hue, 5))
                                    # Every span started together; a sixth would be
                                    # announced by this tick too.
                                    time.sleep(0.6)
                                    assert hue.force_flush()
                                    announced = sorted(span.name for span in receiver.spans())
        assert announced == ["agent.step", "ai.streamText", "chat model", "retrieve", "workflow"]
    finally:
        hue.shutdown()
        provider.shutdown()


def test_announced_spans_are_forgotten_so_unended_spans_hold_no_tracking_slot(
    receiver, monkeypatch
):
    monkeypatch.setattr("hue_sdk.processors.LIVE_SPAN_LIMIT", 1)
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        tracer = hue.tracer_provider.get_tracer("customer")
        chat = {"gen_ai.operation.name": "chat"}
        # Never ended while the client runs, like a stream the application stops reading.
        abandoned = tracer.start_span("abandoned", attributes=chat)
        try:
            wait_for(lambda: "abandoned" in split_placeholders(receiver)[0])
            assert not hue._span_processor._live
            # The only tracking slot is free again, so the next span is announced too.
            later = tracer.start_span("later", attributes=chat)
            wait_for(lambda: "later" in split_placeholders(receiver)[0])
            later.end()
        finally:
            abandoned.end()
        assert hue.force_flush()


@pytest.mark.skipif(not hasattr(os, "fork"), reason="POSIX fork regression")
def test_span_hooks_in_a_forked_child_never_wait_for_the_processor_lock(receiver):
    hue = Hue(receiver.url, KEY, capture_content=False)
    processor = hue._span_processor
    span = hue.tracer.start_span("agent.run")
    assert processor._live
    held, release = Event(), Event()

    def parent_thread():
        # At fork time another thread holds the lock; the child inherits it held.
        with processor._condition:
            held.set()
            release.wait(5)

    holder = Thread(target=parent_thread, daemon=True)
    holder.start()
    assert held.wait(5)
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            pid = os.fork()
        if pid == 0:
            signal.alarm(3)
            try:
                span.end()
                hue.tracer.start_span("child-work").end()
            except BaseException:
                os._exit(1)
            os._exit(0)
        _, status = os.waitpid(pid, 0)
        assert os.waitstatus_to_exitcode(status) == 0
    finally:
        release.set()
        holder.join(5)
    try:
        span.end()
        assert hue.force_flush()
        _, real = split_placeholders(receiver)
        assert list(real) == ["agent.run"]
    finally:
        hue.shutdown()


@pytest.mark.skipif(not hasattr(os, "fork"), reason="POSIX fork regression")
def test_a_fork_waits_for_a_live_attribute_copy_so_the_child_never_inherits_a_held_span_lock():
    from hue_sdk.snapshots import _live_attributes

    copying, finish = Event(), Event()

    class OpenSpan:
        _lock = Lock()

        @property
        def attributes(self) -> dict[str, str]:
            copying.set()
            finish.wait(5)
            return {"gen_ai.operation.name": "chat"}

    span = OpenSpan()
    copier = Thread(target=_live_attributes, args=(span,), daemon=True)
    copier.start()
    assert copying.wait(5)
    child: list[int] = []
    forked = Event()

    def fork() -> None:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            pid = os.fork()
        if pid == 0:
            # Acquirable in the child: the copy had finished before the fork went ahead.
            os._exit(0 if OpenSpan._lock.acquire(timeout=2) else 1)
        child.append(pid)
        forked.set()

    forker = Thread(target=fork, daemon=True)
    forker.start()
    try:
        # The copy still holds the span lock, so the fork waits for it.
        assert not forked.wait(0.3)
    finally:
        finish.set()
    copier.join(5)
    assert forked.wait(5)
    forker.join(5)
    _, status = os.waitpid(child[0], 0)
    assert os.waitstatus_to_exitcode(status) == 0


def test_placeholder_copies_attributes_consistently_while_the_span_changes():
    from hue_sdk.snapshots import snapshot_pending_span

    provider = TracerProvider(span_limits=SpanLimits(max_span_attributes=8), shutdown_on_exit=False)
    span = provider.get_tracer("customer").start_span(
        "chat", attributes={"gen_ai.operation.name": "chat"}
    )
    # Fill the span to its limit first, so every snapshot sees eight attributes: taken before the
    # writer caught up, a snapshot would rightly copy fewer.
    span.set_attributes({f"custom.{index}": index for index in range(7)})
    assert len(span.attributes) == 8
    stop = Event()

    def application_thread():
        index = 0
        while not stop.is_set():
            # At the attribute limit, each new key evicts the oldest one.
            span.set_attribute(f"custom.{index % 64}", index)
            index += 1

    writer = Thread(target=application_thread, daemon=True)
    switch_interval = sys.getswitchinterval()
    sys.setswitchinterval(1e-6)
    writer.start()
    try:
        for _ in range(3000):
            placeholder = snapshot_pending_span(span)
            assert len(placeholder.attributes) == 9
            assert placeholder.attributes["hue.span_type"] == "pending_span"
    finally:
        stop.set()
        writer.join()
        sys.setswitchinterval(switch_interval)
        span.end()
        provider.shutdown()
