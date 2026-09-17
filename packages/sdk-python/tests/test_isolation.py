"""Regression tests also copied to an isolated installed-wheel consumer."""

from __future__ import annotations

import asyncio
import os
import signal
import time
import warnings
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Event, Thread

import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import SpanProcessor, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from hue_sdk import Hue, create_hue_safe

KEY = "synthetic-isolation-key"


def test_invalid_content_and_redactor_preserve_result_and_run_once(receiver):
    def failure(*_):
        raise ValueError("sensitive-redactor-value")

    for redactor in (None, failure):
        hue = Hue(receiver.url, KEY, capture_content=True, redactor=redactor)
        executed = []
        result = object()

        def business(hue=hue, executed=executed, result=result):
            with hue.span("business") as run:
                run.set_input("x" * 262_144)
                with hue.tool("effect") as span:
                    executed.append("once")
                    span.set_output(object())
                    span.log_inference(output={"invalid": float("nan")})
                    return result

        assert business() is result
        assert executed == ["once"]
        assert not hue.force_flush()
        assert hue.export_status.instrumentation_failures == 3
        hue.shutdown()
    bodies = b"".join(body for _, _, body in receiver.requests)
    assert b"sensitive-redactor-value" not in bodies
    assert len(receiver.spans()) == 4


@pytest.mark.parametrize("error", [RuntimeError("business-failure"), asyncio.CancelledError()])
def test_broken_otel_setup_cleanup_and_logging_preserve_original_error(receiver, error):
    class BrokenProcessor(SpanProcessor):
        def on_start(self, span, parent_context=None):
            if span.name == "setup":
                raise RuntimeError("bad instrumentation setup")

        def on_end(self, span):
            raise RuntimeError("bad instrumentation cleanup")

    provider = TracerProvider(shutdown_on_exit=False)
    provider.add_span_processor(BrokenProcessor())
    hue = Hue(receiver.url, KEY, capture_content=True, tracer_provider=provider)
    for name in ("setup", "cleanup"):
        executed = []
        with pytest.raises(type(error)) as caught:
            with hue.span(name) as span:
                executed.append("once")
                span.set_input(object())
                raise error
        assert caught.value is error
        assert executed == ["once"]
        assert trace.get_current_span() is trace.INVALID_SPAN
    assert not hue.shutdown_safe()
    provider.shutdown()


def test_disabled_and_failed_initialization_are_noop_without_network_or_redaction(receiver):
    def forbidden(*_):
        raise AssertionError("disabled client ran redactor")

    provider = TracerProvider(shutdown_on_exit=False)
    memory = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(memory))
    disabled = Hue(
        enabled=False, capture_content=True, redactor=forbidden, tracer_provider=provider
    )
    fallback = create_hue_safe(api_key="bad key", capture_content=True)
    assert disabled.export_status.ok
    assert not fallback.export_status.ok
    assert fallback.export_status.instrumentation_failures == 1
    for hue in (disabled, fallback):
        with hue:
            with hue.context(session_id="disabled"), hue.model("m", provider="p") as span:
                span.set_input("private")
                span.set_output(object())
                span.log_inference(output="private")
                assert span.trace_id == "0" * 32
            with hue.tool("effect"):
                pass
        assert not hue.enabled
        hue.logger_provider.get_logger("disabled").emit(body="omitted")
        with pytest.raises(RuntimeError, match="shut down|disabled"):
            hue.validate_project()
    with provider.get_tracer("external").start_as_current_span("unaffected"):
        pass
    provider.shutdown()
    assert len(memory.get_finished_spans()) == 1
    assert receiver.requests == []


@pytest.mark.parametrize("signal", ["traces", "logs"])
@pytest.mark.parametrize("limit", ["records", "bytes"])
def test_saturation_reports_exact_drops_and_inflight_budget(receiver, signal, limit):
    receiver.delay_seconds = 0.2
    options = {"max_queue_size": 4} if limit == "records" else {"max_queue_bytes": 16_000}
    hue = Hue(receiver.url, KEY, capture_content=True, **options)
    try:
        # Start an HTTP export then flood the queue while the receiver is delayed.
        with hue.span("first") as span:
            if signal == "logs":
                span.log_inference(output="x" * 8_000)
        assert not hue.force_flush(timeout_millis=5)
        for index in range(12):
            with hue.span(f"span-{index}") as span:
                if signal == "traces":
                    span.set_output("x" * 8_000)
                else:
                    span.log_inference(output="x" * 8_000)
        status = hue.export_status
        drops = status.dropped_trace_records if signal == "traces" else status.dropped_log_records
        assert drops > 0
        assert status.queued_trace_bytes <= options.get("max_queue_bytes", 8 * 1024 * 1024)
        assert status.queued_log_bytes <= options.get("max_queue_bytes", 8 * 1024 * 1024)
        assert status.queued_trace_records <= options.get("max_queue_size", 2048)
        assert status.queued_log_records <= options.get("max_queue_size", 2048)
        assert not hue.force_flush(timeout_millis=3000)
        status = hue.export_status
        assert status.queued_trace_records == status.queued_log_records == 0
        assert status.queued_trace_bytes == status.queued_log_bytes == 0
        delivered = len(receiver.spans()) if signal == "traces" else len(receiver.logs())
        assert delivered + drops == 13
        assert not status.ok
    finally:
        hue.shutdown()


