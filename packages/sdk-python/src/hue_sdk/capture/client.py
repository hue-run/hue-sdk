from __future__ import annotations

import asyncio
import json
import threading
import time
import zlib
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import Any, TypeVar
from urllib.parse import urlsplit
from uuid import uuid4

import requests
from opentelemetry import trace

from ..evals._json import MISSING, json_value
from ..transport import normalize_base_url
from ._json import canonical_json, clean_json, request_key, sha256

T = TypeVar("T")


class _CaptureRequestError(RuntimeError):
    def __init__(self, status: int) -> None:
        self.status = status
        super().__init__("Capture request failed")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _copy(value: Any, limit: int = 300 * 1024) -> Any:
    # Validation precedes traversal: reject user objects, accessors, cycles and excessive graphs.
    budget = 0

    def bound(item: Any, depth: int = 0) -> None:
        nonlocal budget
        budget += 8
        if depth > 40 or budget > limit * 2:
            raise ValueError("Capture value exceeds limits")
        if type(item) is str:
            if len(item) > limit:
                raise ValueError("Capture string exceeds limit")
            budget += len(item.encode("utf-8"))
        elif type(item) is dict:
            for key, child in item.items():
                bound(key, depth + 1)
                bound(child, depth + 1)
        elif type(item) is list:
            for child in item:
                bound(child, depth + 1)
        if budget > limit * 2:
            raise ValueError("Capture value exceeds limits")

    bound(value)
    json_value(value, limit, max_nodes=100000, max_depth=40)
    result = canonical_json(value)
    if len(result) > limit:
        raise ValueError("Capture value exceeds limit")
    return json.loads(result)


def _upload_headers(value: Any, content_type: str) -> dict[str, str]:
    def text(item: Any) -> str:
        if (
            type(item) is not str
            or not item
            or len(item) > 255
            or any(ord(char) < 32 or ord(char) == 127 for char in item)
        ):
            raise ValueError("Invalid upload header")
        return item

    headers = {"content-type": text(content_type)}
    if value is None:
        return headers
    if type(value) is not dict:
        raise ValueError("Invalid upload headers")
    for name, raw in value.items():
        lower, field = text(name).lower(), text(raw)
        if lower == "content-type" and field == content_type:
            headers[lower] = field
        elif lower == "x-vercel-blob-access" and field == "private":
            headers[lower] = field
        else:
            raise ValueError("Unsupported upload header")
    return headers


