"""Machine-authenticated managed targets; application providers retain OTel ownership."""

from __future__ import annotations

import hashlib
import hmac
import json
import re
from collections.abc import Callable, Mapping
from contextvars import copy_context
from dataclasses import dataclass, field
from datetime import datetime
from queue import Empty, Queue
from threading import Event, Thread
from time import monotonic, sleep, time
from typing import Any, TypeVar
from urllib.parse import urlsplit

import requests
from opentelemetry import trace
from opentelemetry.context import Context
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

from .evals._json import MISSING, encode, json_value, uuid
from .transport import DEFAULT_BASE_URL, normalize_base_url

_MIB = 1024 * 1024
_MAX_FILE = 25 * _MIB
_MAX_TOTAL = 64 * _MIB
_STATES = {
    "queued",
    "dispatched",
    "running",
    "uncertain",
    "checkpointed",
    "completed",
    "unsupported",
    "error",
    "cancelled",
    "superseded",
}
_T = TypeVar("_T")


@dataclass(frozen=True)
class ManagedInputFile:
    artifact_id: str
    filename: str
    content_type: str
    byte_size: int
    sha256: str
    role: str
    data: bytes


@dataclass(frozen=True)
class ManagedTargetContext:
    execution_id: str
    attempt: int
    input: Any
    config: Any
    input_files: tuple[ManagedInputFile, ...]
    cancelled: Event
    deadline_monotonic: float
    trace_id: str


@dataclass(frozen=True)
class ManagedOutputFile:
    filename: str
    content_type: str
    data: bytes
    primary: bool = False


@dataclass(frozen=True)
class ManagedTargetResult:
    output: Any = MISSING
    state: str = "succeeded"
    # Caller-owned safe public summary; never include raw provider exceptions or keys.
    error: dict[str, str] | None = None
    files: tuple[ManagedOutputFile, ...] = ()
    usage: dict[str, int] | None = None


@dataclass(frozen=True)
class ManagedResponse:
    status_code: int
    body: dict[str, Any]
    headers: dict[str, str] = field(default_factory=lambda: {"Cache-Control": "no-store"})


