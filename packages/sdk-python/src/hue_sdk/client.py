from __future__ import annotations

import json
import math
import os
from collections.abc import Callable, Iterator, Mapping, MutableMapping, Sequence
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from threading import Event, Lock, Thread
from time import monotonic, time_ns
from typing import Any

import requests
from opentelemetry import trace
from opentelemetry._logs import NoOpLoggerProvider, SeverityNumber
from opentelemetry.context import Context
from opentelemetry.exporter.otlp.proto.common._log_encoder import encode_logs
from opentelemetry.exporter.otlp.proto.common.trace_encoder import encode_spans
from opentelemetry.sdk._logs import LoggerProvider
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.trace import SpanKind, Status, StatusCode
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator
from opentelemetry.util.types import AttributeValue

from .processors import BoundedLogProcessor, BoundedSpanProcessor
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
)

Redactor = Callable[[str, Any], Any]
_MISSING = object()


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

    def __init__(self, client: Hue, span: trace.Span, category: str) -> None:
        self._client = client
        self.otel_span = span
        self._category = category

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

    def log_inference(self, *, input: Any = _MISSING, output: Any = _MISSING) -> None:
        """Emit a standard GenAI details log correlated to this span, even outside its scope.

        Use this instead of repeating identical content in both logs and span attributes.
        JSON null is serialized as ``"null"`` so protobuf's absent AnyValue stays distinct.
        """
        if not self._client._active:
            return
        self._client._instrument(lambda: self._log_inference(input, output))

    def _log_inference(self, input: Any, output: Any) -> None:
        body: dict[str, str] = {}
        if self._client.capture_content:
            for key, value in (
                ("gen_ai.input.messages", input),
                ("gen_ai.output.messages", output),
            ):
                if value is not _MISSING:
                    body[key] = self._client._content(key, value)
        self._client._logger.emit(
            timestamp=time_ns(),
            context=trace.set_span_in_context(self.otel_span),
            severity_number=SeverityNumber.INFO,
            event_name="gen_ai.client.inference.operation.details",
            body=body or None,
            attributes={"hue.capture_content": self._client.capture_content},
        )


class Hue:
    """Explicit, instance-owned OTel setup; never changes global providers.

    Use ``Hue(api_key=..., capture_content=...)`` for Hue Cloud. ``base_url``
    overrides the default origin; existing ``Hue(base_url, api_key, ...)`` calls work.
    ``capture_content`` is required. It governs Hue's content helpers only. Arbitrary
    attributes, names, external instrumentors and other exporters remain caller-owned.
    """

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        api_key: str | None = None,
        *,
        capture_content: bool,
        service_name: str = "hue-python-agent",
        tracer_provider: TracerProvider | None = None,
        redactor: Redactor | None = None,
        export_timeout_seconds: float = 10,
        enabled: bool = True,
        max_queue_size: int = 2048,
        max_queue_bytes: int = 8 * 1024 * 1024,
    ) -> None:
        if not isinstance(enabled, bool):
            raise TypeError("enabled must be True or False.")
        self.enabled = enabled
        self._pid = os.getpid()
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
        if not enabled:
            self._owns_provider = False
            self.tracer_provider = trace.NoOpTracerProvider()
            self.tracer = self.tracer_provider.get_tracer("hue-run")
            self.logger_provider = NoOpLoggerProvider()
            self._logger = self.logger_provider.get_logger("hue-run")
            return
        try:
            self._setup(service_name, tracer_provider, max_queue_size, max_queue_bytes)
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
        max_queue_size: int,
        max_queue_bytes: int,
    ) -> None:
        resource = Resource.create({"service.name": service_name})
        self._owns_provider = tracer_provider is None
        self.tracer_provider = tracer_provider or TracerProvider(
            resource=resource, shutdown_on_exit=False
        )
        self.logger_provider = LoggerProvider(resource=resource, shutdown_on_exit=False)
        self._span_exporter = BoundedSpanExporter(
            f"{self.base_url}/api/v1/otlp/v1/traces", self._headers, self._timeout
        )
        self._log_exporter = BoundedLogExporter(
            f"{self.base_url}/api/v1/otlp/v1/logs", self._headers, self._timeout
        )
        self._span_processor = BoundedSpanProcessor(
            self._span_exporter, encode_spans, max_queue_size, max_queue_bytes
        )
        self._log_processor = BoundedLogProcessor(
            self._log_exporter, encode_logs, max_queue_size, max_queue_bytes
        )
        self.tracer_provider.add_span_processor(self._span_processor)
        self.logger_provider.add_log_record_processor(self._log_processor)
        self.tracer = self.tracer_provider.get_tracer("hue-run", "0.1.3")
        self._logger = self.logger_provider.get_logger("hue-run", "0.1.3")

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
        self, *, session_id: str | None = None, user_id: str | None = None
    ) -> Iterator[None]:
        """Task-local attributes inherited by nested Hue helpers; no global baggage changes."""
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
        otel_span = trace.INVALID_SPAN
        scope = None
        if self._active:
            try:
                merged = {**(self._context_attributes.get() or {}), **(attributes or {})}
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
        helper = HueSpan(self, otel_span, _category)
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
    ) -> Iterator[HueSpan]:
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
            yield span

    @contextmanager
    def tool(self, name: str, *, call_id: str | None = None) -> Iterator[HueSpan]:
        attributes: dict[str, AttributeValue] = {
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.tool.name": name,
        }
        if call_id is not None:
            attributes["gen_ai.tool.call.id"] = call_id
        with self.span(f"execute_tool {name}", attributes=attributes, _category="tool") as span:
            yield span

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
                result = self._drain()
            finally:
                completed.set()
                self._flush_lock.release()

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

    def _drain(self) -> bool:
        traces, logs = False, False
        try:
            traces = self._span_processor.force_flush()
        except Exception:
            pass
        try:
            logs = self._log_processor.force_flush()
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
        with self._shutdown_lock:
            if not self._closed:
                self._closed = True
                self._span_processor.stop_accepting()
                self._log_processor.stop_accepting()

                def close() -> None:
                    try:
                        with self._flush_lock:
                            flushed = self._drain()
                            try:
                                if self._owns_provider:
                                    self.tracer_provider.shutdown()
                                else:
                                    self._span_processor.shutdown()
                            finally:
                                self.logger_provider.shutdown()
                            self._shutdown_result = flushed and self.export_status.ok
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
        return self._shutdown_done.wait(timeout_millis / 1000) and self._shutdown_result

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
