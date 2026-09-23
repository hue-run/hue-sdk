"""Owned, bounded processors using OpenTelemetry's public processor interfaces.

The byte budget measures encoded OTLP records including resource/scope overhead;
it is not a promise about the Python interpreter's total resident memory.

Live spans: the span processor remembers qualifying spans at start. While any are
remembered, its worker wakes at least every 0.5 s, queues one advisory placeholder per span
still open and forgets it. Placeholders use at most a quarter of the export queue and are
never counted as dropped or failed; one whose span has ended by export time is discarded.
"""

from __future__ import annotations

import os
from collections import deque
from collections.abc import Callable
from threading import Condition, Thread
from time import monotonic
from typing import Any

from opentelemetry.context import attach, detach
from opentelemetry.sdk._logs import LogRecordProcessor, ReadWriteLogRecord
from opentelemetry.sdk.trace import SpanProcessor

from ._otel_compat import export_context, instrumentation_suppressed
from .snapshots import snapshot_log, snapshot_pending_span, snapshot_span
from .transport import MAX_BATCH_BYTES, PendingSpan

# The instrumentation scope of ``Hue.tracer``; its spans are always announced while open.
HUE_TRACER_SCOPE = "hue-run"
LIVE_SPAN_LIMIT = 1024
LIVE_SPAN_INTERVAL_SECONDS = 0.5
# Lets start-time helper input (``set_input`` just after entering) reach the placeholder.
LIVE_SPAN_MIN_AGE_SECONDS = 0.1
# Kept narrow on purpose: common customer processors export only these spans, and a
# placeholder whose real span is filtered later would read as running until Hue marks it
# stalled.
_AI_ATTRIBUTE_PREFIXES = ("gen_ai.", "ai.", "llm.", "traceloop.")


