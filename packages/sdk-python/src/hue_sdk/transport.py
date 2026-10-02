"""Small policy adapters around the official OTLP HTTP/protobuf exporters."""

from __future__ import annotations

import ipaddress
from collections import deque
from collections.abc import Callable, Sequence
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

from ._otel_compat import encode_logs, export_context
from ._version import __version__

MAX_REQUEST_BYTES = 1_048_576
# Batches stop 1 KiB short of the wire cap so gzip framing of incompressible data cannot exceed it,
# matching the TypeScript transport.
MAX_BATCH_BYTES = MAX_REQUEST_BYTES - 1024
MAX_CONTENT_BYTES = 262_144
# The record attribute listing the keys whose values were cut to the cap: Hue's receiver writes
# it for the values it cuts, and the SDK writes it for the values it cuts before export.
TRUNCATED_KEY = "hue.truncated"
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

    def __init__(self, signal: str | None = None, *, live_spans: bool = True) -> None:
        super().__init__()
        self.signal = signal
        self._request_lock = Lock()
        self.placeholders = 0
        self.live_spans = live_spans
        self.live_spans_rejected = False
        # Why the last trace request failed, read by the exporter once the request returned:
        # ``"rejected"`` for a partial success from a healthy receiver, else ``None``.
        self.last_failure: str | None = None

    @property
    def ready(self) -> bool:
        """Whether the owned HTTP worker has released the transport."""
        return not self._request_lock.locked()

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
                    if attempt == 5 or delay >= deadline - monotonic():
                        raise requests.RequestException("Hue telemetry retry budget exhausted.")
                    Event().wait(delay)
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


def _split_batches(
    items: Sequence[Any], encode: Callable[[Sequence[Any]], Message]
) -> list[Sequence[Any]]:
    """Split by actual protobuf bytes, retaining order. Oversized singles stay visible."""
    if not items:
        return []
    if encode(items).ByteSize() <= MAX_BATCH_BYTES or len(items) == 1:
        return [items]
    middle = len(items) // 2
    return _split_batches(items[:middle], encode) + _split_batches(items[middle:], encode)


# An issue names at most this many traces; a batch of more names none, and the receipts decide.
MAX_ISSUE_TRACE_IDS = 64
# The issues a client retains; a runner reads the ones younger than its case.
MAX_RETAINED_ISSUES = 256