class CaptureSession:
    """Explicit async/sync tool wrappers preserve live results and exceptions.

    Export is explicit and bounded. No background tasks, live fallbacks, model calls,
    automatic file reads, transport interception, or inference of missing state.
    """

    def __init__(
        self,
        *,
        source_content: bool,
        api_key: str,
        bindings: list[dict[str, Any]],
        base_url: str = "https://app.hue.run",
        external_trace_id: str | None = None,
        session_id: str | None = None,
        input: Any = MISSING,
        producer_id: str | None = None,
        idempotency_key: str | None = None,
        timeout_seconds: float = 10,
        max_queue_bytes: int = 8 * 1024 * 1024,
        max_queue_records: int = 2048,
        redact: Callable[[Any], Any] | None = None,
    ) -> None:
        if type(source_content) is not bool:
            raise TypeError("Choose source_content explicitly")
        if source_content and (
            not isinstance(api_key, str)
            or not api_key
            or any(c.isspace() or c == "\0" for c in api_key)
            or len(api_key) > 4096
        ):
            raise ValueError("A valid Hue project API key is required")
        if not 0.1 <= timeout_seconds <= 60:
            raise ValueError("timeout_seconds must be 0.1–60")
        if type(max_queue_records) is not int or not 1 <= max_queue_records <= 4000:
            raise ValueError("max_queue_records must be 1–4000")
        if type(max_queue_bytes) is not int or not 1024 <= max_queue_bytes <= 8 * 1024 * 1024:
            raise ValueError("max_queue_bytes must be 1024–8388608")
        self._enabled = source_content
        self._url = normalize_base_url(base_url) if source_content else "https://app.hue.run"
        self._key = api_key if source_content else ""
        self._timeout = timeout_seconds
        self._redact = redact
        self._max_bytes, self._max_records = max_queue_bytes, max_queue_records
        self._bindings = _copy(bindings) if source_content else []
        self.producer_id = producer_id or str(uuid4())
        self._queue: list[tuple[str, Any, int]] = []
        self._bytes = self._sequence = self._dropped = self._open = self._uploads = 0
        self._id: str | None = None
        self._revision = 0
        self._lock = threading.RLock()
        self._export_lock = threading.RLock()
        self._batch: tuple[dict[str, Any], int, int] | None = None
        self._finalization: dict[str, Any] | None = None
        self._create = {
            "idempotencyKey": idempotency_key or str(uuid4()),
            "producerId": self.producer_id,
            "bindings": self._bindings,
            "capturePolicy": {"sourceContent": True, "redactionVersion": "1"},
            "startedAt": _now(),
        }
        if external_trace_id:
            self._create["externalTraceId"] = external_trace_id
        if session_id:
            self._create["sessionId"] = session_id
        if source_content and input is not MISSING:
            try:
                payload, changed = self._payload(input)
                self._create["input"] = payload
                self._dropped += int(changed)
            except Exception:
                self._dropped += 1

    def _payload(self, value: Any) -> tuple[dict[str, Any], bool]:
        original = _copy(value, 256 * 1024)
        safe = clean_json(original)
        if self._redact:
            safe = clean_json(_copy(self._redact(safe), 256 * 1024))
        result = {"kind": "json", "value": safe}
        if len(canonical_json(result)) > 256 * 1024:
            raise ValueError("Capture payload exceeds inline limit")
        return result, canonical_json(original) != canonical_json(safe)

    def _enqueue(self, kind: str, value: Any) -> None:
        if not self._enabled:
            return
        try:
            safe = _copy(value)
            size = len(canonical_json(safe))
            with self._lock:
                if len(self._queue) >= self._max_records or self._bytes + size > self._max_bytes:
                    self._dropped += 1
                    return
                self._queue.append((kind, safe, size))
                self._bytes += size
        except Exception:
            with self._lock:
                self._dropped += 1

    def state_evidence(self, value: dict[str, Any]) -> None:
        if not self._enabled:
            return
        try:
            original = _copy(value)
            safe = clean_json(original)
            if self._redact:
                safe = clean_json(_copy(self._redact(safe)))
            if canonical_json(original) != canonical_json(safe):
                safe["boundary"]["omissions"].append("credential_redaction")
            self._enqueue("stateEvidence", safe)
        except Exception:
            with self._lock:
                self._dropped += 1

    def source(self, value: dict[str, Any]) -> None:
        if not self._enabled:
            return
        try:
            original = _copy(value)
            safe = clean_json(original)
            if self._redact:
                safe = clean_json(_copy(self._redact(safe)))
            if canonical_json(original) != canonical_json(safe):
                safe["content"] = "partial"
            self._enqueue("sources", safe)
        except Exception:
            with self._lock:
                self._dropped += 1

    def _observation(self, handle: dict[str, Any], **fields: Any) -> None:
        with self._lock:
            self._sequence += 1
            value = {
                **handle,
                "id": str(uuid4()),
                "sequence": self._sequence,
                "at": _now(),
                **fields,
            }
            self._enqueue("observations", value)

    def _begin(self, binding_id: str, operation: str, arguments: Any) -> dict[str, Any] | None:
        if not self._enabled:
            return None
        with self._lock:
            self._open += 1
        try:
            binding = next(b for b in self._bindings if b["id"] == binding_id)
            payload, changed = self._payload(arguments)
            handle = {
                "callId": str(uuid4()),
                "producerId": self.producer_id,
                "bindingId": binding_id,
                "operation": operation,
                "contractVersion": binding["contractVersion"],
                "requestKey": request_key(
                    binding_id, operation, binding["contractVersion"], payload["value"]
                ),
                "replayable": not changed,
            }
            if changed:
                handle["omissionReason"] = "redacted_arguments"
            span = trace.get_current_span().get_span_context()
            if span.is_valid:
                handle["externalSpanId"] = format(span.span_id, "016x")
            self._observation(handle, phase="start", arguments=payload)
            return handle
        except Exception:
            with self._lock:
                self._dropped += 1
            return None

    def _finish(self, handle: dict[str, Any] | None, result: Any, failed: bool = False) -> None:
        if not self._enabled:
            return
        try:
            if handle:
                if failed:
                    self._observation(
                        handle, phase="finish", outcome="error", error={"type": "Error"}
                    )
                else:
                    try:
                        payload, changed = self._payload(result)
                        fields = {
                            "phase": "finish",
                            "outcome": "success",
                            "result": payload,
                            "replayable": handle["replayable"] and not changed,
                        }
                        if changed:
                            fields["omissionReason"] = "redacted_result"
                        self._observation(handle, **fields)
                    except Exception:
                        self._observation(
                            handle,
                            phase="finish",
                            outcome="incomplete",
                            replayable=False,
                            omissionReason="unsupported_result",
                        )
        finally:
            with self._lock:
                self._open -= 1

    def observe(self, binding_id: str, operation: str, arguments: Any, live: Callable[[], T]) -> T:
        handle = self._begin(binding_id, operation, arguments)
        try:
            result = live()
        except BaseException:
            self._finish(handle, None, True)
            raise
        self._finish(handle, result)
        return result

    async def aobserve(
        self, binding_id: str, operation: str, arguments: Any, live: Callable[[], Awaitable[T]]
    ) -> T:
        handle = self._begin(binding_id, operation, arguments)
        try:
            result = await live()
        except BaseException:
            self._finish(handle, None, True)
            raise
        self._finish(handle, result)
        return result

    def _request(self, method: str, path: str, body: Any, deadline: float) -> Any:
        remaining = min(self._timeout, deadline - time.monotonic())
        if remaining <= 0:
            raise TimeoutError("Capture deadline elapsed")
        with requests.request(
            method,
            self._url + "/api/v1/captures" + path,
            headers={
                "Authorization": f"Bearer {self._key}",
                "Content-Type": "application/json",
                "Accept-Encoding": "gzip",
            },
            data=None if body is None else canonical_json(body),
            timeout=remaining,
            allow_redirects=False,
            stream=True,
        ) as response:
            if not 200 <= response.status_code < 300:
                raise _CaptureRequestError(response.status_code)
            encoding = response.headers.get("Content-Encoding", "identity").strip().lower()
            if encoding not in ("identity", "gzip"):
                raise ValueError("Unsupported capture response encoding")
            decoder = zlib.decompressobj(16 + zlib.MAX_WBITS) if encoding == "gzip" else None
            chunks, size, wire_size = [], 0, 0
            limit = 1024 * 1024
            # Decode separately: urllib3's decoded read1 can keep reading internally
            # until compressed data produces output, hiding a trickling peer from the deadline.
            while True:
                if time.monotonic() >= deadline:
                    raise TimeoutError("Capture deadline elapsed")
                raw = response.raw.read1(8192, decode_content=False)
                if time.monotonic() >= deadline:
                    raise TimeoutError("Capture deadline elapsed")
                if not raw:
                    break
                wire_size += len(raw)
                if wire_size > limit:
                    raise ValueError("Capture response exceeds limit")
                while raw:
                    if time.monotonic() >= deadline:
                        raise TimeoutError("Capture deadline elapsed")
                    if decoder is None:
                        chunk, raw = raw, b""
                    else:
                        if decoder.eof:
                            decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
                        chunk = decoder.decompress(raw, limit - size + 1)
                        raw = decoder.unused_data or decoder.unconsumed_tail
                    size += len(chunk)
                    if size > limit:
                        raise ValueError("Capture response exceeds limit")
                    if chunk:
                        chunks.append(chunk)
            if decoder is not None and not decoder.eof:
                raise ValueError("Truncated capture response")
            return json.loads(b"".join(chunks))

    def _ensure_created(self, deadline: float) -> None:
        if not self._id:
            value = self._request("POST", "", self._create, deadline)
            from ..evals._json import uuid

            self._id, self._revision = uuid(value["id"]), value["captureRevision"]

    def _report(self, status: str) -> dict[str, Any]:
        with self._lock:
            result = {
                "status": status,
                "pending": len(self._queue) + self._open + self._uploads,
                "dropped": self._dropped,
            }
            if self._id:
                result.update(captureId=self._id, revision=self._revision)
            return result

    def _drain(self, deadline: float) -> dict[str, Any]:
        if not self._enabled:
            return self._report("disabled")
        try:
            self._ensure_created(deadline)
            while self._queue:
                if not self._batch:
                    body: dict[str, Any] = {
                        "idempotencyKey": str(uuid4()),
                        "observations": [],
                        "sources": [],
                        "stateEvidence": [],
                    }
                    count, size = 0, 0
                    with self._lock:
                        for kind, value, length in self._queue[:20]:
                            if size + length > 850 * 1024:
                                break
                            body[kind].append(value)
                            count, size = count + 1, size + length
                        self._batch = body, count, size
                value = self._request("POST", f"/{self._id}/append", self._batch[0], deadline)
                self._revision = value["captureRevision"]
                with self._lock:
                    del self._queue[: self._batch[1]]
                    self._bytes -= self._batch[2]
                    self._batch = None
            return self._report("flushed")
        except Exception:
            return self._report("failed")

    def flush(self, *, deadline_seconds: float = 30) -> dict[str, Any]:
        deadline = time.monotonic() + min(30, max(0.001, deadline_seconds))
        with self._export_lock:
            return self._drain(deadline)

    def finalize(self, *, deadline_seconds: float = 30) -> dict[str, Any]:
        deadline = time.monotonic() + min(30, max(0.001, deadline_seconds))
        with self._export_lock:
            if not self._enabled:
                return self._report("disabled")
            try:
                for attempt in range(2):
                    recovering = self._finalization is not None
                    if not self._finalization:
                        self._drain(deadline)
                        self._ensure_created(deadline)
                        barrier = self._request(
                            "POST",
                            f"/{self._id}/append",
                            {
                                "idempotencyKey": str(uuid4()),
                                "observations": [],
                                "sources": [],
                                "stateEvidence": [],
                            },
                            deadline,
                        )
                        self._revision = barrier["captureRevision"]
                        with self._lock:
                            self._finalization = {
                                "idempotencyKey": str(uuid4()),
                                "expectedCaptureRevision": self._revision,
                                "producers": [
                                    {
                                        "producerId": self.producer_id,
                                        "lastSequence": self._sequence,
                                        "pending": len(self._queue) + self._open + self._uploads,
                                        "dropped": self._dropped,
                                    }
                                ],
                                "endedAt": _now(),
                            }
                    pending = self._finalization
                    try:
                        value = self._request("POST", f"/{self._id}/finalize", pending, deadline)
                    except _CaptureRequestError as error:
                        # Only a decided conflict replaces the exact uncertain request.
                        if error.status == 409:
                            self._finalization = None
                            if attempt == 0:
                                continue
                        raise
                    self._finalization = None
                    producer = pending["producers"][0]
                    with self._lock:
                        changed = (
                            self._revision > value["revision"]
                            or self._sequence > producer["lastSequence"]
                            or self._dropped != producer["dropped"]
                            or len(self._queue) + self._open + self._uploads != producer["pending"]
                        )
                    if recovering and changed and attempt == 0:
                        continue
                    return {
                        **self._report("finalized"),
                        "revision": value["revision"],
                        "digest": value["digest"],
                        "omissions": value["omissions"],
                    }
                return self._report("failed")
            except Exception:
                return self._report("failed")

    async def afinalize(self, *, deadline_seconds: float = 30) -> dict[str, Any]:
        return await asyncio.to_thread(self.finalize, deadline_seconds=deadline_seconds)

    def upload_source(
        self, *, filename: str, content_type: str, data: bytes
    ) -> dict[str, Any] | None:
        if not self._enabled:
            return None
        with self._lock:
            if (
                self._uploads >= 2
                or type(data) is not bytes
                or not 1 <= len(data) <= 25 * 1024 * 1024
            ):
                self._dropped += 1
                return None
            self._uploads += 1
        deadline = time.monotonic() + 30
        try:
            digest = sha256(data)
            with self._export_lock:
                self._ensure_created(deadline)
            artifact = self._request(
                "POST",
                f"/{self._id}/artifacts",
                {
                    "idempotencyKey": str(uuid4()),
                    "filename": filename,
                    "contentType": content_type,
                    "byteSize": len(data),
                    "sha256": digest,
                },
                deadline,
            )
            upload = self._request(
                "POST", f"/{self._id}/artifacts/{artifact['id']}/upload", {}, deadline
            )
            upload_url = upload["uploadUrl"]
            if (
                type(upload_url) is not str
                or len(upload_url) > 8192
                or any(char.isspace() or ord(char) < 32 or ord(char) == 127 for char in upload_url)
            ):
                raise ValueError("Invalid upload capability")
            url = urlsplit(upload_url)
            if (
                url.scheme != "https"
                or not url.hostname
                or url.username is not None
                or url.password is not None
                or url.fragment
                or upload["method"] != "PUT"
            ):
                raise ValueError("Invalid upload capability")
            _ = url.port  # Validate the port before treating a failure as an uncertain write.
            headers = _upload_headers(upload.get("headers"), content_type)
            # The upload capability is the only authority: do not add netrc credentials,
            # environment proxies, automatic retries or redirected uploads.
            try:
                with requests.Session() as session:
                    session.trust_env = False
                    with session.put(
                        upload_url,
                        data=data,
                        headers=headers,
                        timeout=max(0.001, deadline - time.monotonic()),
                        allow_redirects=False,
                        stream=True,
                    ) as response:
                        if not 200 <= response.status_code < 300:
                            raise RuntimeError("Capture upload failed")
            except Exception:
                # A failed acknowledgement does not establish that the write failed.
                # Never replay the PUT; completion verifies the stored length and hash.
                pass
            self._request("POST", f"/{self._id}/artifacts/{artifact['id']}/complete", {}, deadline)
            return {
                "artifactId": artifact["id"],
                "sha256": digest,
                "byteSize": len(data),
                "mimeType": content_type,
            }
        except Exception:
            with self._lock:
                self._dropped += 1
            return None
        finally:
            with self._lock:
                self._uploads -= 1
