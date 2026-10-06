"""Small policy adapters around the official OTLP HTTP/protobuf exporters."""

from __future__ import annotations

import ipaddress
from collections import deque
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from http import HTTPStatus
from math import isfinite
from threading import Event, Lock, Thread
from time import monotonic, time
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import requests
from google.protobuf.message import DecodeError, Message
from opentelemetry.context import attach, detach
from opentelemetry.exporter.otlp.proto.common.trace_encoder import encode_spans
from opentelemetry.exporter.otlp.proto.http import Compression
from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.exporter.otlp.proto.http.version import __version__ as OTLP_EXPORTER_VERSION
from opentelemetry.proto.collector.logs.v1.logs_service_pb2 import ExportLogsServiceResponse
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceResponse
from opentelemetry.sdk._logs import ReadableLogRecord
from opentelemetry.sdk._logs.export import LogRecordExporter, LogRecordExportResult
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult
from opentelemetry.trace import get_current_span

from ._blobs import (
    FALLBACK_MESSAGES,
    Tally,
    Uploads,
    held_of,
    place_spans,
    upload_budget_seconds,
)
from ._limits import BATCH_TARGET_BYTES as BATCH_TARGET_BYTES
from ._limits import DROPPED_RECORDS_KEY as DROPPED_RECORDS_KEY
from ._limits import MAX_CONTENT_BYTES as MAX_CONTENT_BYTES
from ._limits import MAX_DECODED_BYTES as MAX_DECODED_BYTES
from ._limits import MAX_RATE_LIMIT_HOLD_SECONDS as MAX_RATE_LIMIT_HOLD_SECONDS
from ._limits import MAX_REQUEST_BYTES as MAX_REQUEST_BYTES
from ._limits import TRUNCATED_KEY as TRUNCATED_KEY
from ._limits import AdvertisedLimits, fits_without_compression, gzip_size
from ._otel_compat import encode_logs, export_context
from ._records import replace_span, shed_content, sheddable_content
from ._version import __version__

# In-progress span placeholders, which are small, stay 1 KiB short of the default wire limit.
MAX_BATCH_BYTES = MAX_REQUEST_BYTES - 1024
# Per-record allowance for protobuf length prefixes that grow when records are grouped.
RECORD_FRAMING_BYTES = 64
DEFAULT_BASE_URL = "https://app.hue.run"
# The OTLP exporter lets caller headers override its own User-Agent; keep its token after
# Hue's, as the TypeScript transport does.
USER_AGENT = f"hue-sdk-python/{__version__} OTel-OTLP-Exporter-Python/{OTLP_EXPORTER_VERSION}"

# Live-span placeholder markers (Hue's wire contract, versioned by the type value).
PENDING_SPAN_TYPE_KEY = "hue.span_type"
PENDING_SPAN_TYPE = "pending_span"
PENDING_PARENT_KEY = "hue.pending_parent_id"
# Every trace acknowledgement from a receiver that accepts placeholders carries this header
# set to "1". Without it the receiver predates them and rejects each one (end time 0).
PLACEHOLDERS_HEADER = "Hue-Pending-Spans"


def reject_positional_api_key(base_url: object) -> None:
    """Explain a key passed where the origin goes, without echoing the value."""
    if isinstance(base_url, str) and base_url and "://" not in base_url:
        raise TypeError(
            "base_url is the first positional argument and must be an origin such as "
            "https://app.hue.run; pass the project service key as api_key=... instead."
        )


def normalize_base_url(value: str) -> str:
    """Require an origin, HTTPS outside loopback, and no credentials in the URL."""
    if not isinstance(value, str) or any(char.isspace() for char in value):
        raise ValueError("base_url must be an HTTPS origin (HTTP is allowed on loopback).")
    try:
        parsed = urlsplit(value)
        hostname = parsed.hostname
        _ = parsed.port  # Validate without including the original URL in an error.
    except ValueError:
        raise ValueError("base_url contains an invalid host or port.") from None
    if (
        not hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path.strip("/")
        or "\\" in value
    ):
        raise ValueError("base_url must contain only an origin, without credentials or a path.")
    try:
        loopback = ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        loopback = hostname.lower() == "localhost"
    if parsed.scheme != "https" and not (parsed.scheme == "http" and loopback):
        raise ValueError("base_url requires HTTPS except for loopback development servers.")
    return urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))