class _BoundedProcessor:
    _snapshot: Callable[[Any, bool], Any]

    def __init__(
        self,
        exporter: Any,
        encode: Callable[[Any], Any],
        max_records: int,
        max_bytes: int,
        capture_content: bool = True,
    ) -> None:
        self._pid = os.getpid()
        self._capture_content = capture_content
        self._exporter = exporter
        self._encode = encode
        self._max_records = max_records
        self._max_bytes = max_bytes
        self._condition = Condition()
        self._queue: deque[tuple[Any, int]] = deque()
        self._pending_records = 0
        self._pending_bytes = 0
        self._admissions = 0
        self._dropped = 0
        self._closed = False
        self._flush_requested = False
        self._worker = Thread(target=self._run, name="hue-export", daemon=True)
        self._worker.start()

    @property
    def status(self) -> tuple[int, int, int]:
        with self._condition:
            return self._dropped, self._pending_records + self._admissions, self._pending_bytes

    def _enqueue(self, item: Any) -> None:
        if self._pid != os.getpid():
            return
        admitted = False
        try:
            if instrumentation_suppressed():
                return
            # Reject oversized/invalid records before retaining them. The budget
            # includes in-flight records, so a stalled receiver cannot grow it.
            with self._condition:
                if self._closed:
                    self._dropped += 1
                    return
                if self._pending_records + self._admissions >= self._max_records:
                    self._dropped += 1
                    return
                # Reserve a record slot before snapshotting outside the lock.
                # Flush must also wait for this admission to finish or be dropped.
                self._admissions += 1
                admitted = True
            item = self._snapshot(item, self._capture_content)
            size = self._encode((item,)).ByteSize()
            with self._condition:
                # Transfer the reservation into the queue (or drop accounting)
                # atomically, without briefly counting one record twice.
                self._admissions -= 1
                admitted = False
                self._condition.notify_all()
                if self._closed:
                    self._dropped += 1
                    return
                if size > MAX_BATCH_BYTES:
                    self._dropped += 1
                    self._exporter.record_failure()
                elif (
                    self._pending_records >= self._max_records
                    or self._pending_bytes + size > self._max_bytes
                ):
                    self._dropped += 1
                else:
                    self._queue.append((item, size))
                    self._pending_records += 1
                    self._pending_bytes += size
                    self._condition.notify_all()
        except Exception:
            with self._condition:
                self._dropped += 1
            self._exporter.record_failure()
        finally:
            if admitted:
                with self._condition:
                    self._admissions -= 1
                    self._condition.notify_all()

    def _advisory(self, item: Any) -> bool:
        return False

    def _tick(self) -> None:
        """Worker-thread hook for advisory records; runs outside the queue lock."""

    def _tick_timeout(self, limit: float | None) -> float | None:
        """Bound a worker wait so the next ``_tick`` is not late. Called under the lock."""
        return limit

    def _prune(self, batch: list[tuple[Any, int]]) -> list[tuple[Any, int]]:
        """Remove advisory records that are no longer useful. Called under the lock."""
        return batch

    def _admit_advisory(self, item: Any) -> None:
        """Queue an owned advisory record only within a quarter of each budget, silently.

        Real records therefore always keep at least three quarters of the queue.
        """
        size = self._encode((item,)).ByteSize()
        with self._condition:
            if (
                self._closed
                or size > MAX_BATCH_BYTES
                or (self._pending_records + self._admissions + 1) * 4 > self._max_records
                or (self._pending_bytes + size) * 4 > self._max_bytes
            ):
                return
            self._queue.append((item, size))
            self._pending_records += 1
            self._pending_bytes += size
            self._condition.notify_all()

    def _run(self) -> None:
        try:
            self._export_loop()
        except Exception:
            self._exporter.record_failure()
            with self._condition:
                self._dropped += self._pending_records - sum(
                    self._advisory(item) for item, _ in self._queue
                )
                self._queue.clear()
                self._pending_records = 0
                self._pending_bytes = 0
                self._closed = True
                self._condition.notify_all()
        finally:
            try:
                self._exporter.shutdown()
            except Exception:
                self._exporter.record_failure()

    def _export_loop(self) -> None:
        next_export = monotonic() + 1
        while True:
            self._tick()
            with self._condition:
                if not self._queue:
                    if self._closed:
                        return
                    self._condition.wait(self._tick_timeout(None))
                    next_export = monotonic() + 1
                    continue
                if (
                    not self._closed
                    and not self._flush_requested
                    and len(self._queue) < 64
                    and monotonic() < next_export
                ):
                    self._condition.wait(self._tick_timeout(max(0, next_export - monotonic())))
                    continue
                if not self._exporter.ready:
                    # A timed-out request can still own the single HTTP worker.
                    # Keep later records queued until it finishes; never replay
                    # the ambiguous batch or create additional network workers.
                    if self._closed:
                        self._dropped += sum(not self._advisory(item) for item, _ in self._queue)
                        self._pending_records -= len(self._queue)
                        self._pending_bytes -= sum(size for _, size in self._queue)
                        self._queue.clear()
                        self._condition.notify_all()
                        return
                    self._condition.wait(timeout=0.1)
                    continue
                batch: list[Any] = []
                batch_bytes = 0
                while self._queue and len(batch) < 64:
                    size = self._queue[0][1]
                    if batch_bytes + size > MAX_BATCH_BYTES:
                        break
                    batch.append(self._queue.popleft())
                    batch_bytes += size
                # Per-record encodings include resource/scope overhead, so this
                # conservative sum keeps each export within one HTTP request.
                kept = self._prune(batch)
                if len(kept) != len(batch):
                    self._pending_records -= len(batch) - len(kept)
                    self._pending_bytes -= batch_bytes - sum(size for _, size in kept)
                    batch = kept
            token = None
            try:
                # Match the OTel SDK exporters' suppression contract. Exporter
                # diagnostics must not feed back into this pipeline.
                token = attach(export_context())
                if batch:
                    self._exporter.export(tuple(item for item, _ in batch))
            except Exception:
                self._exporter.record_failure()
            finally:
                if token is not None:
                    try:
                        detach(token)
                    except Exception:
                        self._exporter.record_failure()
                with self._condition:
                    self._pending_records -= len(batch)
                    self._pending_bytes -= sum(size for _, size in batch)
                    if not self._pending_records and not self._admissions:
                        self._flush_requested = False
                    self._condition.notify_all()
            next_export = monotonic() + 1

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        if self._pid != os.getpid():
            return False
        deadline = monotonic() + timeout_millis / 1000
        with self._condition:
            self._flush_requested = True
            self._condition.notify_all()
            while self._pending_records or self._admissions:
                remaining = deadline - monotonic()
                if remaining <= 0:
                    return False
                self._condition.wait(remaining)
            self._flush_requested = False
            return not self._dropped and not self._exporter.failures

    def stop_accepting(self) -> None:
        if self._pid == os.getpid():
            with self._condition:
                self._closed = True
                self._condition.notify_all()

    def shutdown(self) -> None:
        if self._pid != os.getpid():
            return
        self.stop_accepting()
        self._worker.join(timeout=30)


class _LiveSpan:
    __slots__ = ("span", "seen")

    def __init__(self, span: Any, seen: float) -> None:
        self.span = span
        self.seen = seen


