from __future__ import annotations

import json
import math
from collections.abc import Callable, Iterator, Mapping, MutableMapping
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from threading import Event, Lock, Thread
from time import monotonic, time_ns
from typing import Any

import requests
from opentelemetry import trace
from opentelemetry._logs import SeverityNumber
from opentelemetry.context import Context
from opentelemetry.sdk._logs import LoggerProvider
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.trace import SpanKind, Status, StatusCode
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator
from opentelemetry.util.types import AttributeValue

from .transport import (
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
        return format(self.otel_span.get_span_context().trace_id, "032x")

    @property
    def span_id(self) -> str:
        return format(self.otel_span.get_span_context().span_id, "016x")

    def set_attribute(self, name: str, value: AttributeValue) -> None:
        """Custom metadata is caller-owned and may contain sensitive data."""
        self.otel_span.set_attribute(name, value)

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
        if not self._client.capture_content:
            return
        self.otel_span.set_attribute(key, self._client._content(key, value))

    def set_usage(
        self, *, input_tokens: int | None = None, output_tokens: int | None = None
    ) -> None:
        for key, value in (
            ("gen_ai.usage.input_tokens", input_tokens),
            ("gen_ai.usage.output_tokens", output_tokens),
        ):
            if value is not None:
                if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                    raise ValueError("Token usage must be a nonnegative integer or None.")
                self.otel_span.set_attribute(key, value)

    def record_error(self, error: BaseException) -> None:
        """Record error type and status. Exception messages and stacks are never captured."""
        error_type = f"{type(error).__module__}.{type(error).__qualname__}"
        self.otel_span.set_attribute("error.type", error_type)
        self.otel_span.set_status(Status(StatusCode.ERROR))
        self.otel_span.add_event("exception", {"exception.type": error_type})

    def log_inference(self, *, input: Any = _MISSING, output: Any = _MISSING) -> None:
        """Emit a standard GenAI details log correlated to this span, even outside its scope.

        Use this instead of repeating identical content in both logs and span attributes.
        JSON null is serialized as ``"null"`` so protobuf's absent AnyValue stays distinct.
        """
        body: dict[str, str] = {}
        if self._client.capture_content:
            for key, value in (
                ("gen_ai.input.messages", input),
                ("gen_ai.output.messages", output),
            ):
                if value is not _MISSING:
                    body[key] = self._client._content(key, value)
        self._client._ensure_open()
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

    ``capture_content`` is required. It governs Hue's content helpers only. Arbitrary
    attributes, names, external instrumentors and other exporters remain caller-owned.
    """

    def __init__(
        self,
        base_url: str,
        api_key: str,
        *,
        capture_content: bool,
        service_name: str = "hue-python-agent",
        tracer_provider: TracerProvider | None = None,
        redactor: Redactor | None = None,
        export_timeout_seconds: float = 10,
    ) -> None:
        self.base_url = normalize_base_url(base_url)
        if not isinstance(api_key, str) or not api_key or any(c.isspace() for c in api_key):
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
        self.capture_content = capture_content
        self._redactor = redactor
        self._headers = {"Authorization": f"Bearer {api_key}"}
        self._timeout = export_timeout_seconds
        self._closed = False
        self._flush_lock = Lock()
        self._shutdown_lock = Lock()
        self._shutdown_done = Event()
        self._shutdown_result = False
        self._context_attributes: ContextVar[dict[str, AttributeValue] | None] = ContextVar(
            "hue_context", default=None
        )
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
        self._span_processor = BatchSpanProcessor(
            self._span_exporter, max_export_batch_size=64, max_queue_size=2048
        )
        self._log_processor = BatchLogRecordProcessor(
            self._log_exporter, max_export_batch_size=64, max_queue_size=2048
        )
        self.tracer_provider.add_span_processor(self._span_processor)
        self.logger_provider.add_log_record_processor(self._log_processor)
        self.tracer = self.tracer_provider.get_tracer("hue-sdk", "0.1.0.dev0")
        self._logger = self.logger_provider.get_logger("hue-sdk", "0.1.0.dev0")

    def __repr__(self) -> str:
        return f"Hue(capture_content={self.capture_content!r}, closed={self._closed!r})"

    def _ensure_open(self) -> None:
        if self._closed:
            raise RuntimeError("Hue has already shut down.")

    def _content(self, key: str, value: Any) -> str:
        # Redact before serialization, before queues and before any exporter receives content.
        try:
            if self._redactor is not None:
                value = self._redactor(key, value)
            serialized = json.dumps(
                value, ensure_ascii=False, allow_nan=False, separators=(",", ":")
            )
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
        self._ensure_open()
        attributes = dict(self._context_attributes.get() or {})
        if session_id is not None:
            attributes["gen_ai.conversation.id"] = session_id
        if user_id is not None:
            attributes["user.id"] = user_id
        token = self._context_attributes.set(attributes)
        try:
            yield
        finally:
            self._context_attributes.reset(token)

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
        self._ensure_open()
        merged = {**(self._context_attributes.get() or {}), **(attributes or {})}
        with self.tracer.start_as_current_span(
            name,
            attributes=merged,
            kind=kind,
            context=parent_context,
            record_exception=False,
            set_status_on_exception=False,
        ) as otel_span:
            helper = HueSpan(self, otel_span, _category)
            try:
                yield helper
            except BaseException as error:
                helper.record_error(error)
                raise

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
        TraceContextTextMapPropagator().inject(headers)

    @staticmethod
    def extract(headers: Mapping[str, str]) -> Context:
        return TraceContextTextMapPropagator().extract(headers)

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
        return ExportStatus(self._span_exporter.failures, self._log_exporter.failures)

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        """Drain pending telemetry. False means a timeout or a recorded export failure.

        OTel 1.44 ignores its processor timeout, so a single background worker
        drains both signals while this caller waits only up to its own budget.
        A timed-out operation continues in the background. Counters are cumulative;
        this is not an exactly-once or durable-queue guarantee.
        """
        self._validate_timeout(timeout_millis)
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
        with self._shutdown_lock:
            if not self._closed:
                self._closed = True

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
                    self._closed = False
                    return False
        return self._shutdown_done.wait(timeout_millis / 1000) and self._shutdown_result

    def __enter__(self) -> Hue:
        self._ensure_open()
        return self

    def __exit__(self, *_exc: object) -> None:
        self.shutdown()