class ManagedTargetHandler:
    """Adapt ``handle(payload, headers)`` to your framework's protected POST route.

    The target runs once after Hue claims the execution. It must honor ``cancelled``
    and use the supplied deadline for provider calls. Python cannot forcibly stop a
    running callback: an unresolved deadline returns uncertain, never fake success.
    Flush the existing trace AND log providers, without shutting them down.
    """

    def __init__(
        self,
        *,
        machine_credential: str,
        target: Callable[[ManagedTargetContext], ManagedTargetResult],
        flush_telemetry: Callable[[], Any],
        base_url: str = DEFAULT_BASE_URL,
        tracer: trace.Tracer | None = None,
        max_execution_millis: int = 90_000,
        finalization_millis: int = 30_000,
    ) -> None:
        self._credential = hashlib.sha256(f"Bearer {_token(machine_credential)}".encode()).digest()
        self._base_url = normalize_base_url(base_url)
        self._target = target
        self._flush = flush_telemetry
        self._tracer = tracer
        self._maximum = _integer(max_execution_millis, 1, 90_000) / 1000
        self._grace = _integer(finalization_millis, 1, 30_000) / 1000
        if not callable(target) or not callable(flush_telemetry):
            raise TypeError("target and flush_telemetry are required.")

    def __repr__(self) -> str:
        return "ManagedTargetHandler()"

    def handle(
        self, payload: bytes | dict[str, Any], headers: Mapping[str, str]
    ) -> ManagedResponse:
        began = monotonic()
        lowered = {key.lower(): value for key, value in headers.items()}
        supplied = lowered.get("authorization", "")
        if (
            not isinstance(supplied, str)
            or len(supplied) > 8192
            or not hmac.compare_digest(self._credential, hashlib.sha256(supplied.encode()).digest())
        ):
            return ManagedResponse(401, {"error": "authentication"})
        try:
            invocation_token = _token(lowered.get("x-hue-invocation-token"))
            if isinstance(payload, bytes):
                if len(payload) > _MIB:
                    raise ValueError()
                payload = json.loads(payload)
            invocation = _invocation(payload)
            seconds = datetime.fromisoformat(
                invocation["deadline"].replace("Z", "+00:00")
            ).timestamp()
            if seconds <= time():
                return ManagedResponse(408, {"error": "deadline_exceeded"})
        except (ValueError, TypeError, KeyError, UnicodeError, RecursionError):
            return ManagedResponse(400, {"error": "invalid_invocation"})
        execution_end = min(began + self._maximum, monotonic() + seconds - time())
        final_end = min(execution_end + self._grace, began + self._maximum + self._grace)
        execution_id = invocation["executionId"]
        api = _InvocationApi(self._base_url, invocation_token, execution_id)
        uncertain = ManagedResponse(
            503,
            {
                "protocolVersion": 1,
                "executionId": execution_id,
                "state": "uncertain",
            },
        )
        try:
            claim = api.json("/claim", {}, execution_end)
            if (
                type(claim) is not dict
                or type(claim.get("claimed")) is not bool
                or claim.get("executionId") != execution_id
                or claim.get("state") not in _STATES
            ):
                raise ValueError()
        except Exception:
            return uncertain
        if not claim["claimed"]:
            return ManagedResponse(
                409,
                {
                    "protocolVersion": 1,
                    "executionId": execution_id,
                    "state": claim["state"],
                },
            )
        parent = TraceContextTextMapPropagator().extract(
            {"traceparent": invocation["traceparent"]}, context=Context()
        )
        tracer = self._tracer or trace.get_tracer("hue_sdk.managed")
        span = tracer.start_span(
            "ai.managed_target",
            context=parent,
            attributes={
                "hue.execution.id": execution_id,
                "hue.execution.attempt": invocation["attempt"],
            },
        )
        trace_id = format(span.get_span_context().trace_id, "032x")
        if not span.is_recording() or trace_id != invocation["traceparent"].split("-")[1]:
            span.end()
            return uncertain
        cancelled = Event()
        try:
            inputs = []
            for item in invocation["inputFiles"]:
                data = api.request(
                    "GET", f"/inputs/{item['artifactId']}", None, item["byteSize"], execution_end
                )
                if (
                    len(data) != item["byteSize"]
                    or hashlib.sha256(data).hexdigest() != item["sha256"]
                ):
                    raise ValueError()
                inputs.append(
                    ManagedInputFile(
                        item["artifactId"],
                        item["filename"],
                        item["contentType"],
                        item["byteSize"],
                        item["sha256"],
                        item["role"],
                        data,
                    )
                )
            target_context = ManagedTargetContext(
                execution_id,
                invocation["attempt"],
                invocation["input"],
                invocation["config"],
                tuple(inputs),
                cancelled,
                execution_end,
                trace_id,
            )

            def invoke() -> ManagedTargetResult:
                with trace.use_span(
                    span, end_on_exit=False, record_exception=False, set_status_on_exception=False
                ):
                    return self._target(target_context)

            result = _within(invoke, execution_end, cancelled)
            _result(result)
        except Exception:
            if monotonic() >= execution_end:
                cancelled.set()
                span.set_status(trace.Status(trace.StatusCode.ERROR))
                span.end()
                return uncertain
            result = ManagedTargetResult(
                state="error",
                error={
                    "type": "target_error",
                    "message": "The target or input validation failed.",
                },
            )
        artifact_ids: list[str] = []
        primary = None
        upload_failed = False
        for index, file in enumerate(result.files):
            try:
                digest = hashlib.sha256(file.data).hexdigest()
                reserved = api.json(
                    "/files",
                    {
                        "idempotencyKey": f"file:{index}:{digest}",
                        "filename": file.filename,
                        "contentType": file.content_type,
                        "byteSize": len(file.data),
                        "sha256": digest,
                    },
                    final_end,
                    retry=True,
                )
                artifact_id = uuid(reserved["artifactId"])
                if reserved.get("state") != "ready":
                    upload_url = _upload_url(reserved["uploadUrl"])
                    upload_headers = _upload_headers(reserved.get("headers"), file.content_type)
                    try:
                        api.request(
                            "PUT",
                            upload_url,
                            file.data,
                            _MIB,
                            final_end,
                            retry=False,
                            upload=True,
                            upload_headers=upload_headers,
                        )
                    except Exception:
                        # Never replay a signed write. Completion verifies the
                        # stored length/hash and resolves upload uncertainty.
                        pass
                    api.json(f"/files/{artifact_id}/complete", {}, final_end, retry=True)
                artifact_ids.append(artifact_id)
                if file.primary:
                    primary = artifact_id
            except Exception:
                upload_failed = True
        state = "error" if upload_failed else result.state
        error = (
            {
                "type": "artifact_upload_failed",
                "message": "One or more output files could not be stored.",
            }
            if upload_failed
            else result.error
        )
        if state != "succeeded":
            span.set_status(trace.Status(trace.StatusCode.ERROR))
        span.end()
        outcome = {
            "protocolVersion": 1,
            "executionId": execution_id,
            "state": state,
            **({"output": result.output} if result.output is not MISSING else {}),
            **({"error": error} if error else {}),
            "artifactIds": artifact_ids,
            **({"primaryArtifactId": primary} if primary else {}),
            "traceId": trace_id,
            "expectedSpanIds": [format(span.get_span_context().span_id, "016x")],
            **({"usage": result.usage} if result.usage is not None else {}),
        }
        try:
            api.json("/outcome", outcome, final_end, retry=True)
        except Exception:
            return uncertain
        acknowledgement = {
            "protocolVersion": 1,
            "executionId": execution_id,
            "state": "checkpointed",
        }
        try:
            if _within(self._flush, final_end) is False:
                raise RuntimeError("Telemetry flush did not complete.")
            api.json(
                "/telemetry",
                {"expectedSpanIds": outcome["expectedSpanIds"], "flushed": True},
                final_end,
                retry=True,
            )
        except Exception:
            return ManagedResponse(200, {**acknowledgement, "telemetry": "pending"})
        return ManagedResponse(200, {**acknowledgement, "telemetry": "flushed"})