class BoundedSpanProcessor(_BoundedProcessor, SpanProcessor):
    _snapshot = staticmethod(snapshot_span)

    def __init__(
        self,
        exporter: Any,
        encode: Callable[[Any], Any],
        max_records: int,
        max_bytes: int,
        capture_content: bool = True,
        *,
        live_spans: bool = False,
    ) -> None:
        # Set before the worker starts; it reads these on every loop.
        self._live_spans = live_spans
        self._live: dict[int, _LiveSpan] = {}
        self._next_tick = 0.0
        super().__init__(exporter, encode, max_records, max_bytes, capture_content)

    @property
    def _live_active(self) -> bool:
        return self._live_spans and not self._exporter.live_spans_rejected

    def _announces(self, span: Any) -> bool:
        scope = span.instrumentation_scope
        if scope is not None and scope.name == HUE_TRACER_SCOPE:
            return True
        if isinstance(span.name, str) and span.name.startswith("ai."):
            return True
        return any(
            isinstance(key, str) and key.startswith(_AI_ATTRIBUTE_PREFIXES)
            for key in span.attributes or ()
        )

    def on_start(self, span: Any, parent_context: Any = None) -> None:
        if self._pid != os.getpid() or not self._live_spans:
            return
        try:
            if not self._live_active:
                return
            context = span.context
            if not (context and context.trace_flags.sampled and span.is_recording()):
                return
            if instrumentation_suppressed() or not self._announces(span):
                return
            now = monotonic()
            with self._condition:
                if self._closed or len(self._live) >= LIVE_SPAN_LIMIT:
                    return
                if not self._live:
                    self._next_tick = now + LIVE_SPAN_INTERVAL_SECONDS
                    self._condition.notify_all()
                self._live[context.span_id] = _LiveSpan(span, now)
        except Exception:
            # Live spans are advisory and never affect the application or counters.
            pass

    def on_end(self, span: Any) -> None:
        # A forked child may inherit the lock held by a parent thread that no longer exists.
        if self._pid != os.getpid():
            return
        if self._live:
            try:
                with self._condition:
                    self._live.pop(span.context.span_id, None)
            except Exception:
                pass
        if span.context and span.context.trace_flags.sampled:
            self._enqueue(span)

    def _advisory(self, item: Any) -> bool:
        return isinstance(item, PendingSpan)

    def _tick(self) -> None:
        if not self._live:
            return
        due: list[Any] = []
        try:
            now = monotonic()
            with self._condition:
                if now < self._next_tick:
                    return
                if self._closed or not self._live_active:
                    # Closed, or the receiver rejected placeholders: stop for this client.
                    self._live_spans = False
                    self._live.clear()
                    return
                next_tick = now + LIVE_SPAN_INTERVAL_SECONDS
                for span_id, entry in list(self._live.items()):
                    if entry.span.end_time is not None:
                        # Ended without on_end reaching Hue, e.g. a wrapper filtered it.
                        del self._live[span_id]
                    elif now - entry.seen >= LIVE_SPAN_MIN_AGE_SECONDS:
                        # Announced once, then forgotten: a span that never ends must not
                        # stay referenced, keep the worker waking or hold a tracking slot.
                        del self._live[span_id]
                        due.append(entry.span)
                    else:
                        next_tick = min(next_tick, entry.seen + LIVE_SPAN_MIN_AGE_SECONDS)
                self._next_tick = next_tick
        except Exception:
            # An unexpected span type must never stall or spin the export worker.
            with self._condition:
                self._live_spans = False
                self._live.clear()
            return
        # Copy, trim and size on this worker, never in the application's on_start.
        for span in due:
            try:
                placeholder = snapshot_pending_span(span, self._capture_content)
                if span.end_time is None:
                    self._admit_advisory(placeholder)
            except Exception:
                # Unsupported or over-budget attributes skip this announcement silently.
                pass

    def _tick_timeout(self, limit: float | None) -> float | None:
        if not self._live:
            return limit
        remaining = max(0.0, self._next_tick - monotonic())
        return remaining if limit is None else min(limit, remaining)

    def _prune(self, batch: list[tuple[Any, int]]) -> list[tuple[Any, int]]:
        # An ended span's real record is in this batch, still queued, already sent or
        # filtered out; either way its placeholder would only announce stale state.
        live = self._live_active
        return [
            (item, size)
            for item, size in batch
            if not isinstance(item, PendingSpan) or (live and item.source.end_time is None)
        ]


class BoundedLogProcessor(_BoundedProcessor, LogRecordProcessor):
    _snapshot = staticmethod(snapshot_log)

    def on_emit(self, log_record: ReadWriteLogRecord) -> None:
        self._enqueue(log_record)
