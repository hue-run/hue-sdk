from __future__ import annotations

import hashlib
import json
import math
import os
import re
from collections.abc import Callable, Iterator, Mapping, MutableMapping, Sequence
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from threading import Event, Lock, Thread
from time import monotonic, time_ns
from typing import Any

import requests
from opentelemetry import trace
from opentelemetry._logs import LoggerProvider as ApiLoggerProvider
from opentelemetry._logs import NoOpLoggerProvider, SeverityNumber
from opentelemetry.context import Context
from opentelemetry.exporter.otlp.proto.common.trace_encoder import encode_spans
from opentelemetry.sdk._logs import LoggerProvider
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.trace import SpanKind, Status, StatusCode
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator
from opentelemetry.util.types import AttributeValue

from ._otel_compat import encode_logs
from ._version import __version__
from .processors import HUE_TRACER_SCOPE, BoundedLogProcessor, BoundedSpanProcessor
from .receipts import TraceReceiptField, TraceVerificationResult, verify_trace
from .snapshots import snapshot_content
from .transport import (
    DEFAULT_BASE_URL,
    MAX_CONTENT_BYTES,
    BoundedLogExporter,
    BoundedSpanExporter,
    ExportStatus,
    SafeSession,
    normalize_base_url,
    reject_positional_api_key,
)

Redactor = Callable[[str, Any], Any]
_MISSING = object()
_FILE_ROLES = frozenset({"input", "attachment", "output"})
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_MAX_FILE_DATA_BYTES = 25 * 1024 * 1024


def _utf8_byte_size(value: str, limit: int) -> int:
    """Count UTF-8 bytes in bounded chunks, stopping after ``limit``."""
    if len(value) > limit:
        return limit + 1
    total = 0
    for offset in range(0, len(value), 8192):
        total += len(value[offset : offset + 8192].encode("utf-8"))
        if total > limit:
            return total
    return total


def _is_label(value: Any) -> bool:
    """A non-blank string of at most 256 characters, matching existing label behavior."""
    return type(value) is str and bool(value.strip()) and len(value) <= 256


def _is_source_label(value: Any) -> bool:
    """A source label that is UTF-16 bounded and safe to export."""
    if type(value) is not str or not value.strip() or "\x00" in value:
        return False
    try:
        return len(value.encode("utf-16-le")) // 2 <= 256 and value.encode("utf-8") is not None
    except UnicodeEncodeError:
        return False


def _is_text_label(value: Any) -> bool:
    """A label that is also free of NUL and unpaired surrogates, so it can be exported."""
    if not _is_label(value) or "\x00" in value:
        return False
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


class ProjectValidationError(RuntimeError):
    """Authentication, connectivity or invalid project response; never contains a key."""


@dataclass(frozen=True)
class Project:
    id: str
    name: str
    slug: str
    organization_id: str