@dataclass(frozen=True)
class ExportIssue:
    """One export failure, with the traces of the records it concerned.

    ``kind`` is ``failed`` for a batch Hue refused or did not acknowledge and ``dropped`` for a
    record the pipeline could not hold or encode. ``trace_ids`` names the traces whose records the
    issue concerned, lowercase hexadecimal; ``None`` when the records named none or more than
    ``MAX_ISSUE_TRACE_IDS``, so a case's trace receipt decides. ``sequence`` orders issues across
    both signals; a client's ``export_failure_sequence()`` is the last one recorded.
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
            self._issues.append(
                ExportIssue(signal, kind, max(1, count), message, self._sequence, trace_ids)
            )

    @property
    def failure_sequence(self) -> int:
        with self._lock:
            return self._sequence

    def issues(self) -> tuple[ExportIssue, ...]:
        with self._lock:
            return tuple(self._issues)


class BoundedSpanExporter(SpanExporter):
    def __init__(
        self,
        endpoint: str,
        headers: dict[str, str],
        timeout: float,
        ledger: IssueLedger | None = None,
        *,
        live_spans: bool = True,
    ) -> None:
        self._ledger = ledger or IssueLedger()
        self._session = SafeSession("traces", live_spans=live_spans)
        self._delegate = OTLPSpanExporter(
            endpoint=endpoint,
            headers={**headers, "User-Agent": USER_AGENT},
            timeout=timeout,
            compression=Compression.Gzip,
            session=self._session,
        )
        self._failures = 0
        self._lock = Lock()

    @property
    def ready(self) -> bool:
        return self._session.ready

    @property
    def live_spans_rejected(self) -> bool:
        return self._session.live_spans_rejected

    def record_failure(
        self, records: Sequence[Any] | None = None, kind: str = "dropped", count: int = 1
    ) -> None:
        """Count a failure the pipeline met outside an export, naming the records' traces."""
        with self._lock:
            self._failures += 1
        self._ledger.record(
            "traces",
            kind,
            count,
            "Hue telemetry pipeline could not hold or encode trace records",
            trace_ids_of(records) if records else None,
        )

    @property
    def failures(self) -> int:
        with self._lock:
            return self._failures

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        failed = False
        # A request the receiver refused or did not answer, as opposed to one it acknowledged with
        # rejections: placeholders are advisory, so such a receiver gets no second request.
        refused = False
        # Finished spans and placeholders travel in separate requests, finished spans first, so
        # a rejection count is always one kind of record's.
        real = [span for span in spans if not isinstance(span, PendingSpan)]
        pending = [span for span in spans if isinstance(span, PendingSpan)]
        try:
            for batch in _split_batches(real, encode_spans):
                if not self._send(batch, placeholders=0):
                    failed = True
                    if self._session.last_failure != "rejected":
                        refused = True
                    # The batch Hue refused or did not acknowledge names the traces in it.
                    self._ledger.record(
                        "traces",
                        "failed",
                        len(batch),
                        "Hue did not accept a batch of trace records",
                        trace_ids_of(batch),
                    )
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
                for batch in _split_batches(pending, encode_spans):
                    # None follows the acknowledgement that turned live spans off.
                    if self._session.live_spans_rejected:
                        break
                    self._send(batch, placeholders=len(batch))
            except Exception:
                pass
        if failed:
            with self._lock:
                self._failures += 1
            return SpanExportResult.FAILURE
        return SpanExportResult.SUCCESS

    def _send(self, batch: Sequence[ReadableSpan], *, placeholders: int) -> bool:
        """One request; ``placeholders`` is ``len(batch)`` for a request of placeholders."""
        try:
            if encode_spans(batch).ByteSize() > MAX_BATCH_BYTES:
                return False
            self._session.placeholders = placeholders
            return self._delegate.export(batch) is SpanExportResult.SUCCESS
        except Exception:
            return False

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        return self._delegate.force_flush(timeout_millis)

    def shutdown(self) -> None:
        self._delegate.shutdown()


class BoundedLogExporter(LogRecordExporter):
    def __init__(
        self,
        endpoint: str,
        headers: dict[str, str],
        timeout: float,
        ledger: IssueLedger | None = None,
    ) -> None:
        self._ledger = ledger or IssueLedger()
        self._session = SafeSession("logs")
        self._delegate = OTLPLogExporter(
            endpoint=endpoint,
            headers={**headers, "User-Agent": USER_AGENT},
            timeout=timeout,
            compression=Compression.Gzip,
            session=self._session,
        )
        self._failures = 0
        self._lock = Lock()

    @property
    def ready(self) -> bool:
        return self._session.ready

    def record_failure(
        self, records: Sequence[Any] | None = None, kind: str = "dropped", count: int = 1
    ) -> None:
        """Count a failure the pipeline met outside an export, naming the records' traces."""
        with self._lock:
            self._failures += 1
        self._ledger.record(
            "logs",
            kind,
            count,
            "Hue telemetry pipeline could not hold or encode log records",
            trace_ids_of(records) if records else None,
        )

    @property
    def failures(self) -> int:
        with self._lock:
            return self._failures

    def export(self, batch: Sequence[ReadableLogRecord]) -> LogRecordExportResult:
        failed = False
        try:
            for chunk in _split_batches(batch, encode_logs):
                if encode_logs(chunk).ByteSize() > MAX_BATCH_BYTES:
                    accepted = False
                else:
                    accepted = self._delegate.export(chunk) is LogRecordExportResult.SUCCESS
                if not accepted:
                    failed = True
                    self._ledger.record(
                        "logs",
                        "failed",
                        len(chunk),
                        "Hue did not accept a batch of log records",
                        trace_ids_of(chunk),
                    )
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
