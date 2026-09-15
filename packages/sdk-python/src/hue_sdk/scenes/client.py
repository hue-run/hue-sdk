"""Explicit, context-local source recording. Live calls never wait for export."""

from __future__ import annotations

import asyncio
import inspect
import re
from collections.abc import Callable
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import wraps
from threading import Event, Lock, Thread
from typing import Any
from uuid import uuid4

from opentelemetry import trace

from . import _payload
from ._json import canonical_json, clean_json, request_key, sha256
from ._transport import API, identifier
from .types import (
    ABSENT,
    Binding,
    FinalizeResult,
    SceneTransportError,
    Snapshot,
    SourceFile,
    json_copy,
)


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def trace_id(value: str | None) -> str:
    if value is None:
        value = format(trace.get_current_span().get_span_context().trace_id, "032x")
    if not re.fullmatch(r"[a-f0-9]{32}", value) or int(value, 16) == 0:
        raise ValueError("Scenes require an explicit or current valid external trace ID.")
    return value


@dataclass
class _Call:
    capture: Capture
    fields: dict[str, Any]
    portable: bool
    done: bool = False
    retained: bool = True

    def finish(
        self,
        result: Any = ABSENT,
        *,
        error: BaseException | None = None,
        payload: dict[str, Any] | None = None,
        omission: str | None = None,
        sources: Any = None,
    ) -> None:
        try:
            self.capture._finish(
                self, result, error=error, payload=payload, omission=omission, sources=sources
            )
        except BaseException:
            # Export bookkeeping must not replace the user's exception/cancellation.
            with self.capture._lock:
                if not self.done:
                    self.done = True
                    self.capture._pending -= 1
                self.capture._dropped += 1