class PendingSpan(ReadableSpan):
    """An advisory placeholder announcing a still-open span; its end time is 0.

    ``source`` is the live span it announces. It is never exported; the processor uses it
    to drop the placeholder once that span has ended. Placeholders never count as dropped
    or failed telemetry.
    """

    def __init__(self, source: ReadableSpan, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.source = source


@dataclass(frozen=True)
class ExportStatus:
    """Cumulative failed export batches; contains no telemetry or credentials.

    ``live_spans_rejected`` is a warning, not a failure, and does not affect ``ok``: a
    trace acknowledgement lacked the ``Hue-Pending-Spans`` header, so the receiver predates
    live-span placeholders and this client stopped sending them.

    ``uploaded_values`` counts span values over Hue's inline limit uploaded apart from their
    spans (or already stored by Hue), each listed under the span's ``hue.blobs`` with its first
    16 KiB kept inline; ``upload_fallbacks`` counts the ones that could not be uploaded and were
    exported cut to the limit (an inline file as its digest), each reported in a warning issue.
    Neither affects ``ok``.
    """

    failed_trace_batches: int
    failed_log_batches: int
    dropped_trace_records: int = 0
    dropped_log_records: int = 0
    queued_trace_records: int = 0
    queued_log_records: int = 0
    queued_trace_bytes: int = 0
    queued_log_bytes: int = 0
    instrumentation_failures: int = 0
    live_spans_rejected: bool = False
    uploaded_values: int = 0
    upload_fallbacks: int = 0

    @property
    def ok(self) -> bool:
        return not (
            self.failed_trace_batches
            or self.failed_log_batches
            or self.dropped_trace_records
            or self.dropped_log_records
            or self.instrumentation_failures
        )


class SafeSession(requests.Session):
    """Disable redirects and reject partial/malformed OTLP acknowledgements.

    The OTLP HTTP exporters in the supported OpenTelemetry range do not inspect
    partial_success themselves. A rejection is permanent: accepted records must
    not be retried as a whole batch.

    The trace exporter sends finished spans and live-span placeholders in separate requests
    and sets ``placeholders`` before each; a request reads it once it holds the per-signal
    request lock, so a timed-out worker keeps its own count. A request of placeholders is
    advisory: its rejections never fail it. ``live_spans`` says whether the client announces
    spans at all; only then does a trace acknowledgement without the ``Hue-Pending-Spans``
    header set ``live_spans_rejected``.
    """

    def __init__(
        self,
        signal: str | None = None,
        *,
        live_spans: bool = True,
        limits: AdvertisedLimits | None = None,
    ) -> None:
        super().__init__()
        self.signal = signal
        self._request_lock = Lock()
        self.placeholders = 0
        self.live_spans = live_spans
        self.live_spans_rejected = False
        # The receiver's limits, adopted from every OTLP response whatever its status.
        self.limits = limits
        # Why the last request failed, read by the exporter once the request returned:
        # ``"rejected"`` for a partial success from a healthy receiver, ``"rate_limited"`` for a
        # 429 whose Retry-After outlasts the request's deadline, else ``None``.
        self.last_failure: str | None = None
        # With ``"rate_limited"``: how long the receiver asked to wait, in seconds.
        self.rate_limited_for: float | None = None
        # The size of the next request after decompression, set by its exporter.
        self.decoded_bytes = 0

    @property
    def ready(self) -> bool:
        """Whether the owned HTTP worker has released the transport."""
        return not self._request_lock.locked()

    def _over_limits(self, data: Any) -> bool:
        """Whether a request body (gzip-compressed) is over the receiver's current limits on the
        wire, or its exporter's measured size after decompression is over the decoded limit."""
        if self.limits is None or not isinstance(data, (bytes, bytearray)):
            return False
        limits = self.limits.current
        return len(data) > limits.request_bytes or self.decoded_bytes > limits.decoded_bytes

    def request(self, method: str, url: str, **kwargs: Any) -> requests.Response:  # type: ignore[override]
        kwargs["allow_redirects"] = False
        if not self.signal:
            return self._request(method, url, **kwargs)
        # requests' read timeout is inactivity-based. Bound the exporter caller
        # by a wall clock deadline, retaining at most ONE network worker per
        # signal if a peer trickles bytes or a system call cannot be cancelled.
        timeout = kwargs.get("timeout", 10)
        if not isinstance(timeout, (int, float)) or timeout <= 0:
            raise requests.RequestException("Hue telemetry request timed out.")
        self.last_failure = None
        self.rate_limited_for = None
        data = kwargs.get("data")
        if self._over_limits(data):
            # The exporter measures each request first; this never sends one over the limits,
            # including limits the receiver lowered while the request was held.
            self.last_failure = "oversize"
            raise requests.RequestException("Hue telemetry request exceeds the receiver's limit.")
        # ContextVars do not automatically follow work onto a new thread.
        # Preserve OTel suppression in the actual HTTP call, not only its caller.
        suppressed = export_context()
        if not self._request_lock.acquire(blocking=False):
            raise requests.RequestException("Hue telemetry transport is still busy.")
        placeholders = self.placeholders
        completed = Event()
        deadline = monotonic() + timeout
        result: requests.Response | None = None
        failure: Exception | None = None

        def send() -> None:
            nonlocal result, failure
            token = None
            try:
                token = attach(suppressed)
                for attempt in range(6):
                    remaining = deadline - monotonic()
                    if remaining <= 0:
                        raise requests.RequestException("Hue telemetry request timed out.")
                    kwargs["timeout"] = remaining
                    response = self._request(method, url, placeholders=placeholders, **kwargs)
                    # The OTLP HTTP exporters in the supported range do not
                    # honor 429 or Retry-After. Handle them here, without
                    # replaying partial acknowledgements or 4xx errors.
                    retryable = response.status_code in (408, 429) or response.status_code >= 500
                    retry_after = response.headers.get("Retry-After")
                    if not retryable or (response.status_code != 429 and retry_after is None):
                        result = response
                        return
                    delay = _retry_delay(retry_after, attempt)
                    response.close()
                    if (
                        response.status_code == 429
                        and retry_after is not None
                        and delay >= deadline - monotonic()
                    ):
                        # Refused for its rate until later than this request may wait: the
                        # exporter can hold the records for it, still queued.
                        self.last_failure = "rate_limited"
                        self.rate_limited_for = delay
                    if attempt == 5 or delay >= deadline - monotonic():
                        raise requests.RequestException("Hue telemetry retry budget exhausted.")
                    Event().wait(delay)
                    if self._over_limits(data):
                        # A response lowered the limits below this request: it goes back to its
                        # exporter to be split and shed, not retried as it is.
                        self.last_failure = "oversize"
                        raise requests.RequestException(
                            "Hue telemetry request exceeds the receiver's limit."
                        )
                failure = requests.RequestException("Hue telemetry retry budget exhausted.")
            except Exception as error:
                failure = error
            finally:
                if token is not None:
                    try:
                        detach(token)
                    except Exception as error:
                        failure = error
                self._request_lock.release()
                completed.set()

        try:
            Thread(target=send, name="hue-http", daemon=True).start()
        except RuntimeError:
            self._request_lock.release()
            raise requests.RequestException("Hue telemetry worker unavailable.") from None
        if not completed.wait(max(0, deadline - monotonic())):
            raise requests.RequestException("Hue telemetry request timed out.")
        if isinstance(failure, requests.ConnectionError):
            raise requests.ConnectionError("Hue telemetry connection failed.") from None
        if failure is not None or result is None:
            raise requests.RequestException("Hue telemetry request failed.")
        return result

    def _request(
        self, method: str, url: str, *, placeholders: int = 0, **kwargs: Any
    ) -> requests.Response:
        kwargs["allow_redirects"] = False
        if self.signal:
            kwargs["stream"] = True
            self.last_failure = None
        try:
            response = super().request(method, url, **kwargs)
            if self.signal and self.limits is not None:
                try:
                    self.limits.adopt(response.headers)
                except Exception:
                    pass  # Reading advertised limits never fails the request.
            if self.signal:
                # The acknowledgement has no legitimate need for a large body.
                # Bound decompressed bytes, including HTTP error bodies.
                content = bytearray()
                try:
                    for chunk in response.iter_content(chunk_size=4096):
                        content.extend(chunk)
                        if len(content) > 65_536:
                            raise requests.RequestException("Hue OTLP response exceeds its limit.")
                    response._content = bytes(content)
                    response._content_consumed = True  # type: ignore[attr-defined]
                finally:
                    response.close()
        except requests.ConnectionError:
            raise requests.ConnectionError("Hue telemetry connection failed.") from None
        except requests.RequestException:
            raise requests.RequestException("Hue telemetry request failed.") from None
        # Untrusted status reasons and body content must never enter exporter logs.
        try:
            response.reason = HTTPStatus(response.status_code).phrase
        except ValueError:
            response.reason = "HTTP response"
        if 300 <= response.status_code < 400:
            raise requests.RequestException("Hue endpoints do not follow redirects.")
        if self.signal and response.ok:
            if response.status_code != 200:
                raise requests.RequestException("Hue OTLP response must use HTTP 200.")
            rejected = _rejected_records(self.signal, response.content)
            if (
                self.signal == "traces"
                and self.live_spans
                and response.headers.get(PLACEHOLDERS_HEADER) != "1"
            ):
                # A trace acknowledgement without the header comes from a receiver that predates
                # live spans, whatever the request carried: stop announcing them, before any
                # placeholder reaches a receiver that acknowledged finished spans first.
                self.live_spans_rejected = True
            if placeholders:
                # Placeholders travel alone, so a rejection is theirs: advisory, never a failure.
                return response
            if rejected:
                self.last_failure = "rejected"
                raise requests.RequestException("Hue OTLP receiver rejected records.")
        return response


def _rejected_records(signal: str, content: bytes) -> int:
    try:
        if signal == "traces":
            traces = ExportTraceServiceResponse()
            traces.ParseFromString(content)
            return traces.partial_success.rejected_spans
        logs = ExportLogsServiceResponse()
        logs.ParseFromString(content)
        return logs.partial_success.rejected_log_records
    except DecodeError:
        raise requests.RequestException("Hue returned an invalid OTLP response.") from None


def _retry_delay(value: str | None, attempt: int) -> float:
    if value is not None:
        try:
            seconds = float(value)
            if isfinite(seconds):
                return max(0, seconds)
        except ValueError:
            try:
                return max(0, parsedate_to_datetime(value).timestamp() - time())
            except (ValueError, TypeError, OverflowError):
                pass
    return min(2**attempt, 5)


# An issue names at most this many traces; a batch of more names none, and the receipts decide.
MAX_ISSUE_TRACE_IDS = 64
# The issues a client retains; a runner reads the ones younger than its case.
MAX_RETAINED_ISSUES = 256


@dataclass(frozen=True)
class ExportIssue:
    """One export failure or warning, with the traces of the records it concerned.

    ``kind`` is ``failed`` for a batch Hue refused or did not acknowledge, ``dropped`` for a
    record the pipeline could not hold or encode, and ``warning`` for span values over Hue's
    inline limit that could not be uploaded and were exported cut (``count`` is the values): a
    warning is not a failure. ``trace_ids`` names the traces whose records the issue concerned,
    lowercase hexadecimal; ``None`` when the records named none or more than
    ``MAX_ISSUE_TRACE_IDS``, so a case's trace receipt decides. ``sequence`` orders issues across
    both signals; a client's ``export_failure_sequence()`` is the last failure's.
    """

    signal: str
    kind: str
    count: int
    message: str
    sequence: int
    trace_ids: tuple[str, ...] | None


def _record_trace_id(record: Any) -> str | None:
    """The trace a span or log record belongs to, or ``None`` for a record naming none."""
    try:
        if isinstance(record, PendingSpan):
            return None
        context = getattr(record, "context", None)
        if context is None or not hasattr(context, "trace_id"):
            inner = getattr(record, "log_record", record)
            trace_id = getattr(inner, "trace_id", None)
            if trace_id is None:
                inner_context = getattr(inner, "context", None)
                span = get_current_span(inner_context) if inner_context is not None else None
                trace_id = span.get_span_context().trace_id if span is not None else None
        else:
            trace_id = context.trace_id
        if not isinstance(trace_id, int) or trace_id == 0:
            return None
        return format(trace_id, "032x")
    except Exception:
        return None


def trace_ids_of(records: Sequence[Any]) -> tuple[str, ...] | None:
    """The distinct traces of the records, or ``None`` for none or more than the cap."""
    ids: dict[str, None] = {}
    for record in records:
        trace_id = _record_trace_id(record)
        if trace_id is not None:
            ids[trace_id] = None
        if len(ids) > MAX_ISSUE_TRACE_IDS:
            return None
    return tuple(ids) if ids else None


class IssueLedger:
    """The export issues of one client, in order, bounded, shared by both signals."""

    def __init__(self) -> None:
        self._lock = Lock()
        self._sequence = 0
        self._failure_sequence = 0
        self._issues: deque[ExportIssue] = deque(maxlen=MAX_RETAINED_ISSUES)

    def record(
        self,
        signal: str,
        kind: str,
        count: int,
        message: str,
        trace_ids: tuple[str, ...] | None,
    ) -> None:
        with self._lock:
            self._sequence += 1
            if kind != "warning":
                self._failure_sequence = self._sequence
            self._issues.append(
                ExportIssue(signal, kind, max(1, count), message, self._sequence, trace_ids)
            )

    @property
    def failure_sequence(self) -> int:
        """The sequence of the last failure recorded; warnings do not move it."""
        with self._lock:
            return self._failure_sequence

    def issues(self) -> tuple[ExportIssue, ...]:
        with self._lock:
            return tuple(self._issues)


class DroppedRecords:
    """Records of each trace the SDK never sent: dropped from a queue, too large to send without
    their content, or refused for their rate for longer than an export holds them.

    The span exporter writes the count on the trace's root span as ``hue.sdk.dropped_records``
    when the root is exported, so Hue reads the trace as incomplete by that many records; the
    count stays until the request carrying the root is acknowledged. Bounded: a trace whose root
    never arrives (an abandoned run) gives way to newer ones.
    """

    def __init__(self, limit: int = 1024) -> None:
        self._lock = Lock()
        self._limit = limit
        self._counts: dict[str, int] = {}

    def count(self, records: Sequence[Any]) -> None:
        for record in records:
            trace_id = _record_trace_id(record)
            if trace_id is None:
                continue
            with self._lock:
                if trace_id not in self._counts and len(self._counts) >= self._limit:
                    del self._counts[next(iter(self._counts))]
                self._counts[trace_id] = self._counts.get(trace_id, 0) + 1

    def of(self, trace_id: str) -> int:
        with self._lock:
            return self._counts.get(trace_id, 0)

    def consume(self, counts: Mapping[str, int]) -> None:
        """Forget the counts an acknowledged request carried on its roots, and only those: a
        record lost while that request was in flight is still counted."""
        with self._lock:
            for trace_id, count in counts.items():
                left = self._counts.get(trace_id, 0) - count
                if left > 0:
                    self._counts[trace_id] = left
                else:
                    self._counts.pop(trace_id, None)


# A record that cannot be sent even with every content value shed.
OVER_REQUEST_LIMIT = "Hue telemetry record exceeds the receiver's request limit without its content"
# A request the receiver refused for its rate for longer than an export holds its records.
RATE_LIMITED = (
    "Hue limited the telemetry rate for longer than an export holds its records "
    f"({MAX_RATE_LIMIT_HOLD_SECONDS:.0f} s)"
)


class _ReceiverExporter:
    """What both signals' exporters share: requests measured against the receiver's limits,
    records shed to fit them, batches split on the wire, and rate-limited requests held."""

    signal: str
    _session: SafeSession
    _ledger: IssueLedger
    _limits: AdvertisedLimits
    _dropped_records: DroppedRecords
    _encode: Callable[[Sequence[Any]], Message]

    def _setup(
        self,
        ledger: IssueLedger | None,
        limits: AdvertisedLimits | None,
        dropped_records: DroppedRecords | None,
    ) -> None:
        self._ledger = ledger or IssueLedger()
        self._limits = limits or AdvertisedLimits()
        self._dropped_records = dropped_records or DroppedRecords()
        self._failures = 0
        self._lock = Lock()
        # How long the current export has held its records for a rate-limited receiver.
        self._held = 0.0

    @property
    def ready(self) -> bool:
        return self._session.ready

    @property
    def failures(self) -> int:
        with self._lock:
            return self._failures

    def record_failure(
        self, records: Sequence[Any] | None = None, kind: str = "dropped", count: int = 1
    ) -> None:
        """Count a failure the pipeline met outside an export, naming the records' traces."""
        with self._lock:
            self._failures += 1
        self._ledger.record(
            self.signal,
            kind,
            count,
            f"Hue telemetry pipeline could not hold or encode {_NOUNS[self.signal]}",
            trace_ids_of(records) if records else None,
        )

    def _measure(self, records: Sequence[Any]) -> int | None:
        """The encoded size of a request of ``records`` when it fits the receiver's limits (its
        size after decompression, and after gzip on the wire, measured only when it could be
        over), else ``None``."""
        message = self._encode(records)
        size = message.ByteSize()
        limits = self._limits.current
        if size > limits.decoded_bytes:
            return None
        if fits_without_compression(size, limits.request_bytes):
            return size
        if gzip_size(message.SerializePartialToString()) <= limits.request_bytes:
            return size
        return None

    def _fit(self, record: Any) -> tuple[Any, int] | None:
        """The record, shed until a request of it alone fits, and its encoded size; ``None`` when
        no content is left to shed.

        A record over a limit sheds its content values, largest first, each replaced by the
        receiver's marker and listed under ``hue.truncated``: the record and what it still holds
        reach Hue, and a reader sees what was shed. Placeholders are never shed.
        """
        size = self._measure((record,))
        if size is not None:
            return record, size
        if isinstance(record, PendingSpan):
            return None
        sheddable = sheddable_content(record, self.signal)

        def shedding(count: int) -> tuple[Any, int] | None:
            shed = shed_content(record, self.signal, sheddable[:count])
            measured = self._measure((shed,))
            return None if measured is None else (shed, measured)

        # The fewest values to shed are found by trying a doubling count of the largest, then
        # halving the range between the last count that did not fit and the first that did:
        # encodings and compressions logarithmic in the values shed, where shedding one value
        # per encoding took time quadratic in them.
        failed = 0
        fits = 0
        fitted: tuple[Any, int] | None = None
        step = 1
        while fitted is None:
            if failed >= len(sheddable):
                return None
            fits = min(len(sheddable), failed + step)
            fitted = shedding(fits)
            if fitted is None:
                failed = fits
            step *= 2
        while fits - failed > 1:
            middle = (failed + fits) // 2
            result = shedding(middle)
            if result is None:
                failed = middle
            else:
                fits, fitted = middle, result
        return fitted

    def _unsendable(self, record: Any) -> None:
        """A completed record too large without its content: lost, and counted on its root.
        The export that met it fails."""
        self._dropped_records.count((record,))
        self._ledger.record(self.signal, "dropped", 1, OVER_REQUEST_LIMIT, trace_ids_of((record,)))

    def _batches(self, entries: Sequence[tuple[Any, int]]) -> list[list[Any]]:
        """Records grouped to the ordinary target size before gzip; a record larger than it
        travels alone, up to the receiver's limits."""
        target = min(self._limits.current.decoded_bytes, BATCH_TARGET_BYTES)
        batches: list[list[Any]] = []
        batch: list[Any] = []
        size = 0
        for record, record_size in entries:
            framed = record_size + RECORD_FRAMING_BYTES
            if batch and size + framed > target:
                batches.append(batch)
                batch, size = [], 0
            batch.append(record)
            size += framed
        if batch:
            batches.append(batch)
        return batches

    def _requests(self, batch: list[Any], *, refitted: bool = False) -> list[tuple[list[Any], int]]:
        """``batch`` as requests within the receiver's limits, each with its encoded size: in
        halves while it is over them on the wire. A single record over limits the receiver lowered
        after it was measured is shed again; one that still cannot fit is lost."""
        size = self._measure(batch)
        if size is not None:
            return [(batch, size)]
        if len(batch) > 1:
            middle = len(batch) // 2
            return self._requests(batch[:middle]) + self._requests(batch[middle:])
        entry = None if refitted else self._fit(batch[0])
        if entry is None:
            if not isinstance(batch[0], PendingSpan):
                self._unsendable(batch[0])
            return []
        return self._requests([entry[0]], refitted=True)

    def _counted(self, request: list[Any]) -> tuple[list[Any], dict[str, int]]:
        """``request`` with each trace root carrying its trace's dropped-record count as it stands
        now, and the counts carried. Spans only; the default carries none."""
        return request, {}

    def _deliver(self, batch: list[Any], *, advisory: bool = False) -> tuple[bool, bool]:
        """Sends ``batch`` (completed records, or placeholders alone: ``advisory``) in requests
        within the receiver's limits. Returns whether a completed record was lost, and whether
        a request was refused or unanswered rather than acknowledged with rejections.

        Each root carries its trace's dropped-record count as it stands when its request is made,
        so it includes losses this export's earlier requests met, and an acknowledgement consumes
        exactly the counts its request carried. A request the receiver's lowered limits no longer
        admit, measured again with its counts or refused while it was sent or held, is split and
        shed again before it is sent.
        """
        failed = refused = False
        pending: deque[tuple[list[Any], int]] = deque()

        def split(records: list[Any]) -> None:
            nonlocal failed
            parts = self._requests(records)
            if not advisory and sum(len(part) for part, _ in parts) < len(records):
                failed = True
            pending.extendleft(reversed(parts))

        split(batch)
        while pending:
            request, size = pending.popleft()
            # None follows the acknowledgement that turned live spans off.
            if advisory and getattr(self._session, "live_spans_rejected", False):
                break
            carried: dict[str, int] = {}
            if not advisory:
                request, carried = self._counted(request)
                if carried:
                    measured = self._measure(request)
                    if measured is None:
                        split(request)
                        continue
                    size = measured
            outcome = self._send(request, size, placeholders=len(request) if advisory else 0)
            if outcome == "refit":
                split(request)
            elif outcome:
                self._dropped_records.consume(carried)
            elif not advisory:
                failed = True
                if self._session.last_failure != "rejected":
                    refused = True
                # The request Hue refused or did not acknowledge names the traces in it.
                self._refused(request)
        return failed, refused

    def _send(self, batch: Sequence[Any], size: int, *, placeholders: int = 0) -> bool | str:
        """One request of ``size`` bytes before gzip; ``placeholders`` is ``len(batch)`` for a
        request of placeholders. ``"refit"`` when the receiver lowered its limits below the
        request before accepting it.

        A receiver that refuses completed records for their rate (HTTP 429) and asks to be
        retried later than the request's deadline allows gets them again after its Retry-After,
        while the export's hold stays within ``MAX_RATE_LIMIT_HOLD_SECONDS``; the records stay
        queued meanwhile. Placeholders are advisory and never held.
        """
        while True:
            self._session.last_failure = None
            self._session.rate_limited_for = None
            try:
                self._session.placeholders = placeholders
                self._session.decoded_bytes = size
                if self._delegate_export(batch):
                    return True
            except Exception:
                # An exporter that lets the session's refusal through is read like one that
                # returns a failure; anything else leaves no reason and fails the request.
                pass
            if self._session.last_failure == "oversize":
                return "refit"
            wait = self._session.rate_limited_for
            if placeholders or self._session.last_failure != "rate_limited" or wait is None:
                return False
            if self._held + wait > MAX_RATE_LIMIT_HOLD_SECONDS:
                return False
            self._held += wait
            Event().wait(wait)

    def _delegate_export(self, batch: Sequence[Any]) -> bool:
        raise NotImplementedError

    def _refused(self, batch: Sequence[Any]) -> None:
        """Records a request of completed records Hue refused or did not acknowledge."""
        message = f"Hue did not accept a batch of {_NOUNS[self.signal]}"
        if self._session.last_failure == "rate_limited":
            # Hue stored none of them: each counts on its trace's root, as a record never sent.
            self._dropped_records.count(batch)
            message = RATE_LIMITED
        self._ledger.record(self.signal, "failed", len(batch), message, trace_ids_of(batch))


_NOUNS = {"traces": "trace records", "logs": "log records"}


class BoundedSpanExporter(_ReceiverExporter, SpanExporter):
    signal = "traces"

    def __init__(
        self,
        endpoint: str,
        headers: dict[str, str],
        timeout: float,
        ledger: IssueLedger | None = None,
        *,
        live_spans: bool = True,
        limits: AdvertisedLimits | None = None,
        dropped_records: DroppedRecords | None = None,
        uploads: Uploads | None = None,
    ) -> None:
        self._setup(ledger, limits, dropped_records)
        # Uploads of span values over the inline limit; None when the client uploads none.
        self._uploads = uploads
        self._uploaded = 0
        self._upload_fallbacks = 0
        self._session = SafeSession("traces", live_spans=live_spans, limits=self._limits)
        self._delegate = OTLPSpanExporter(
            endpoint=endpoint,
            headers={**headers, "User-Agent": USER_AGENT},
            timeout=timeout,
            compression=Compression.Gzip,
            session=self._session,
        )
        self._encode = encode_spans

    @property
    def live_spans_rejected(self) -> bool:
        return self._session.live_spans_rejected

    @property
    def uploads(self) -> tuple[int, int]:
        """Values uploaded, and values that fell back to the inline cut, so far."""
        with self._lock:
            return self._uploaded, self._upload_fallbacks

    def _wait_for_rate(self, seconds: float) -> bool:
        """Waits out a rate-limited reservation within the export's hold; False when the hold
        may not take ``seconds`` more."""
        with self._lock:
            if self._held + seconds > MAX_RATE_LIMIT_HOLD_SECONDS:
                return False
            self._held += seconds
        Event().wait(seconds)
        return True

    def _place_held(self, spans: list[Any]) -> list[Any]:
        """The spans with the values their copies held for upload placed: uploaded and listed
        under ``hue.blobs``, or cut as before. Every fallback is counted and reported as a
        warning naming its traces; the spans are exported either way."""
        uploads = self._uploads
        holding = [(index, span, held_of(span)) for index, span in enumerate(spans)]
        entries = [(index, span, held) for index, span, held in holding if held is not None]
        if uploads is None or not entries:
            return spans
        placed, tally = place_spans(
            [
                (span.attributes or {}, held, _record_trace_id(span) or "")
                for _, span, held in entries
            ],
            uploader=uploads.uploader,
            value_bytes=self._limits.current.value_bytes,
            deadline=monotonic() + upload_budget_seconds(uploads.timeout),
            wait=self._wait_for_rate,
        )
        result = list(spans)
        for (index, span, held), attributes in zip(entries, placed, strict=True):
            result[index] = replace_span(span, attributes=attributes)
            # The placed copy is what this export sends, its retries included: the queued copy
            # lets go of its whole values with their budget, so no more is held than it admits.
            held.values.clear()
            held.release()
        self._report_uploads(tally)
        return result

    def _report_uploads(self, tally: Tally) -> None:
        fallbacks = sum(count for count, _ in tally.fallbacks.values())
        with self._lock:
            self._uploaded += tally.uploaded
            self._upload_fallbacks += fallbacks
        for reason, (count, traces) in tally.fallbacks.items():
            named = tuple(trace for trace in traces if trace)
            self._ledger.record(
                "traces",
                "warning",
                count,
                FALLBACK_MESSAGES[reason],
                named if named and len(named) <= MAX_ISSUE_TRACE_IDS else None,
            )

    def _delegate_export(self, batch: Sequence[Any]) -> bool:
        return self._delegate.export(batch) is SpanExportResult.SUCCESS

    def _counted(self, request: list[Any]) -> tuple[list[Any], dict[str, int]]:
        counted: list[Any] = []
        carried: dict[str, int] = {}
        for record in request:
            trace_id = _record_trace_id(record)
            count = (
                self._dropped_records.of(trace_id)
                if trace_id is not None and record.parent is None
                else 0
            )
            if count:
                record = replace_span(
                    record, attributes={**record.attributes, DROPPED_RECORDS_KEY: count}
                )
                carried[trace_id] = count  # type: ignore[index]
            counted.append(record)
        return counted, carried

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        failed = False
        # A request the receiver refused or did not answer, as opposed to one it acknowledged with
        # rejections: placeholders are advisory, so such a receiver gets no second request.
        refused = False
        self._held = 0.0
        # Finished spans and placeholders travel in separate requests, finished spans first, so
        # a rejection count is always one kind of record's.
        real = [span for span in spans if not isinstance(span, PendingSpan)]
        pending = [span for span in spans if isinstance(span, PendingSpan)]
        try:
            # Values over the inline limit are uploaded before any record is measured.
            real = self._place_held(real)
            # Every record is measured, shed and, where it cannot be sent, counted lost before any
            # root is written, so a root carries the losses of children that ended after it.
            fitted: list[tuple[Any, int]] = []
            for span in real:
                entry = self._fit(span)
                if entry is None:
                    failed = True
                    self._unsendable(span)
                else:
                    fitted.append(entry)
            for batch in self._batches(fitted):
                lost, unanswered = self._deliver(batch)
                failed = failed or lost
                refused = refused or unanswered
        except Exception:
            # Never surface record serialization errors containing customer values.
            if real and not failed:
                self._ledger.record(
                    "traces",
                    "failed",
                    len(real),
                    "Hue telemetry pipeline could not encode trace records",
                    trace_ids_of(real),
                )
            failed = failed or bool(real)
        # Placeholders are advisory: a request of them never fails the export, and none is sent
        # once a receiver answered without placeholder support, which the finished spans'
        # acknowledgements may have just shown.
        # Nor after a request of this export's finished spans was refused or unanswered.
        if pending and not refused and not self._session.live_spans_rejected:
            try:
                entries = [entry for entry in map(self._fit, pending) if entry is not None]
                for batch in self._batches(entries):
                    if self._session.live_spans_rejected:
                        break
                    self._deliver(batch, advisory=True)
            except Exception:
                pass
        if failed:
            with self._lock:
                self._failures += 1
            return SpanExportResult.FAILURE
        return SpanExportResult.SUCCESS

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        return self._delegate.force_flush(timeout_millis)

    def shutdown(self) -> None:
        self._delegate.shutdown()


class BoundedLogExporter(_ReceiverExporter, LogRecordExporter):
    signal = "logs"

    def __init__(
        self,
        endpoint: str,
        headers: dict[str, str],
        timeout: float,
        ledger: IssueLedger | None = None,
        *,
        limits: AdvertisedLimits | None = None,
        dropped_records: DroppedRecords | None = None,
    ) -> None:
        self._setup(ledger, limits, dropped_records)
        self._session = SafeSession("logs", limits=self._limits)
        self._delegate = OTLPLogExporter(
            endpoint=endpoint,
            headers={**headers, "User-Agent": USER_AGENT},
            timeout=timeout,
            compression=Compression.Gzip,
            session=self._session,
        )
        self._encode = encode_logs

    def _delegate_export(self, batch: Sequence[Any]) -> bool:
        return self._delegate.export(batch) is LogRecordExportResult.SUCCESS

    def export(self, batch: Sequence[ReadableLogRecord]) -> LogRecordExportResult:
        failed = False
        self._held = 0.0
        try:
            entries: list[tuple[Any, int]] = []
            for record in batch:
                entry = self._fit(record)
                if entry is None:
                    failed = True
                    self._unsendable(record)
                else:
                    entries.append(entry)
            for chunk in self._batches(entries):
                lost, _ = self._deliver(chunk)
                failed = failed or lost
        except Exception:
            if not failed:
                self._ledger.record(
                    "logs",
                    "failed",
                    len(batch),
                    "Hue telemetry pipeline could not encode log records",
                    trace_ids_of(batch),
                )
            failed = True
        if failed:
            with self._lock:
                self._failures += 1
            return LogRecordExportResult.FAILURE
        return LogRecordExportResult.SUCCESS

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        return self._delegate.force_flush(timeout_millis)

    def shutdown(self) -> None:
        self._delegate.shutdown()