@pytest.mark.parametrize("status", [429, 503])
def test_retry_after_is_obeyed_and_does_not_repeat_business(receiver, status):
    receiver.reply(status, **{"Retry-After": "0"})
    hue = Hue(receiver.url, KEY, capture_content=False)
    executed = []
    with hue.span("once"):
        executed.append("once")
    assert hue.force_flush()
    assert len(receiver.requests) == 2
    assert receiver.requests[0][2] == receiver.requests[1][2]
    assert executed == ["once"]
    assert hue.shutdown()


def test_outage_and_safe_cleanup_keep_original_application_exception(receiver):
    for _ in range(10):
        receiver.reply(503, **{"Retry-After": "20"})
    hue = Hue(receiver.url, KEY, capture_content=False, export_timeout_seconds=0.1)
    original = RuntimeError("original")
    with pytest.raises(RuntimeError) as caught:
        try:
            with hue.span("failed-request"):
                raise original
        finally:
            assert not hue.shutdown_safe()
    assert caught.value is original
    assert hue.export_status.failed_trace_batches == 1
    assert not hue.force_flush_safe(timeout_millis=-1)
    assert not hue.shutdown_safe(timeout_millis=-1)


def test_oversized_ack_is_bounded_and_not_retried(receiver):
    receiver.reply(200, b"x" * 70_000)
    hue = Hue(receiver.url, KEY, capture_content=False)
    with hue.span("large-ack"):
        pass
    assert not hue.force_flush()
    assert hue.export_status.failed_trace_batches == 1
    assert len(receiver.requests) == 1
    hue.shutdown()


def test_trickling_http_does_not_extend_deadline_or_spawn_unbounded_requests():
    started = Event()
    release = Event()
    calls = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers["Content-Length"]))
            calls.append(1)
            self.send_response(200)
            self.send_header("Content-Length", "10000")
            self.end_headers()
            started.set()
            try:
                while not release.wait(0.01):
                    self.wfile.write(b"x")
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = Thread(target=server.serve_forever, daemon=True)
    worker.start()
    hue = Hue(
        f"http://127.0.0.1:{server.server_port}",
        KEY,
        capture_content=False,
        export_timeout_seconds=0.1,
    )
    try:
        start = time.monotonic()
        with hue.span("trickle"):
            pass
        assert not hue.force_flush(timeout_millis=1000)
        assert started.is_set()
        assert time.monotonic() - start < 0.5
        for _ in range(5):
            with hue.span("busy"):
                pass
            assert not hue.force_flush(timeout_millis=500)
        assert len(calls) == 1
        assert not hue.shutdown_safe()
    finally:
        release.set()
        hue.shutdown_safe()
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)


def _emit_isolation_record(hue, signal, name, *, large=False):
    attributes = {"content": "x" * 600_000} if large else {}
    if signal == "traces":
        with hue.span(name):
            trace.get_current_span().set_attributes(attributes)
    else:
        hue.logger_provider.get_logger("external").emit(body=name, attributes=attributes)