class Scenes:
    """Separate content opt-in, queues and transport; never installs global instrumentation."""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        *,
        capture_content: bool,
        sanitizer: Callable[[str, Any], Any] | None = None,
        max_buffer_bytes: int = 64 * 1024 * 1024,
        max_records: int = 2048,
        request_timeout: float = 10,
    ) -> None:
        if not isinstance(capture_content, bool):
            raise ValueError("capture_content must be an explicit boolean.")
        if max_buffer_bytes <= 0 or max_records <= 0:
            raise ValueError("Capture queue limits must be positive.")
        self.capture_content = capture_content
        self.sanitizer = sanitizer
        self.api = API(base_url, api_key, request_timeout)
        self._active: ContextVar[Any] = ContextVar(f"hue-scenes-{id(self)}", default=None)
        self._parents: ContextVar[tuple[str, ...]] = ContextVar(
            f"hue-scene-parents-{id(self)}", default=()
        )
        self._budget_lock = Lock()
        self._bytes = self._records = 0
        self._max_bytes, self._max_records = max_buffer_bytes, max_records

    def _reserve(self, byte_size: int, records: int = 0) -> bool:
        with self._budget_lock:
            if self._bytes + byte_size > self._max_bytes or (
                self._records + records > self._max_records
            ):
                return False
            self._bytes += byte_size
            self._records += records
            return True

    def _release(self, byte_size: int, records: int = 0) -> None:
        with self._budget_lock:
            self._bytes -= byte_size
            self._records -= records

    def _clean(self, field: str, value: Any) -> Any:
        # Built-in filtering runs both before and after the customer sanitizer.
        cleaned = clean_json(value)
        if self.sanitizer is not None:
            cleaned = self.sanitizer(field, cleaned)
        return clean_json(cleaned)

    def capture(
        self,
        *,
        bindings: list[Binding],
        external_trace_id: str | None = None,
        input: Any = ABSENT,
        session_id: str | None = None,
        observed_user_id: str | None = None,
    ) -> Capture:
        if not self.capture_content:
            raise ValueError("Scene capture requires capture_content=True.")
        return Capture(
            self, bindings, trace_id(external_trace_id), input, session_id, observed_user_id
        )

    def tool(
        self,
        binding_id: str,
        operation: str | None = None,
        *,
        arguments: Callable[..., Any] | None = None,
        sources: Callable[[Any], list[SourceFile]] | None = None,
        contract_version: str = "1",
    ):
        """Wrap explicitly selected source tools. Function defaults become named arguments."""

        def decorate(fn):
            name = operation or fn.__name__

            def get_arguments(args, kwargs):
                if arguments:
                    return arguments(*args, **kwargs)
                bound = inspect.signature(fn).bind(*args, **kwargs)
                bound.apply_defaults()
                return dict(bound.arguments)

            if inspect.iscoroutinefunction(fn):

                @wraps(fn)
                async def asynchronous(*args, **kwargs):
                    return await self.acall(
                        binding_id,
                        name,
                        lambda: get_arguments(args, kwargs),
                        lambda: fn(*args, **kwargs),
                        sources=sources,
                        contract_version=contract_version,
                    )

                return asynchronous

            @wraps(fn)
            def synchronous(*args, **kwargs):
                return self.call(
                    binding_id,
                    name,
                    lambda: get_arguments(args, kwargs),
                    lambda: fn(*args, **kwargs),
                    sources=sources,
                    contract_version=contract_version,
                )

            return synchronous

        return decorate

    def call(
        self,
        binding_id: str,
        operation: str,
        arguments: Any,
        live: Callable[[], Any],
        *,
        sources: Callable[[Any], list[SourceFile]] | None = None,
        serializer: Callable[[Any], Any] | None = None,
        contract_version: str = "1",
    ) -> Any:
        active = self._active.get()
        if active is None or binding_id not in active.selected:
            return live()
        if not isinstance(active, Capture):
            return active.dispatch(
                binding_id, operation, arguments, contract_version=contract_version
            )
        call = active.start(binding_id, operation, arguments)
        token = self._parents.set((*self._parents.get(), call.fields["callId"]))
        try:
            result = live()
        except BaseException as error:
            call.finish(error=error)
            raise
        finally:
            self._parents.reset(token)
        if hasattr(result, "__aiter__"):
            return _CaptureStream(result, call, serializer, sources)
        try:
            call.finish(
                serializer(result) if serializer else result,
                sources=sources(result) if sources else None,
            )
        except BaseException:
            call.finish(omission="extractor_failed")
        return result

    async def acall(
        self,
        binding_id: str,
        operation: str,
        arguments: Any,
        live: Callable[[], Any],
        *,
        sources=None,
        serializer=None,
        contract_version: str = "1",
    ) -> Any:
        active = self._active.get()
        if active is None or binding_id not in active.selected:
            return await live()
        if not isinstance(active, Capture):
            return await asyncio.to_thread(
                active.dispatch, binding_id, operation, arguments, contract_version=contract_version
            )
        call = active.start(binding_id, operation, arguments)
        token = self._parents.set((*self._parents.get(), call.fields["callId"]))
        try:
            result = await live()
        except BaseException as error:
            call.finish(error=error)
            raise
        finally:
            self._parents.reset(token)
        if hasattr(result, "__aiter__"):
            return _CaptureStream(result, call, serializer, sources)
        try:
            call.finish(
                serializer(result) if serializer else result,
                sources=sources(result) if sources else None,
            )
        except BaseException:
            call.finish(omission="extractor_failed")
        return result

    def load(self, snapshot: Snapshot):
        from .playback import Recording

        response = self.api.request(
            "GET",
            "/scenes/" + identifier(snapshot.scene_id) + "/revisions/" + str(snapshot.revision),
            limit=64 * 1024 * 1024,
        )
        return Recording(
            response.get("manifest"), response.get("digest"), snapshot=snapshot, scenes=self
        )

    async def aload(self, snapshot: Snapshot):
        return await asyncio.to_thread(self.load, snapshot)