class _PermanentError(Exception):
    pass


class _InvocationApi:
    def __init__(self, base_url: str, token: str, execution_id: str) -> None:
        self._url = f"{base_url}/api/v1/managed-executions/{execution_id}"
        self._token = token

    def json(self, path: str, value: Any, deadline: float, retry: bool = False) -> Any:
        data = encode(json_value(value, _MIB))
        response = self.request(
            "POST", path, data, _MIB, deadline, retry=retry, content_type="application/json"
        )
        return json_value(json.loads(response), _MIB)

    def request(
        self,
        method: str,
        path: str,
        data: bytes | None,
        maximum: int,
        deadline: float,
        *,
        retry: bool = False,
        content_type: str | None = None,
        upload: bool = False,
        upload_headers: dict[str, str] | None = None,
    ) -> bytes:
        def send() -> bytes:
            remaining = deadline - monotonic()
            if remaining <= 0:
                raise TimeoutError()
            # No netrc/proxy credentials, automatic retries or redirected bearer tokens.
            with requests.Session() as session:
                session.trust_env = False
                with session.request(
                    method,
                    path if upload else self._url + path,
                    data=data,
                    headers={
                        **({} if upload else {"Authorization": f"Bearer {self._token}"}),
                        **({"Content-Type": content_type} if content_type else {}),
                        **(upload_headers or {}),
                    },
                    timeout=remaining,
                    allow_redirects=False,
                    stream=True,
                ) as response:
                    if not 200 <= response.status_code < 300:
                        if response.status_code not in (429, 500, 502, 503, 504):
                            raise _PermanentError()
                        raise OSError()
                    declared = response.headers.get("Content-Length")
                    if declared is not None and (
                        not declared.isdecimal() or int(declared) > maximum
                    ):
                        raise _PermanentError()
                    chunks = []
                    size = 0
                    for chunk in response.iter_content(8192):
                        size += len(chunk)
                        if size > maximum or monotonic() >= deadline:
                            raise _PermanentError()
                        chunks.append(chunk)
                    return b"".join(chunks)

        for attempt in range(2 if retry else 1):
            try:
                return _within(send, deadline)
            except Exception as error:
                if (
                    isinstance(error, _PermanentError)
                    or not retry
                    or attempt == 1
                    or monotonic() + 0.1 >= deadline
                ):
                    raise RuntimeError("Hue managed request failed.") from None
                sleep(0.1)
        raise RuntimeError("Hue managed request failed.")


def _within(callback: Callable[[], _T], deadline: float, cancelled: Event | None = None) -> _T:
    remaining = deadline - monotonic()
    if remaining <= 0:
        if cancelled is not None:
            cancelled.set()
        raise TimeoutError()
    queue: Queue[tuple[bool, Any]] = Queue(maxsize=1)
    caller_context = copy_context()

    def run() -> None:
        try:
            queue.put((True, caller_context.run(callback)))
        except BaseException as error:
            queue.put((False, error))

    Thread(target=run, daemon=True, name="hue-managed-operation").start()
    try:
        success, value = queue.get(timeout=remaining)
    except Empty:
        if cancelled is not None:
            cancelled.set()
        raise TimeoutError() from None
    if not success:
        raise value
    return value


