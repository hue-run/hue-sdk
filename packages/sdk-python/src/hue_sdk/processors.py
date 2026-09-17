"""Owned, bounded processors using OpenTelemetry's public processor interfaces.

The byte budget measures encoded OTLP records including resource/scope overhead;
it is not a promise about the Python interpreter's total resident memory.
"""

from __future__ import annotations

import os
from collections import deque
from collections.abc import Callable
from threading import Condition, Thread
from time import monotonic
from typing import Any

from opentelemetry.sdk._logs import LogRecordProcessor, ReadWriteLogRecord
from opentelemetry.sdk.trace import SpanProcessor

from .snapshots import snapshot_log, snapshot_span
from .transport import MAX_REQUEST_BYTES


class _BoundedProcessor:
    def __init__(self, exporter: Any, encode: Callable, max_records: int, max_bytes: int):
        self._pid = os.getpid()
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
            # Reject oversized/invalid records before retaining them. The budget
            # includes in-flight records, so a stalled receiver cannot grow it.
            with self._condition:
                if self._closed:
                    return
                if self._pending_records + self._admissions >= self._max_records:
                    self._dropped += 1
                    return
                # Reserve a record slot before snapshotting outside the lock.
                # Flush must also wait for this admission to finish or be dropped.
                self._admissions += 1
                admitted = True
            item = self._snapshot(item)
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
                if size > MAX_REQUEST_BYTES:
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

    def _run(self) -> None:
        try:
            self._export_loop()
        except Exception:
            self._exporter.record_failure()
            with self._condition:
                self._dropped += self._pending_records
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
            with self._condition:
                while not self._queue:
                    if self._closed:
                        return
                    self._condition.wait()
                    next_export = monotonic() + 1
                while (
                    not self._closed
                    and not self._flush_requested
                    and len(self._queue) < 64
                    and monotonic() < next_export
                ):
                    self._condition.wait(max(0, next_export - monotonic()))
                if not self._exporter.ready:
                    # A timed-out request can still own the single HTTP worker.
                    # Keep later records queued until it finishes; never replay
                    # the ambiguous batch or create additional network workers.
                    if self._closed:
                        self._dropped += len(self._queue)
                        self._pending_records -= len(self._queue)
                        self._pending_bytes -= sum(size for _, size in self._queue)
                        self._queue.clear()
                        self._condition.notify_all()
                        return
                    self._condition.wait(timeout=0.1)
                    continue
                batch = []
                batch_bytes = 0
                while self._queue and len(batch) < 64:
                    size = self._queue[0][1]
                    if batch_bytes + size > MAX_REQUEST_BYTES:
                        break
                    batch.append(self._queue.popleft())
                    batch_bytes += size
                # Per-record encodings include resource/scope overhead, so this
                # conservative sum keeps each export within one HTTP request.
            try:
                self._exporter.export(tuple(item for item, _ in batch))
            except Exception:
                self._exporter.record_failure()
            finally:
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


class BoundedSpanProcessor(_BoundedProcessor, SpanProcessor):
    _snapshot = staticmethod(snapshot_span)

    def on_start(self, span: Any, parent_context: Any = None) -> None:
        pass

    def on_end(self, span: Any) -> None:
        if span.context and span.context.trace_flags.sampled:
            self._enqueue(span)


class BoundedLogProcessor(_BoundedProcessor, LogRecordProcessor):
    _snapshot = staticmethod(snapshot_log)

    def on_emit(self, log_record: ReadWriteLogRecord) -> None:
        self._enqueue(log_record)
