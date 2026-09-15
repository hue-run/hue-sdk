"""Small policy adapters around the official OTLP HTTP/protobuf exporters."""

from __future__ import annotations

import ipaddress
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from http import HTTPStatus
from threading import Lock
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import requests
from google.protobuf.message import DecodeError, Message
from opentelemetry.exporter.otlp.proto.common._log_encoder import encode_logs
from opentelemetry.exporter.otlp.proto.common.trace_encoder import encode_spans
from opentelemetry.exporter.otlp.proto.http import Compression
from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.proto.collector.logs.v1.logs_service_pb2 import ExportLogsServiceResponse
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceResponse
from opentelemetry.sdk._logs import ReadableLogRecord
from opentelemetry.sdk._logs.export import LogRecordExporter, LogRecordExportResult
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult

MAX_REQUEST_BYTES = 1_048_576
MAX_CONTENT_BYTES = 262_144
DEFAULT_BASE_URL = "https://app.hue.run"


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

    @property
    def ok(self) -> bool:
        return not (self.failed_trace_batches or self.failed_log_batches)


class SafeSession(requests.Session):
    """Disable redirects and reject partial/malformed OTLP acknowledgements.

    OpenTelemetry 1.44 does not inspect partial_success itself. A rejection is
    permanent: accepted records must not be retried as a whole batch.
    """

    def __init__(self, signal: str | None = None) -> None:
        super().__init__()
        self.signal = signal

    def request(self, method: str, url: str, **kwargs: Any) -> requests.Response:
        kwargs["allow_redirects"] = False
        try:
            response = super().request(method, url, **kwargs)
        except requests.ConnectionError:
            raise requests.ConnectionError("Hue telemetry connection failed.") from None
        except requests.RequestException:
            raise requests.RequestException("Hue telemetry request failed.") from None
        # An untrusted server reason must not make its way into exporter logs.
        try:
            response.reason = HTTPStatus(response.status_code).phrase
        except ValueError:
            response.reason = "HTTP response"
        if 300 <= response.status_code < 400:
            raise requests.RequestException("Hue endpoints do not follow redirects.")
        if self.signal and response.ok:
            if response.status_code != 200:
                raise requests.RequestException("Hue OTLP response must use HTTP 200.")
            acknowledgement = (
                ExportTraceServiceResponse()
                if self.signal == "traces"
                else ExportLogsServiceResponse()
            )
            try:
                acknowledgement.ParseFromString(response.content)
            except DecodeError:
                raise requests.RequestException("Hue returned an invalid OTLP response.") from None
            partial = acknowledgement.partial_success
            rejected = (
                partial.rejected_spans if self.signal == "traces" else partial.rejected_log_records
            )
            if rejected:
                raise requests.RequestException("Hue OTLP receiver rejected records.")
        return response


def _split_batches(
    items: Sequence[Any], encode: Callable[[Sequence[Any]], Message]
) -> list[Sequence[Any]]:
    """Split by actual protobuf bytes, retaining order. Oversized singles stay visible."""
    if not items:
        return []
    if encode(items).ByteSize() <= MAX_REQUEST_BYTES or len(items) == 1:
        return [items]
    middle = len(items) // 2
    return _split_batches(items[:middle], encode) + _split_batches(items[middle:], encode)


class BoundedSpanExporter(SpanExporter):
    def __init__(self, endpoint: str, headers: dict[str, str], timeout: float) -> None:
        self._delegate = OTLPSpanExporter(
            endpoint=endpoint,
            headers=headers,
            timeout=timeout,
            compression=Compression.NoCompression,
            session=SafeSession("traces"),
        )
        self._failures = 0
        self._lock = Lock()

    @property
    def failures(self) -> int:
        with self._lock:
            return self._failures

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        failed = False
        try:
            for batch in _split_batches(spans, encode_spans):
                if encode_spans(batch).ByteSize() > MAX_REQUEST_BYTES:
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
        self._delegate = OTLPLogExporter(
            endpoint=endpoint,
            headers=headers,
            timeout=timeout,
            compression=Compression.NoCompression,
            session=SafeSession("logs"),
        )
        self._failures = 0
        self._lock = Lock()

    @property
    def failures(self) -> int:
        with self._lock:
            return self._failures

    def export(self, batch: Sequence[ReadableLogRecord]) -> LogRecordExportResult:
        failed = False
        try:
            for chunk in _split_batches(batch, encode_logs):
                if encode_logs(chunk).ByteSize() > MAX_REQUEST_BYTES:
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