def _integer(value: Any, minimum: int, maximum: int) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError("Invalid integer.")
    return value


def _token(value: Any) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > 8192
        or any(c.isspace() or c == "\0" for c in value)
    ):
        raise ValueError("Invalid credential.")
    return value


def _string(value: Any, maximum: int = 255) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > maximum
        or any(ord(c) < 32 or ord(c) == 127 for c in value)
    ):
        raise ValueError("Invalid string.")
    return value


def _filename(value: Any) -> str:
    value = _string(value)
    if not value.strip() or value in (".", "..") or "/" in value or "\\" in value:
        raise ValueError("Invalid filename.")
    return value


def _invocation(value: Any) -> dict[str, Any]:
    json_value(value, _MIB)
    keys = {
        "protocolVersion",
        "executionId",
        "attempt",
        "input",
        "config",
        "inputFiles",
        "deadline",
        "traceparent",
    }
    if type(value) is not dict or value.keys() != keys or type(value["protocolVersion"]) is not int:
        raise ValueError()
    if value["protocolVersion"] != 1:
        raise ValueError()
    uuid(value["executionId"])
    _integer(value["attempt"], 1, 2**53 - 1)
    if not isinstance(value["deadline"], str) or not re.fullmatch(
        r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z", value["deadline"]
    ):
        raise ValueError()
    parent = value["traceparent"]
    if (
        not isinstance(parent, str)
        or not re.fullmatch(r"00-[0-9a-f]{32}-[0-9a-f]{16}-01", parent)
        or parent.split("-")[1] == "0" * 32
        or parent.split("-")[2] == "0" * 16
    ):
        raise ValueError()
    if type(value["inputFiles"]) is not list or len(value["inputFiles"]) > 16:
        raise ValueError()
    total = 0
    ids = set()
    for item in value["inputFiles"]:
        if type(item) is not dict or item.keys() != {
            "artifactId",
            "filename",
            "contentType",
            "byteSize",
            "sha256",
            "role",
        }:
            raise ValueError()
        identifier = uuid(item["artifactId"])
        if identifier in ids:
            raise ValueError()
        ids.add(identifier)
        _filename(item["filename"])
        _string(item["contentType"])
        _string(item["role"], 64)
        total += _integer(item["byteSize"], 0, _MAX_FILE)
        if not isinstance(item["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", item["sha256"]):
            raise ValueError()
    if total > _MAX_TOTAL:
        raise ValueError()
    return value


def _result(value: ManagedTargetResult) -> None:
    if not isinstance(value, ManagedTargetResult) or value.state not in {
        "succeeded",
        "error",
        "cancelled",
    }:
        raise ValueError()
    if value.output is not MISSING:
        json_value(value.output)
    if value.error is not None:
        if not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", value.error["type"]):
            raise ValueError()
        if "message" in value.error:
            _string(value.error["message"], 1000)
    if value.usage is not None:
        for count in value.usage.values():
            _integer(count, 0, 2**53 - 1)
    if len(value.files) > 16:
        raise ValueError()
    total = primary = 0
    for file in value.files:
        _filename(file.filename)
        _string(file.content_type)
        if not isinstance(file.data, bytes) or type(file.primary) is not bool:
            raise ValueError()
        total += _integer(len(file.data), 0, _MAX_FILE)
        primary += file.primary
    if total > _MAX_TOTAL or primary > 1:
        raise ValueError()


def _upload_url(value: Any) -> str:
    if not isinstance(value, str) or len(value) > 8192:
        raise ValueError()
    url = urlsplit(value)
    loopback = url.hostname in ("localhost", "127.0.0.1", "::1")
    if (
        not url.hostname
        or (url.scheme != "https" and not (url.scheme == "http" and loopback))
        or url.username
        or url.password
        or url.fragment
    ):
        raise ValueError()
    return value


def _upload_headers(value: Any, content_type: str) -> dict[str, str]:
    headers = {"content-type": content_type}
    if value is None:
        return headers
    if type(value) is not dict:
        raise ValueError()
    for name, raw in value.items():
        lower = _string(name).lower()
        text = _string(raw)
        if lower == "content-type" and text == content_type:
            headers[lower] = text
        elif lower == "x-vercel-blob-access" and text == "private":
            headers[lower] = text
        else:
            raise ValueError("Unsupported upload header.")
    return headers


__all__ = [
    "ManagedInputFile",
    "ManagedOutputFile",
    "ManagedResponse",
    "ManagedTargetContext",
    "ManagedTargetHandler",
    "ManagedTargetResult",
]