class HueSpan:
    """A helper over an ordinary OTel span. Access ``otel_span`` for standard APIs."""

    otel_span: trace.Span

    def __init__(
        self,
        client: Hue,
        span: trace.Span,
        category: str,
        record_attributes: Mapping[str, str] | None = None,
    ) -> None:
        self._client = client
        self.otel_span = span
        self._category = category
        # Request metadata and session copied onto inference-log records; see ``Hue.span``.
        self._record_attributes = dict(record_attributes or {})

    @property
    def trace_id(self) -> str:
        try:
            return format(self.otel_span.get_span_context().trace_id, "032x")
        except Exception:
            self._client._record_issue()
            return "0" * 32

    @property
    def span_id(self) -> str:
        try:
            return format(self.otel_span.get_span_context().span_id, "016x")
        except Exception:
            self._client._record_issue()
            return "0" * 16

    def set_attribute(self, name: str, value: AttributeValue) -> None:
        """Custom metadata is caller-owned and may contain sensitive data."""
        self._client._instrument(lambda: self.otel_span.set_attribute(name, value))

    def set_input(self, value: Any) -> None:
        key = {
            "model": "gen_ai.input.messages",
            "tool": "gen_ai.tool.call.arguments",
        }.get(self._category, "input.value")
        self._set_content(key, value)

    def set_output(self, value: Any) -> None:
        key = {
            "model": "gen_ai.output.messages",
            "tool": "gen_ai.tool.call.result",
        }.get(self._category, "output.value")
        self._set_content(key, value)

    def _set_content(self, key: str, value: Any) -> None:
        if not self._client._active or not self._client.capture_content:
            return
        self._client._instrument(
            lambda: self.otel_span.set_attribute(key, self._client._content(key, value))
        )

    def set_usage(
        self, *, input_tokens: int | None = None, output_tokens: int | None = None
    ) -> None:
        if not self._client._active:
            return
        for key, value in (
            ("gen_ai.usage.input_tokens", input_tokens),
            ("gen_ai.usage.output_tokens", output_tokens),
        ):
            if value is not None:
                if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                    self._client._record_issue()
                    continue
                self.set_attribute(key, value)

    def record_error(self, error: BaseException) -> None:
        """Record error type and status. Exception messages and stacks are never captured."""
        error_type = f"{type(error).__module__}.{type(error).__qualname__}"
        self.set_attribute("error.type", error_type)
        self._client._instrument(lambda: self.otel_span.set_status(Status(StatusCode.ERROR)))
        self._client._instrument(
            lambda: self.otel_span.add_event("exception", {"exception.type": error_type})
        )

    def record_file(
        self,
        *,
        role: str,
        media_type: str,
        sha256: str | None = None,
        data: bytes | bytearray | memoryview | str | None = None,
        byte_size: int | None = None,
        name: str | None = None,
    ) -> None:
        """Add a ``hue.file`` event for a file the work read, received or produced.

        ``role`` is ``input`` (given to the agent), ``attachment`` (from a tool or message) or
        ``output`` (produced by the agent). ``data`` is hashed and measured locally and never
        exported; a ``str`` is hashed as UTF-8. The event carries ``hue.file.sha256``,
        ``hue.file.role``, ``hue.file.media_type``, ``hue.file.size`` when known and, when
        content is captured, ``hue.file.name``. An invalid record is omitted and counted; an
        invalid name alone is omitted and counted while the rest is recorded.
        """
        if not self._client._active:
            return
        self._client._instrument(
            lambda: self._record_file(role, media_type, sha256, data, byte_size, name)
        )

    def _record_file(
        self,
        role: str,
        media_type: str,
        sha256: str | None,
        data: bytes | bytearray | memoryview | str | None,
        byte_size: int | None,
        name: str | None,
    ) -> None:
        # Nothing to attach to: report once, before hashing or validating anything.
        if not self.otel_span.is_recording():
            raise ValueError("File records require a recording span.")
        if role not in _FILE_ROLES:
            raise ValueError("Invalid file role.")
        if not _is_text_label(media_type):
            raise ValueError("Invalid media type.")
        digest = sha256.lower() if isinstance(sha256, str) else sha256
        size = byte_size
        if data is not None:
            if isinstance(data, str):
                if _utf8_byte_size(data, _MAX_FILE_DATA_BYTES) > _MAX_FILE_DATA_BYTES:
                    raise ValueError("File data exceeds Hue's 25 MiB limit.")
                content = data.encode("utf-8")
            elif isinstance(data, (bytes, bytearray, memoryview)):
                if memoryview(data).nbytes > _MAX_FILE_DATA_BYTES:
                    raise ValueError("File data exceeds Hue's 25 MiB limit.")
                content = bytes(data)
            else:
                raise ValueError("File data must be bytes or a string.")
            computed = hashlib.sha256(content).hexdigest()
            # A caller-supplied digest or size must describe the same bytes.
            if (digest is not None and digest != computed) or (
                size is not None and size != len(content)
            ):
                raise ValueError("File digest or size does not match its data.")
            digest, size = computed, len(content)
        if not isinstance(digest, str) or not _SHA256.match(digest):
            raise ValueError("A file needs a SHA-256 digest or its data.")
        if size is not None and (
            isinstance(size, bool) or not isinstance(size, int) or size < 0 or size > 2**63 - 1
        ):
            raise ValueError("Invalid file size.")
        attributes: dict[str, AttributeValue] = {
            "hue.file.sha256": digest,
            "hue.file.role": role,
            "hue.file.media_type": media_type,
        }
        if size is not None:
            attributes["hue.file.size"] = size
        if self._client.capture_content and name is not None:
            if _is_text_label(name):
                attributes["hue.file.name"] = name
            else:
                self._client._record_issue()
        self.otel_span.add_event("hue.file", attributes)

    def log_inference(
        self,
        *,
        input: Any = _MISSING,
        output: Any = _MISSING,
        operation: str | None = None,
        provider: str | None = None,
        model: str | None = None,
        system_instructions: Any = _MISSING,
    ) -> None:
        """Emit a standard GenAI details log correlated to this span, even outside its scope.

        Use this instead of repeating identical content in both logs and span attributes.
        ``system_instructions`` are the instructions sent separately from the messages.
        The body is structured: an explicit ``None`` field keeps its key with an empty value,
        distinct from an absent field. ``gen_ai.operation.name``, ``gen_ai.provider.name`` and
        ``gen_ai.request.model`` come from the keywords or the enclosing ``model()`` block, and
        ``gen_ai.conversation.id`` from the enclosing ``context()``. Nothing is emitted when
        ``capture_content`` is False.
        """
        if not self._client._active or not self._client.capture_content:
            return
        self._client._instrument(
            lambda: self._log_inference(
                input, output, operation, provider, model, system_instructions
            )
        )

    def _log_inference(
        self,
        input: Any,
        output: Any,
        operation: str | None,
        provider: str | None,
        model: str | None,
        system_instructions: Any,
    ) -> None:
        attributes = dict(self._record_attributes)
        for key, label in (
            ("gen_ai.operation.name", operation),
            ("gen_ai.provider.name", provider),
            ("gen_ai.request.model", model),
        ):
            if label is None:
                continue
            if _is_label(label):
                attributes[key] = label
            else:
                # An unusable explicit label is omitted rather than replaced by the inherited one.
                attributes.pop(key, None)
                self._client._record_issue()
        body: dict[str, Any] = {}
        for key, value in (
            ("gen_ai.input.messages", input),
            ("gen_ai.output.messages", output),
            ("gen_ai.system_instructions", system_instructions),
        ):
            if value is not _MISSING:
                # Bound and redact each field as JSON, then send the structure rather than its text.
                body[key] = json.loads(self._client._content(key, value))
        self._client._logger.emit(
            timestamp=time_ns(),
            context=trace.set_span_in_context(self.otel_span),
            severity_number=SeverityNumber.INFO,
            event_name="gen_ai.client.inference.operation.details",
            body=body,
            attributes=attributes,
        )