class Capture:
    def __init__(
        self,
        scenes: Scenes,
        bindings: list[Binding],
        external_trace_id: str,
        input: Any,
        session_id: str | None,
        user_id: str | None,
    ) -> None:
        self.scenes = scenes
        self._selected = {binding.id: json_copy(binding.wire()) for binding in bindings}
        if not bindings or len(self.selected) != len(bindings):
            raise ValueError("Capture bindings must be nonempty and uniquely identified.")
        for binding in self.selected.values():
            if binding.get("http", {}).get("origin") == scenes.api.base_url:
                raise ValueError("Hue traffic cannot be a source binding.")
        http = [binding["http"] for binding in self.selected.values() if "http" in binding]
        for index, left in enumerate(http):
            for right in http[index + 1:]:
                if left["origin"] == right["origin"] and (
                    left["pathPrefix"].startswith(right["pathPrefix"])
                    or right["pathPrefix"].startswith(left["pathPrefix"])
                ):
                    raise ValueError("HTTP source scopes must not overlap.")
        self.producer_id = str(uuid4())
        self._create: dict[str, Any] = {
            "idempotencyKey": str(uuid4()),
            "externalTraceId": external_trace_id,
            "bindings": list(self.selected.values()),
            "producerId": self.producer_id,
            "startedAt": now(),
            "capturePolicy": {"sourceContent": True, "redactionVersion": "1"},
        }
        if session_id is not None:
            self._create["sessionId"] = session_id
        if user_id is not None:
            self._create["observedUserId"] = user_id
        self._lock = Lock()
        self._sequence = self._pending = self._dropped = self._calls = 0
        self._queue: list[tuple[str, dict[str, Any], int]] = []
        self._scene_id: str | None = None
        self._revision = 0
        self._upload_cache: dict[str, dict[str, Any]] = {}
        self._input_size = 0
        if input is not ABSENT:
            try:
                payload = _payload.encode(scenes._clean("input", input))
                byte_size = _payload.size(payload)
                if scenes._reserve(byte_size):
                    self._create["input"] = payload
                    self._input_size = byte_size
                else:
                    self._dropped += 1
            except BaseException:
                self._dropped += 1
        self._worker_lock = Lock()
        self._worker: Event | None = None
        self._result: FinalizeResult | None = None
        self._finalize_body: dict[str, Any] | None = None
        self._token = None

    def __enter__(self) -> Capture:
        if self.scenes._active.get() is not None or self._token is not None:
            raise ValueError("Capture and replay contexts cannot be nested.")
        self._token = self.scenes._active.set(self)
        return self

    @property
    def selected(self) -> dict[str, Any]:
        return json_copy(self._selected)

    def __exit__(self, *_exc: Any) -> None:
        self.scenes._active.reset(self._token)
        self._token = None

    async def __aenter__(self) -> Capture:
        return self.__enter__()

    async def __aexit__(self, *exc: Any) -> None:
        self.__exit__(*exc)

    def _enqueue_locked(self, route: str, record: dict[str, Any]) -> None:
        if _payload.wire_size(record) > 1000 * 1024:
            if route != "observations":
                self._dropped += 1
                return
            record = {**record, "replayable": False, "omissionReason": "metadata_limit"}
            record.pop("sources", None)
            if record["phase"] == "start":
                record["arguments"] = {"kind": "absent"}
            else:
                record.pop("result", None)
                record["outcome"] = "incomplete"
        byte_size = _payload.size(record)
        if self.scenes._reserve(byte_size, 1):
            self._queue.append((route, record, byte_size))
        else:
            self._dropped += 1

    def start(
        self, binding_id: str, operation: str, arguments: Any, *, omission: str | None = None
    ) -> _Call:
        binding = self.selected[binding_id]
        portable = omission is None
        payload: dict[str, Any] = {"kind": "absent"}
        try:
            value = arguments() if callable(arguments) else arguments
            args = self.scenes._clean("arguments", value)
            key = request_key(binding_id, operation, binding["contractVersion"], args)
            payload = _payload.encode(args)
        except BaseException:
            key = request_key(binding_id, operation, binding["contractVersion"], None)
            portable, omission = False, "nonportable_arguments"
        with self._lock:
            self._calls += 1
            self._pending += 1
            if self._calls > 2000:
                portable, omission = False, "call_limit"
            fields = {
                "callId": str(uuid4()),
                "producerId": self.producer_id,
                "bindingId": binding_id,
                "operation": operation,
                "contractVersion": binding["contractVersion"],
                "requestKey": key,
            }
            current_span = trace.get_current_span().get_span_context()
            if current_span.is_valid:
                fields["externalSpanId"] = format(current_span.span_id, "016x")
            parents = self.scenes._parents.get()
            if parents:
                fields["parentCallId"] = parents[-1]
            self._sequence += 1
            record = {
                **fields,
                "id": str(uuid4()),
                "sequence": self._sequence,
                "phase": "start",
                "at": now(),
                "replayable": portable,
                "arguments": payload,
            }
            if omission:
                record["omissionReason"] = omission
            if self._calls <= 2000:
                self._enqueue_locked("observations", record)
            else:
                self._dropped += 1
            return _Call(self, fields, portable, retained=self._calls <= 2000)

    def _finish(
        self,
        call: _Call,
        result: Any,
        *,
        error: BaseException | None,
        payload: dict[str, Any] | None,
        omission: str | None,
        sources: Any,
    ) -> None:
        record: dict[str, Any] = {
            **call.fields,
            "id": str(uuid4()),
            "phase": "finish",
            "at": now(),
            "replayable": call.portable and not omission,
        }
        try:
            if error is not None:
                cancelled = isinstance(error, (asyncio.CancelledError, GeneratorExit))
                record["outcome"] = "cancelled" if cancelled else "error"
                record["error"] = {"type": type(error).__name__}
                if cancelled:
                    record["replayable"] = False
                if payload is not None:
                    record["result"] = payload
            elif omission:
                record["outcome"] = "incomplete"
                if payload is not None:
                    record["result"] = payload
            else:
                record["outcome"] = "success"
                cleaned = self.scenes._clean("result", result) if payload is None else result
                record["result"] = payload or _payload.encode(cleaned)
                if payload is None and (
                    result != cleaned
                    if isinstance(result, bytes) or result is ABSENT
                    else canonical_json(result) != canonical_json(cleaned)
                ):
                    record["replayable"] = False
                    omission = "redacted_result"
            if sources:
                record["sources"] = [
                    self._source(source, call.fields["callId"]) for source in sources
                ]
        except BaseException:
            record.pop("result", None)
            record.pop("sources", None)
            record["outcome"], record["replayable"] = "incomplete", False
            omission = "nonportable_result"
        if omission:
            record["omissionReason"] = omission
        with self._lock:
            if call.done:
                return
            call.done = True
            self._pending -= 1
            self._sequence += 1
            record["sequence"] = self._sequence
            if call.retained:
                self._enqueue_locked("observations", record)
            else:
                self._dropped += 1

    def _source(self, source: SourceFile, call_id: str | None = None) -> dict[str, Any]:
        if source.relation not in {"query_attachment", "tool_source"}:
            raise ValueError("Only source-document relations are supported.")
        result: dict[str, Any] = {
            "id": str(uuid4()),
            "content": "reference_only" if source.data is None else "complete",
            "relation": source.relation,
            "name": source.name,
            "mimeType": source.mime_type,
        }
        if call_id:
            result["callId"] = call_id
        if source.data is not None:
            if not isinstance(source.data, bytes) or len(source.data) > 25 * 1024 * 1024:
                raise ValueError("Unsupported source bytes.")
            data = self.scenes._clean("source_bytes", source.data)
            if not isinstance(data, bytes):
                raise ValueError("Source sanitizer must return bytes.")
            result.update(byteSize=len(data), sha256=sha256(data))
            result["_source_blob"] = _payload.Blob(
                data, "bytes", source.mime_type, source.name, "source"
            )
        if source.uri:
            from .http import safe_url

            result["uri"] = safe_url(source.uri)
        if source.source_version:
            result["sourceVersion"] = source.source_version
        if source.metadata is not None:
            result["metadata"] = self.scenes._clean("source_metadata", source.metadata)
        return result

    def add_source(self, source: SourceFile) -> bool:
        try:
            record = self._source(source)
            with self._lock:
                previous = self._dropped
                self._enqueue_locked("sources", record)
                return previous == self._dropped
        except BaseException:
            with self._lock:
                self._dropped += 1
            return False

    def _upload(self, blob: _payload.Blob) -> dict[str, Any]:
        key = sha256(blob.data) + ":" + blob.purpose + ":" + blob.encoding
        if key not in self._upload_cache:
            self._upload_cache[key] = self.scenes.api.upload(
                blob, idempotency_key=self.producer_id + ":" + sha256(key.encode())
            )
        return self._upload_cache[key]

    def _drain(self) -> FinalizeResult:
        try:
            if self._scene_id is None:
                created = self.scenes.api.request(
                    "POST", "/scenes", _payload.materialize(self._create, self._upload)
                )
                self._scene_id, self._revision = created["id"], created["captureRevision"]
                if self._input_size:
                    self.scenes._release(self._input_size)
                    self._input_size = 0
                self._create.pop("input", None)
            path = "/scenes/" + identifier(self._scene_id)
            with self._lock:
                count = len(self._queue)
            # Each record has its own stable idempotency identity. Small requests are intentional;
            # a failed acknowledgement retries exactly that body, never a changed batch.
            for _ in range(count):
                with self._lock:
                    route, record, byte_size = self._queue[0]
                body = {
                    "idempotencyKey": record["id"],
                    route: [_payload.materialize(record, self._upload)],
                }
                result = self.scenes.api.request("POST", path + "/" + route, body)
                if result.get("accepted") != 1:
                    raise ValueError("Invalid acknowledgement.")
                self._revision = result["captureRevision"]
                with self._lock:
                    self._queue.pop(0)
                self.scenes._release(byte_size, 1)
            with self._lock:
                pending, dropped, sequence = self._pending, self._dropped, self._sequence
                pending += len(self._queue)
            producers = [
                {
                    "producerId": self.producer_id,
                    "lastSequence": sequence,
                    "pending": pending,
                    "dropped": dropped,
                }
            ]
            for attempt in range(3):
                if self._finalize_body is None or (
                    self._finalize_body["expectedCaptureRevision"] != self._revision
                    or self._finalize_body["producers"] != producers
                ):
                    self._finalize_body = {
                        "idempotencyKey": str(uuid4()),
                        "expectedCaptureRevision": self._revision,
                        "producers": producers,
                        "endedAt": now(),
                    }
                try:
                    finalized = self.scenes.api.request(
                        "POST", path + "/finalize", self._finalize_body
                    )
                    break
                except SceneTransportError as error:
                    if error.status_code != 409 or attempt == 2:
                        raise
                    current = self.scenes.api.request("GET", path)
                    self._revision = current["captureRevision"]
                    self._finalize_body = None
            snapshot = Snapshot(finalized["sceneId"], finalized["revision"], finalized["digest"])
            return FinalizeResult(snapshot, pending, dropped)
        except Exception:
            with self._lock:
                return FinalizeResult(
                    None, self._pending + len(self._queue), self._dropped, "export_failed"
                )

    def finalize(self, *, timeout: float = 30) -> FinalizeResult:
        if timeout <= 0:
            raise ValueError("Finalization timeout must be positive.")
        with self._worker_lock:
            if self._worker is None:
                self._worker = Event()
                done = self._worker

                def work():
                    try:
                        self._result = self._drain()
                    finally:
                        done.set()

                Thread(target=work, name="hue-scene-finalize", daemon=True).start()
            done = self._worker
        if not done.wait(timeout):
            with self._lock:
                return FinalizeResult(
                    None, self._pending + len(self._queue), self._dropped, "timeout"
                )
        with self._worker_lock:
            result = self._result
            self._worker = None
        assert result is not None
        return result

    async def afinalize(self, *, timeout: float = 30) -> FinalizeResult:
        return await asyncio.to_thread(self.finalize, timeout=timeout)