@pytest.mark.parametrize("signal", ["traces", "logs"])
@pytest.mark.parametrize("shutdown", [False, True])
def test_busy_http_worker_retains_queue_until_recovery_or_accounted_shutdown(
    receiver, monkeypatch, signal, shutdown
):
    from hue_sdk.transport import MAX_REQUEST_BYTES, SafeSession

    started, release, completed = Event(), Event(), Event()
    calls = []
    original_request = SafeSession._request

    def blocked_request(session, method, url, **kwargs):
        if session.signal != signal:
            return original_request(session, method, url, **kwargs)
        calls.append(1)
        if len(calls) == 1:
            started.set()
            try:
                assert release.wait(10), "test did not release the blocked HTTP worker"
                return original_request(session, method, url, **kwargs)
            finally:
                completed.set()
        return original_request(session, method, url, **kwargs)

    monkeypatch.setattr(SafeSession, "_request", blocked_request)
    hue = Hue(
        receiver.url, KEY, capture_content=False, export_timeout_seconds=0.3, max_queue_size=3
    )
    processor = hue._span_processor if signal == "traces" else hue._log_processor
    try:
        _emit_isolation_record(hue, signal, "ambiguous")
        assert not hue.force_flush(timeout_millis=1500)
        assert started.is_set() and not completed.is_set()
        assert processor._exporter.failures == 1
        for index in range(3):
            # Each record fits one request, but a batch of all three would not.
            _emit_isolation_record(hue, signal, f"retained-{index}", large=True)
        _emit_isolation_record(hue, signal, "overflow")
        assert not hue.force_flush(timeout_millis=30)
        drops, pending, size = processor.status
        assert (drops, pending) == (1, 3)
        assert MAX_REQUEST_BYTES < size <= 8 * 1024 * 1024
        assert processor._exporter.failures == 1
        assert len(calls) == 1

        if shutdown:
            start = time.monotonic()
            assert not hue.shutdown_safe(timeout_millis=500)
            assert time.monotonic() - start < 1
            assert processor.status == (4, 0, 0)
            assert len(calls) == 1
            release.set()
            assert completed.wait(2)
        else:
            release.set()
            assert not hue.force_flush(timeout_millis=3000)  # The earlier failure remains visible.
            assert processor.status == (1, 0, 0)
            assert processor._exporter.failures == 1
            assert len(calls) == 4

        records = receiver.spans() if signal == "traces" else receiver.logs()
        names = [
            record.name if signal == "traces" else record.body.string_value for record in records
        ]
        expected = (
            ["ambiguous"] if shutdown else ["ambiguous", *(f"retained-{i}" for i in range(3))]
        )
        assert names == expected  # The timed-out batch is never replayed.
        assert all(len(body) <= MAX_REQUEST_BYTES for _, _, body in receiver.requests)
    finally:
        release.set()
        hue.shutdown_safe()


@pytest.mark.parametrize("signal", ["traces", "logs"])
def test_flush_waits_for_snapshot_admission_racing_shutdown(receiver, monkeypatch, signal):
    hue = Hue(receiver.url, KEY, capture_content=False, max_queue_size=1)
    processor = hue._span_processor if signal == "traces" else hue._log_processor
    original_snapshot = processor._snapshot
    started, release = Event(), Event()
    errors = []

    def paused_snapshot(item):
        started.set()
        assert release.wait(5), "test did not release snapshot admission"
        return original_snapshot(item)

    def emit():
        try:
            _emit_isolation_record(hue, signal, "racing-shutdown")
        except BaseException as error:
            errors.append(error)

    monkeypatch.setattr(processor, "_snapshot", paused_snapshot)
    emitter = Thread(target=emit, daemon=True)
    emitter.start()
    try:
        assert started.wait(1)
        assert processor.status == (0, 1, 0)
        processor.stop_accepting()
        assert not processor.force_flush(timeout_millis=10)
        assert not hue.force_flush(timeout_millis=10)
        release.set()
        emitter.join(timeout=2)
        assert not emitter.is_alive() and not errors
        assert processor.status == (1, 0, 0)
        assert not hue.force_flush(timeout_millis=1000)
        assert not hue.shutdown_safe()
        assert receiver.requests == []
    finally:
        release.set()
        emitter.join(timeout=2)
        hue.shutdown_safe()


@pytest.mark.skipif(not hasattr(os, "fork"), reason="POSIX fork regression")
def test_inherited_client_is_noop_and_does_not_wait_on_parent_locks(receiver):
    hue = Hue(receiver.url, KEY, capture_content=False)
    # Simulate forking while another parent thread owns these locks.
    hue._flush_lock.acquire()
    hue._issues_lock.acquire()
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            pid = os.fork()
        if pid == 0:
            signal.alarm(3)
            try:
                with hue.span("inherited"):
                    pass
                assert not hue.export_status.ok
                assert not hue.force_flush_safe()
                assert not hue.shutdown_safe()
            except BaseException:
                os._exit(1)
            os._exit(0)
        _, status = os.waitpid(pid, 0)
        assert os.waitstatus_to_exitcode(status) == 0
    finally:
        hue._issues_lock.release()
        hue._flush_lock.release()
        hue.shutdown()
    assert receiver.requests == []


