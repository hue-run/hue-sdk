"""Small policy adapters around the official OTLP HTTP/protobuf exporters."""

from __future__ import annotations

import ipaddress
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
from opentelemetry.context import _SUPPRESS_INSTRUMENTATION_KEY, attach, detach, set_value
from opentelemetry.exporter.otlp.proto.common._log_encoder import encode_logs
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

from ._version import __version__

MAX_REQUEST_BYTES = 1_048_576
# Batches stop 1 KiB short of the wire cap so gzip framing of incompressible data cannot exceed it,
# matching the TypeScript transport.
MAX_BATCH_BYTES = MAX_REQUEST_BYTES - 1024
MAX_CONTENT_BYTES = 262_144
DEFAULT_BASE_URL = "https://app.hue.run"
# The OTLP exporter lets caller headers override its own User-Agent; keep its token after
# Hue's, as the TypeScript transport does.
USER_AGENT = f"hue-sdk-python/{__version__} OTel-OTLP-Exporter-Python/{OTLP_EXPORTER_VERSION}"


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


@dataclass(frozen=True)
class ExportStatus:
    """Cumulative failed export batches; contains no telemetry or credentials."""

    failed_trace_batches: int
    failed_log_batches: int
    dropped_trace_records: int = 0
    dropped_log_records: int = 0
    queued_trace_records: int = 0
    queued_log_records: int = 0
    queued_trace_bytes: int = 0
    queued_log_bytes: int = 0
    instrumentation_failures: int = 0

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

    OpenTelemetry 1.44 does not inspect partial_success itself. A rejection is
    permanent: accepted records must not be retried as a whole batch.
    """

    def __init__(self, signal: str | None = None) -> None:
        super().__init__()
        self.signal = signal
        self._request_lock = Lock()

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
        export_context = set_value(_SUPPRESS_INSTRUMENTATION_KEY, True)
        if not self._request_lock.acquire(blocking=False):
            raise requests.RequestException("Hue telemetry transport is still busy.")
        completed = Event()
        deadline = monotonic() + timeout
        result: requests.Response | None = None
        failure: Exception | None = None

        def send() -> None:
            nonlocal result, failure
            token = None
            try:
                token = attach(export_context)
                for attempt in range(6):
                    remaining = deadline - monotonic()
                    if remaining <= 0:
                        raise requests.RequestException("Hue telemetry request timed out.")
                    kwargs["timeout"] = remaining
                    response = self._request(method, url, **kwargs)
                    # OTel 1.44 omits 429 and Retry-After. Handle them here,
                    # without replaying partial acknowledgements or 4xx errors.
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

    def _request(self, method: str, url: str, **kwargs: Any) -> requests.Response:
        kwargs["allow_redirects"] = False
        if self.signal:
            kwargs["stream"] = True
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
            if _rejected_records(self.signal, response.content):
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


class BoundedSpanExporter(SpanExporter):
    def __init__(self, endpoint: str, headers: dict[str, str], timeout: float) -> None:
        self._session = SafeSession("traces")
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

    def record_failure(self) -> None:
        with self._lock:
            self._failures += 1

    @property
    def failures(self) -> int:
        with self._lock:
            return self._failures

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        failed = False
        try:
            for batch in _split_batches(spans, encode_spans):
                if encode_spans(batch).ByteSize() > MAX_BATCH_BYTES:
                    failed = True
                elif self._delegate.export(batch) is not SpanExportResult.SUCCESS:
                    failed = True
        except Exception:
            # Never surface record serialization errors containing customer values.
            failed = True
        if failed:
            with self._lock:
                self._failures += 1
            return SpanExportResult.FAILURE
        return SpanExportResult.SUCCESS

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        return self._delegate.force_flush(timeout_millis)

    def shutdown(self) -> None:
        self._delegate.shutdown()


class BoundedLogExporter(LogRecordExporter):
    def __init__(self, endpoint: str, headers: dict[str, str], timeout: float) -> None:
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

    def record_failure(self) -> None:
        with self._lock:
            self._failures += 1

    @property
    def failures(self) -> int:
        with self._lock:
            return self._failures

    def export(self, batch: Sequence[ReadableLogRecord]) -> LogRecordExportResult:
        failed = False
        try:
            for chunk in _split_batches(batch, encode_logs):
                if encode_logs(chunk).ByteSize() > MAX_BATCH_BYTES:
                    failed = True
                elif self._delegate.export(chunk) is not LogRecordExportResult.SUCCESS:
                    failed = True
        except Exception:
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