class _CaptureStream:
    def __init__(self, stream: Any, call: _Call, serializer, sources) -> None:
        self._stream, self._call = stream, call
        self._iterator = None
        self._serializer, self._sources = serializer, sources
        self._items: list[dict[str, Any]] = []
        self._bytes = 0
        self._omission = None

    def __aiter__(self):
        return self

    def _finish(self, **kwargs):
        self._call.capture.scenes._release(self._bytes)
        self._bytes = 0
        try:
            self._call.finish(**kwargs)
        finally:
            self._items = []

    async def __anext__(self):
        scenes = self._call.capture.scenes
        token = scenes._parents.set((*scenes._parents.get(), self._call.fields["callId"]))
        try:
            if self._iterator is None:
                self._iterator = self._stream.__aiter__()
            item = await self._iterator.__anext__()
        except StopAsyncIteration:
            payload = {"kind": "stream", "items": self._items}
            # Transfer the reservation to the queued immutable finish record.
            scenes._release(self._bytes)
            self._bytes = 0
            self._finish(payload=payload, omission=self._omission)
            raise
        except BaseException as error:
            self._finish(
                error=error,
                omission="stream_interrupted",
                payload={"kind": "stream", "items": self._items},
            )
            raise
        finally:
            scenes._parents.reset(token)
        if self._omission is None:
            try:
                value = self._serializer(item) if self._serializer else item
                cleaned = scenes._clean("stream_item", value)
                encoded = _payload.encode(cleaned)
                changed = (
                    value != cleaned
                    if isinstance(value, bytes) or value is ABSENT
                    else canonical_json(value) != canonical_json(cleaned)
                )
                if changed:
                    self._omission = "redacted_stream"
                byte_size = _payload.size(encoded)
                if len(self._items) >= 2000 or not scenes._reserve(byte_size):
                    self._omission = "stream_limit"
                else:
                    self._bytes += byte_size
                    self._items.append(encoded)
            except BaseException:
                self._omission = "nonportable_stream"
        return item

    async def aclose(self) -> None:
        try:
            if hasattr(self._stream, "aclose"):
                await self._stream.aclose()
        finally:
            self._finish(omission="stream_closed", payload={"kind": "stream", "items": self._items})