def test_shutdown_worker_failure_does_not_reactivate_closed_processors(receiver, monkeypatch):
    import hue_sdk.client as client_module

    class UnavailableThread:
        def __init__(self, **kwargs):
            pass

        def start(self):
            raise RuntimeError("synthetic worker exhaustion")

    hue = Hue(receiver.url, KEY, capture_content=False)
    monkeypatch.setattr(client_module, "Thread", UnavailableThread)
    assert not hue.shutdown_safe()
    assert not hue.export_status.ok
    assert hue.export_status.instrumentation_failures == 1
    with hue.span("after-shutdown"):
        pass
    assert hue.export_status.queued_trace_records == 0
    assert not hue.shutdown_safe()


def test_queued_log_owns_nested_body_and_attributes_after_emit(receiver):
    from opentelemetry.exporter.otlp.proto.common._log_encoder import encode_logs
    from opentelemetry.sdk._logs import LogRecordProcessor

    class RetainRecord(LogRecordProcessor):
        def on_emit(self, log_record):
            self.record = log_record.log_record

        def shutdown(self):
            pass

        def force_flush(self, timeout_millis=30000):
            return True

    hue = Hue(receiver.url, KEY, capture_content=False, max_queue_bytes=2048)
    retain = RetainRecord()
    hue.logger_provider.add_log_record_processor(retain)
    body = {"nested": ["before"]}
    hue.logger_provider.get_logger("external").emit(
        body=body, attributes={"nested": {"values": ["before"]}}
    )
    admitted_bytes = hue.export_status.queued_log_bytes
    assert 0 < admitted_bytes <= 2048
    body["nested"][0] = "x" * 100_000
    retain.record.attributes["nested"] = {"values": ["y" * 100_000]}
    queued = hue._log_processor._queue[0][0]
    assert encode_logs((queued,)).ByteSize() == admitted_bytes
    assert hue.export_status.queued_log_bytes == admitted_bytes
    assert hue.force_flush()
    assert hue.shutdown()
    log = receiver.logs()[0]
    assert log.body.kvlist_value.values[0].value.array_value.values[0].string_value == "before"
    nested = next(attribute.value for attribute in log.attributes if attribute.key == "nested")
    assert nested.kvlist_value.values[0].value.array_value.values[0].string_value == "before"
    assert all(len(payload) <= 2048 for _, _, payload in receiver.requests)


def test_queued_span_owns_attributes_events_links_and_preserves_drop_counts(receiver):
    from opentelemetry.attributes import BoundedAttributes
    from opentelemetry.exporter.otlp.proto.common.trace_encoder import encode_spans
    from opentelemetry.sdk.trace import Event, ReadableSpan
    from opentelemetry.trace import Link, SpanContext, TraceFlags

    context = SpanContext(1, 2, False, TraceFlags(1))
    values = ["before"]
    attributes = {"values": values}
    event_attributes = BoundedAttributes(attributes={"event": "before"})
    event_attributes.dropped = 3
    span = ReadableSpan(
        name="external",
        context=context,
        attributes=attributes,
        events=(Event("event", event_attributes, 1),),
        links=(Link(context, attributes),),
        start_time=1,
        end_time=2,
    )
    hue = Hue(receiver.url, KEY, capture_content=False, max_queue_bytes=2048)
    hue._span_processor.on_end(span)
    admitted_bytes = hue.export_status.queued_trace_bytes
    values[0] = "x" * 100_000
    attributes["new-field"] = "after"
    queued = hue._span_processor._queue[0][0]
    assert encode_spans((queued,)).ByteSize() == admitted_bytes
    assert queued.resource is not span.resource
    assert hue.force_flush()
    assert hue.shutdown()
    stored = receiver.spans()[0]
    assert stored.attributes[0].value.array_value.values[0].string_value == "before"
    assert len(stored.attributes) == 1
    assert stored.events[0].dropped_attributes_count == 3
    assert stored.links[0].attributes[0].value.array_value.values[0].string_value == "before"


def test_recursive_log_body_is_dropped_without_traversing_application_graph(receiver):
    body = []
    body.append(body)
    hue = Hue(receiver.url, KEY, capture_content=False)
    hue.logger_provider.get_logger("external").emit(body=body)
    assert hue.export_status.dropped_log_records == 1
    assert hue.export_status.queued_log_bytes == 0
    assert not hue.force_flush()
    assert not hue.shutdown()
    assert receiver.requests == []