class Hue:
    """Explicit, instance-owned OTel setup; never changes global providers.

    Use ``Hue(api_key=..., capture_content=...)`` for Hue Cloud. ``base_url``
    overrides the default origin; existing ``Hue(base_url, api_key, ...)`` calls work,
    and a bare key in the first position raises ``TypeError`` naming ``api_key=``.
    ``capture_content`` is required. It governs Hue's content helpers and, at export time,
    recognized third-party content attributes; unrecognized custom attributes, span names
    and other exporters remain caller-owned.
    ``tracer_provider`` and ``logger_provider`` attach Hue's processors to existing SDK
    providers. A provider Hue creates for the other signal shares the borrowed provider's
    resource, so spans and correlated logs report one ``service.name``; ``service_name``
    applies only when Hue creates both providers.
    ``live_spans`` announces Hue helper and AI spans with placeholders while they run;
    setup keys (``hue_setup_…``) never send them.
    """

    enabled: bool
    base_url: str
    capture_content: bool
    tracer_provider: trace.TracerProvider
    tracer: trace.Tracer
    logger_provider: ApiLoggerProvider

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        api_key: str | None = None,
        *,
        capture_content: bool,
        service_name: str = "hue-python-agent",
        tracer_provider: TracerProvider | None = None,
        logger_provider: LoggerProvider | None = None,
        redactor: Redactor | None = None,
        export_timeout_seconds: float = 10,
        enabled: bool = True,
        max_queue_size: int = 2048,
        max_queue_bytes: int = 8 * 1024 * 1024,
        live_spans: bool = True,
    ) -> None:
        if not isinstance(enabled, bool):
            raise TypeError("enabled must be True or False.")
        if not isinstance(live_spans, bool):
            raise TypeError("live_spans must be True or False.")
        self.enabled = enabled
        self._pid = os.getpid()
        if enabled:
            reject_positional_api_key(base_url)
        self.base_url = normalize_base_url(base_url) if enabled else DEFAULT_BASE_URL
        if enabled and (
            not isinstance(api_key, str) or not api_key or any(c.isspace() for c in api_key)
        ):
            raise ValueError("api_key must be a nonempty project service key without whitespace.")
        if not isinstance(capture_content, bool):
            raise TypeError("capture_content must explicitly be True or False.")
        if not isinstance(export_timeout_seconds, (int, float)) or not (
            math.isfinite(export_timeout_seconds) and export_timeout_seconds > 0
        ):
            raise ValueError("export_timeout_seconds must be a positive finite number.")
        if redactor is not None and not callable(redactor):
            raise TypeError("redactor must be callable.")
        if tracer_provider is not None and not isinstance(tracer_provider, TracerProvider):
            raise TypeError("tracer_provider must be an OpenTelemetry SDK TracerProvider.")
        if logger_provider is not None and not isinstance(logger_provider, LoggerProvider):
            raise TypeError("logger_provider must be an OpenTelemetry SDK LoggerProvider.")
        for value in (max_queue_size, max_queue_bytes):
            if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
                raise ValueError("Queue limits must be positive integers.")
        self.capture_content = capture_content
        self._issues = 0
        self._issues_lock = Lock()
        self._redactor = redactor
        self._headers = {"Authorization": f"Bearer {api_key}"}
        self._timeout = export_timeout_seconds
        self._closed = False
        self._flush_lock = Lock()
        self._receipt_lock = Lock()
        self._shutdown_lock = Lock()
        self._shutdown_done = Event()
        self._shutdown_result = False
        self._context_attributes: ContextVar[dict[str, AttributeValue] | None] = ContextVar(
            "hue_context", default=None
        )
        self._model_scope: ContextVar[dict[str, str] | None] = ContextVar("hue_model", default=None)
        if not enabled:
            self._owns_provider = False
            self._owns_logger_provider = False
            self.tracer_provider = trace.NoOpTracerProvider()
            self.tracer = self.tracer_provider.get_tracer(HUE_TRACER_SCOPE)
            self.logger_provider = NoOpLoggerProvider()
            self._logger = self.logger_provider.get_logger("hue-run")
            return
        # Setup credentials accept metadata spans only; they never announce live spans.
        if isinstance(api_key, str) and api_key.startswith("hue_setup_"):
            live_spans = False
        try:
            self._setup(
                service_name,
                tracer_provider,
                logger_provider,
                max_queue_size,
                max_queue_bytes,
                live_spans,
            )
        except Exception:
            self._closed = True
            for name in ("_span_processor", "_log_processor"):
                processor = getattr(self, name, None)
                if processor is not None:
                    processor.shutdown()
            for name in ("_span_exporter", "_log_exporter"):
                exporter = getattr(self, name, None)
                if exporter is not None:
                    exporter.shutdown()
            raise

    def _setup(
        self,
        service_name: str,
        tracer_provider: TracerProvider | None,
        logger_provider: LoggerProvider | None,
        max_queue_size: int,
        max_queue_bytes: int,
        live_spans: bool,
    ) -> None:
        self._owns_provider = tracer_provider is None
        self._owns_logger_provider = logger_provider is None
        # A borrowed provider's resource wins: correlated logs must describe the same
        # service as the spans they reference, not a second service named by Hue.
        borrowed: TracerProvider | LoggerProvider | None = (
            tracer_provider if tracer_provider is not None else logger_provider
        )
        resource = (
            borrowed.resource
            if borrowed is not None
            else Resource.create({"service.name": service_name})
        )
        sdk_tracer_provider = tracer_provider or TracerProvider(
            resource=resource, shutdown_on_exit=False
        )
        sdk_logger_provider = logger_provider or LoggerProvider(
            resource=resource, shutdown_on_exit=False
        )
        self.tracer_provider = sdk_tracer_provider
        self.logger_provider = sdk_logger_provider
        self._span_exporter = BoundedSpanExporter(
            f"{self.base_url}/api/v1/otlp/v1/traces", self._headers, self._timeout
        )
        self._log_exporter = BoundedLogExporter(
            f"{self.base_url}/api/v1/otlp/v1/logs", self._headers, self._timeout
        )
        self._span_processor = BoundedSpanProcessor(
            self._span_exporter,
            encode_spans,
            max_queue_size,
            max_queue_bytes,
            capture_content=self.capture_content,
            live_spans=live_spans,
        )
        self._log_processor = BoundedLogProcessor(
            self._log_exporter,
            encode_logs,
            max_queue_size,
            max_queue_bytes,
            capture_content=self.capture_content,
        )
        sdk_tracer_provider.add_span_processor(self._span_processor)
        sdk_logger_provider.add_log_record_processor(self._log_processor)
        self.tracer = self.tracer_provider.get_tracer(HUE_TRACER_SCOPE, __version__)
        self._logger = self.logger_provider.get_logger("hue-run", __version__)

    def __repr__(self) -> str:
        return f"Hue(capture_content={self.capture_content!r}, closed={self._closed!r})"

    @property
    def _active(self) -> bool:
        return self.enabled and not self._closed and self._pid == os.getpid()

    def _record_issue(self) -> None:
        if self._pid != os.getpid():
            return
        with self._issues_lock:
            self._issues += 1

    def _instrument(self, action: Callable[[], Any]) -> None:
        if not self._active:
            return
        try:
            action()
        except Exception:
            # Diagnostics contain counters only, never customer values/exception text.
            self._record_issue()

    def _ensure_open(self) -> None:
        if self._pid != os.getpid():
            raise RuntimeError("Initialize Hue in each serving process after fork.")
        if self._closed:
            raise RuntimeError("Hue has already shut down.")
        if not self.enabled:
            raise RuntimeError("Hue tracing is disabled.")

    def _content(self, key: str, value: Any) -> str:
        # Redact before serialization, before queues and before any exporter receives content.
        try:
            # A redactor may mutate its argument before returning or raising.
            # It must never receive the application's live mutable values.
            value = snapshot_content(value)
            if self._redactor is not None:
                # Bound the returned tree too, before JSONEncoder can allocate
                # an arbitrarily large nested string or invoke custom hooks.
                value = snapshot_content(self._redactor(key, value))
            # Stop accumulation once the field exceeds its budget. Large direct
            # strings can be rejected before JSON creates an escaped copy.
            if isinstance(value, str) and len(value) > MAX_CONTENT_BYTES:
                raise ValueError("Content limit exceeded.")
            parts: list[str] = []
            size = 0
            for part in json.JSONEncoder(
                ensure_ascii=False, allow_nan=False, separators=(",", ":")
            ).iterencode(value):
                size += len(part.encode("utf-8"))
                if size > MAX_CONTENT_BYTES:
                    raise ValueError("Content limit exceeded.")
                parts.append(part)
            serialized = "".join(parts)
        except Exception:
            raise ValueError(
                "Content redaction or JSON serialization failed; content was omitted."
            ) from None
        if len(serialized.encode("utf-8")) > MAX_CONTENT_BYTES:
            raise ValueError("Captured content exceeds Hue's 256 KiB field limit.")
        return serialized

    @contextmanager
    def context(
        self,
        *,
        session_id: str | None = None,
        user_id: str | None = None,
        workspace_id: str | None = None,
    ) -> Iterator[None]:
        """Task-local attributes inherited by nested Hue helpers; no global baggage changes.

        ``workspace_id`` is the application workspace or tenant the work runs in, recorded as
        ``hue.workspace.id``.
        """
        if not self._active:
            yield
            return
        token = None
        try:
            attributes = dict(self._context_attributes.get() or {})
            if session_id is not None:
                attributes["gen_ai.conversation.id"] = session_id
            if user_id is not None:
                attributes["user.id"] = user_id
            if workspace_id is not None:
                attributes["hue.workspace.id"] = workspace_id
            token = self._context_attributes.set(attributes)
        except Exception:
            self._record_issue()
        try:
            yield
        finally:
            if token is not None:
                try:
                    self._context_attributes.reset(token)
                except Exception:
                    self._record_issue()

    @contextmanager
    def span(
        self,
        name: str,
        *,
        attributes: Mapping[str, AttributeValue] | None = None,
        kind: SpanKind = SpanKind.INTERNAL,
        parent_context: Context | None = None,
        _category: str = "span",
    ) -> Iterator[HueSpan]:
        otel_span: trace.Span = trace.INVALID_SPAN
        scope = None
        record_attributes: dict[str, str] | None = None
        if self._active:
            try:
                inherited = self._context_attributes.get() or {}
                merged = {**inherited, **(attributes or {})}
                # Copied now so log_inference keeps the enclosing model() metadata and session
                # even after their blocks exit.
                record_attributes = dict(self._model_scope.get() or {})
                session_id = inherited.get("gen_ai.conversation.id")
                if isinstance(session_id, str):
                    record_attributes["gen_ai.conversation.id"] = session_id
                otel_span = self.tracer.start_span(
                    name, attributes=merged, kind=kind, context=parent_context
                )
                scope = trace.use_span(
                    otel_span,
                    end_on_exit=False,
                    record_exception=False,
                    set_status_on_exception=False,
                )
                scope.__enter__()
            except Exception:
                self._record_issue()
                scope = None
        helper = HueSpan(self, otel_span, _category, record_attributes)
        try:
            # The business block is yielded exactly ONCE, outside setup catches.
            yield helper
        except BaseException as error:
            try:
                helper.record_error(error)
            except Exception:
                self._record_issue()
            raise
        finally:
            # Cleanup failures must not mask an application exception or result.
            if scope is not None:
                try:
                    scope.__exit__(None, None, None)
                except Exception:
                    self._record_issue()
            try:
                otel_span.end()
            except Exception:
                self._record_issue()

    @contextmanager
    def model(
        self,
        model: str,
        *,
        provider: str,
        operation: str = "chat",
        name: str | None = None,
        system_instructions: Any = _MISSING,
        tools: Any = _MISSING,
    ) -> Iterator[HueSpan]:
        """A GenAI client span for one direct provider call.

        ``system_instructions`` and ``tools`` are recorded as ``gen_ai.system_instructions`` and
        ``gen_ai.tool.definitions`` when content is captured, like ``set_input``: any JSON value,
        ideally in the GenAI semantic-convention shapes.
        """
        model = self._metadata_string(model, "unknown")
        operation = self._metadata_string(operation, "chat")
        provider = self._metadata_string(provider, "unknown")
        name = self._metadata_string(name, "") if name is not None else ""
        token = None
        if self._active:
            try:
                # log_inference on this helper, and on helpers created inside the block, copies
                # the request metadata onto its record, like TypeScript's inherited scope.
                token = self._model_scope.set(
                    {
                        "gen_ai.operation.name": operation,
                        "gen_ai.provider.name": provider,
                        "gen_ai.request.model": model,
                    }
                )
            except Exception:
                self._record_issue()
        try:
            with self.span(
                name or f"{operation} {model}",
                kind=SpanKind.CLIENT,
                attributes={
                    "gen_ai.operation.name": operation,
                    "gen_ai.request.model": model,
                    "gen_ai.provider.name": provider,
                },
                _category="model",
            ) as span:
                for key, value in (
                    ("gen_ai.system_instructions", system_instructions),
                    ("gen_ai.tool.definitions", tools),
                ):
                    if value is not _MISSING:
                        span._set_content(key, value)
                yield span
        finally:
            if token is not None:
                try:
                    self._model_scope.reset(token)
                except Exception:
                    self._record_issue()

    @contextmanager
    def tool(
        self,
        name: str,
        *,
        call_id: str | None = None,
        mcp: Mapping[str, Any] | None = None,
    ) -> Iterator[HueSpan]:
        name = self._metadata_string(name, "unknown")
        attributes: dict[str, AttributeValue] = {
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.tool.name": name,
        }
        if call_id is not None:
            attributes["gen_ai.tool.call.id"] = self._metadata_string(call_id, "unknown")
        if mcp is not None:
            if isinstance(mcp, Mapping):
                for key, field, valid in (
                    ("mcp.server.name", "name", _is_label),
                    ("mcp.server.version", "version", _is_label),
                    ("hue.mcp.provider", "provider", _is_source_label),
                    ("hue.mcp.surface", "surface", _is_source_label),
                ):
                    value = mcp.get(field)
                    if value is None:
                        continue
                    if valid(value):
                        attributes[key] = value
                    elif self._active:
                        self._record_issue()
            elif self._active:
                self._record_issue()
        with self.span(f"execute_tool {name}", attributes=attributes, _category="tool") as span:
            yield span

    def _metadata_string(self, value: Any, fallback: str) -> str:
        if not self._active:
            return fallback
        if type(value) is str:
            return value
        self._record_issue()
        return fallback

    @staticmethod
    def inject(headers: MutableMapping[str, str]) -> None:
        """Inject current W3C trace context; never include the Hue API key or baggage."""
        try:
            TraceContextTextMapPropagator().inject(headers)
        except Exception:
            pass

    @staticmethod
    def extract(headers: Mapping[str, str]) -> Context:
        try:
            return TraceContextTextMapPropagator().extract(headers)
        except Exception:
            return Context()

    def validate_project(self) -> Project:
        self._ensure_open()
        try:
            with SafeSession() as session:
                response = session.get(
                    f"{self.base_url}/api/v1/projects/current",
                    headers=self._headers,
                    timeout=self._timeout,
                )
            if response.status_code != 200:
                raise ProjectValidationError(
                    f"Hue project validation failed (HTTP {response.status_code})."
                )
            data = response.json()
            if not isinstance(data, dict) or any(
                not isinstance(data.get(field), str) or not data[field]
                for field in ("id", "name", "slug", "organizationId")
            ):
                raise ProjectValidationError("Hue returned an invalid project response.")
            return Project(data["id"], data["name"], data["slug"], data["organizationId"])
        except (requests.RequestException, ValueError):
            raise ProjectValidationError("Hue project validation request failed.") from None

    @property
    def export_status(self) -> ExportStatus:
        if self._pid != os.getpid():
            return ExportStatus(0, 0, instrumentation_failures=1)
        with self._issues_lock:
            issues = self._issues
        if not self.enabled:
            return ExportStatus(0, 0, instrumentation_failures=issues)
        span_drops, span_count, span_bytes = self._span_processor.status
        log_drops, log_count, log_bytes = self._log_processor.status
        return ExportStatus(
            self._span_exporter.failures,
            self._log_exporter.failures,
            dropped_trace_records=span_drops,
            dropped_log_records=log_drops,
            queued_trace_records=span_count,
            queued_log_records=log_count,
            queued_trace_bytes=span_bytes,
            queued_log_bytes=log_bytes,
            instrumentation_failures=issues,
            live_spans_rejected=self._span_exporter.live_spans_rejected,
        )

    def verify_trace(
        self,
        trace_id: str,
        *,
        expected_span_ids: Sequence[str] | None = None,
        required_fields: Sequence[TraceReceiptField] | None = None,
        timeout_millis: float = 10_000,
    ) -> TraceVerificationResult:
        """Poll Hue for received spans/fields from an actual application request.

        This does not flush exporters, generate spans, or call a model. Finish
        the application request and flush its provider before checking receipt.
        A timeout returns ``verified=False`` with the latest receipt, if any.
        The caller's deadline includes response bodies; an already-running
        network read may finish in the background after timeout.
        """
        self._ensure_open()
        return verify_trace(
            self.base_url,
            self._headers,
            trace_id,
            expected_span_ids=expected_span_ids,
            required_fields=required_fields,
            timeout_millis=timeout_millis,
            request_timeout=self._timeout,
            poll_lock=self._receipt_lock,
        )

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        """Drain pending telemetry. False means a timeout or a recorded export failure.

        A single background worker drains both signals while this caller waits
        only up to its own budget. Queue drops and omitted helper data also fail
        the result, independently of successful exports.
        A timed-out operation continues in the background. Counters are cumulative;
        this is not an exactly-once or durable-queue guarantee.
        """
        self._validate_timeout(timeout_millis)
        if self._pid != os.getpid():
            return False
        if not self.enabled:
            return self.export_status.ok
        if self._closed:
            return False
        deadline = monotonic() + timeout_millis / 1000
        if not self._flush_lock.acquire(timeout=timeout_millis / 1000):
            return False
        if self._closed:
            self._flush_lock.release()
            return False
        completed = Event()
        result = False

        def drain() -> None:
            nonlocal result
            try:
                result = self._drain(deadline)
            finally:
                self._flush_lock.release()
                completed.set()

        try:
            Thread(target=drain, name="hue-flush", daemon=True).start()
        except RuntimeError:
            self._flush_lock.release()
            return False
        return completed.wait(max(0, deadline - monotonic())) and result

    @staticmethod
    def _validate_timeout(timeout_millis: int) -> None:
        if (
            isinstance(timeout_millis, bool)
            or not isinstance(timeout_millis, int)
            or timeout_millis <= 0
        ):
            raise ValueError("timeout_millis must be a positive integer.")

    def _drain(self, deadline: float) -> bool:
        traces, logs = False, False
        try:
            traces = self._span_processor.force_flush(
                timeout_millis=max(0, int((deadline - monotonic()) * 1000))
            )
        except Exception:
            pass
        try:
            # Even with no wait remaining, request the other signal's export.
            # The processor's own worker continues without holding this drain.
            logs = self._log_processor.force_flush(
                timeout_millis=max(0, int((deadline - monotonic()) * 1000))
            )
        except Exception:
            pass
        return traces and logs and self.export_status.ok

    def shutdown(self, timeout_millis: int = 30_000) -> bool:
        """Stop new helpers, drain and close Hue exporters within the caller's wait budget.

        Work continues after a timeout. Call again to await the same shutdown;
        repeated calls never launch extra workers. Borrowed providers stay usable.
        """
        self._validate_timeout(timeout_millis)
        if self._pid != os.getpid():
            return False
        if not self.enabled:
            self._closed = True
            return self.export_status.ok
        deadline = monotonic() + timeout_millis / 1000
        with self._shutdown_lock:
            if not self._closed:
                self._closed = True
                self._span_processor.stop_accepting()
                self._log_processor.stop_accepting()

                def close() -> None:
                    try:
                        acquired = self._flush_lock.acquire(timeout=max(0, deadline - monotonic()))
                        if acquired:
                            try:
                                self._drain(deadline)
                            finally:
                                self._flush_lock.release()
                        # Cleanup can outlive this caller. Do not hold the drain
                        # coordinator while waiting for exporter workers to stop.
                        try:
                            if self._owns_provider and isinstance(
                                self.tracer_provider, TracerProvider
                            ):
                                self.tracer_provider.shutdown()
                            else:
                                self._span_processor.shutdown()
                        finally:
                            if self._owns_logger_provider and isinstance(
                                self.logger_provider, LoggerProvider
                            ):
                                self.logger_provider.shutdown()
                            else:
                                self._log_processor.shutdown()
                        # An expired caller budget is not an export failure.
                        # Recheck completed cleanup without starting another wait.
                        self._shutdown_result = self._drain(monotonic())
                    except Exception:
                        self._shutdown_result = False
                    finally:
                        self._shutdown_done.set()

                try:
                    Thread(target=close, name="hue-shutdown", daemon=True).start()
                except RuntimeError:
                    # The queue inputs are already closed; never reactivate a
                    # client whose shutdown worker could not be scheduled.
                    self._record_issue()
                    self._shutdown_done.set()
                    return False
        return (
            self._shutdown_done.wait(max(0, deadline - monotonic()))
            and self._shutdown_result
            and self.export_status.ok
        )

    def force_flush_safe(self, timeout_millis: int = 1000) -> bool:
        """Best-effort production cleanup; strict delivery checks belong outside requests."""
        try:
            return self.force_flush(timeout_millis)
        except Exception:
            self._record_issue()
            return False

    def shutdown_safe(self, timeout_millis: int = 1000) -> bool:
        """Bound caller waiting and never replace an application's result/exception."""
        try:
            return self.shutdown(timeout_millis)
        except Exception:
            self._record_issue()
            return False

    def __enter__(self) -> Hue:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.shutdown_safe()


def create_hue_safe(*args: Any, **kwargs: Any) -> Hue:
    """Initialize tracing without making serving traffic depend on configuration.

    Configuration failures return a disabled client with a failed export status.
    Use the strict Hue constructor and verification helpers in setup/CI.
    """
    try:
        return Hue(*args, **kwargs)
    except Exception:
        fallback = Hue(enabled=False, capture_content=False)
        fallback._record_issue()
        return fallback
