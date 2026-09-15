"""Verified immutable recordings with one atomic occurrence cursor per replay."""

from __future__ import annotations

import asyncio
import base64
import json
from collections import defaultdict
from collections.abc import Callable
from importlib.resources import files
from threading import Condition, Lock
from typing import Any
from uuid import uuid4

from jsonschema import Draft202012Validator

from . import _payload
from ._json import canonical_json, request_key, sha256
from ._transport import identifier
from .client import Scenes, now, trace_id
from .types import RecordedToolError, SceneTransportError, Snapshot, SnapshotMissError, json_copy

_SCHEMA = json.loads(files(__package__).joinpath("_schema.json").read_text())
_VALIDATOR = Draft202012Validator(_SCHEMA)


class Recording:
    def __init__(
        self,
        manifest: Any,
        digest: str,
        *,
        snapshot: Snapshot | None = None,
        scenes: Scenes | None = None,
        artifact_loader: Callable[[dict[str, Any]], bytes] | None = None,
    ) -> None:
        try:
            data = canonical_json(manifest)
            if len(data) > 64 * 1024 * 1024 or sha256(data) != digest:
                raise ValueError()
            copied = json.loads(data)
            _VALIDATOR.validate(copied)
            if snapshot is not None and (
                copied["sceneId"] != snapshot.scene_id
                or copied["revision"] != snapshot.revision
                or digest != snapshot.digest
            ):
                raise ValueError()
            self._manifest = copied
            self.snapshot = Snapshot(copied["sceneId"], copied["revision"], digest)
            self._bindings = {binding["id"]: binding for binding in copied["bindings"]}
            if len(self._bindings) != len(copied["bindings"]):
                raise ValueError()
            self._calls: dict[str, dict[str, Any]] = {}
            seen_ids: dict[str, bytes] = {}
            producer_sequences: set[tuple[str, int]] = set()
            for observation in copied["observations"]:
                existing = seen_ids.get(observation["id"])
                encoded = canonical_json(observation)
                if existing is not None:
                    if existing != encoded:
                        raise ValueError()
                    continue
                seen_ids[observation["id"]] = encoded
                sequence = (observation["producerId"], observation["sequence"])
                if sequence in producer_sequences:
                    raise ValueError()
                producer_sequences.add(sequence)
                if observation["bindingId"] not in self._bindings:
                    raise ValueError()
                call = self._calls.setdefault(observation["callId"], {})
                if observation["phase"] in call:
                    raise ValueError()
                call[observation["phase"]] = observation
            if len(self._calls) > 2000:
                raise ValueError()
            self._index: dict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
            for call in self._calls.values():
                start, finish = call.get("start"), call.get("finish")
                sample = start or finish
                binding = self._bindings[sample["bindingId"]]
                if sample["contractVersion"] != binding["contractVersion"]:
                    raise ValueError()
                if start and finish:
                    for key in (
                        "bindingId",
                        "operation",
                        "contractVersion",
                        "requestKey",
                        "producerId",
                        "callId",
                        "parentCallId",
                    ):
                        if start.get(key) != finish.get(key):
                            raise ValueError()
                    if finish["sequence"] <= start["sequence"]:
                        raise ValueError()
                self._index[
                    (sample["bindingId"], sample["operation"], sample["requestKey"])
                ].append(call)
            for calls in self._index.values():
                calls.sort(
                    key=lambda call: (
                        (call.get("start") or call["finish"])["producerId"],
                        (call.get("start") or call["finish"])["sequence"],
                    )
                )
        except Exception:
            raise SnapshotMissError("integrity") from None
        self.scenes = scenes
        self._download = artifact_loader or (scenes.api.download if scenes else None)

    @property
    def manifest(self) -> dict[str, Any]:
        return json_copy(self._manifest)

    def download_source(self, source_id: str) -> bytes:
        """Download an explicitly recorded source with full byte-size and SHA-256 verification."""
        sources = list(self._manifest["sources"])
        for observation in self._manifest["observations"]:
            sources.extend(observation.get("sources", []))
        source = next((item for item in sources if item["id"] == source_id), None)
        if source is None or not all(key in source for key in ("artifactId", "sha256", "byteSize")):
            raise SnapshotMissError("unavailable_content")
        ref = {key: source[key] for key in ("artifactId", "sha256", "byteSize")}
        ref.update(mimeType=source.get("mimeType", "application/octet-stream"), encoding="bytes")
        return _payload.decode({"kind": "blob", "ref": ref}, self._blob)

    async def adownload_source(self, source_id: str) -> bytes:
        return await asyncio.to_thread(self.download_source, source_id)

    def replay(self, *, binding_ids: list[str], external_trace_id: str | None = None) -> Replay:
        return Replay(self, binding_ids, trace_id(external_trace_id))

    def _blob(self, ref: dict[str, Any]) -> bytes:
        if self._download is None:
            raise SnapshotMissError("unavailable_content")
        try:
            return self._download(dict(ref))
        except SnapshotMissError:
            raise
        except Exception:
            raise SnapshotMissError("unavailable_content") from None


def _outcome(call: dict[str, Any]) -> bytes:
    finish = call.get("finish", {})
    result = {key: finish.get(key) for key in ("outcome", "error", "replayable", "omissionReason")}
    result["result"] = _payload_identity(finish["result"]) if "result" in finish else None
    return canonical_json(result)


def _payload_identity(payload):
    kind = payload["kind"]
    if kind == "blob":
        return {"kind": payload["ref"]["encoding"], "sha256": payload["ref"]["sha256"]}
    if kind == "bytes":
        try:
            digest = sha256(base64.b64decode(payload["base64"], validate=True))
        except ValueError:
            digest = "invalid:" + payload["base64"]
        return {"kind": "bytes", "sha256": digest}
    if kind == "json":
        return {"kind": "json", "sha256": sha256(canonical_json(payload["value"]))}
    if kind == "http":
        return {**payload, "body": _payload_identity(payload["body"])}
    if kind == "stream":
        return {"kind": "stream", "items": [_payload_identity(item) for item in payload["items"]]}
    return payload


def _ambiguous(calls: list[dict[str, Any]]) -> bool:
    for index, left in enumerate(calls):
        for right in calls[index + 1 :]:
            if _outcome(left) == _outcome(right):
                continue
            ls, rs = left.get("start"), right.get("start")
            lf, rf = left.get("finish"), right.get("finish")
            if not all((ls, rs, lf, rf)):
                continue
            if ls["producerId"] != rs["producerId"]:
                return True
            if ls["sequence"] < rf["sequence"] and rs["sequence"] < lf["sequence"]:
                return True
    return False


class Replay:
    def __init__(self, recording: Recording, binding_ids: list[str], external_trace_id: str):
        self.recording = recording
        if not binding_ids or len(set(binding_ids)) != len(binding_ids):
            raise ValueError("Replay requires a nonempty unique binding selection.")
        if any(key not in recording._bindings for key in binding_ids):
            raise SnapshotMissError("incompatible")
        if external_trace_id == recording._manifest["externalTraceId"]:
            raise ValueError("Replay requires a fresh trace identity.")
        self._selected = {key: json_copy(recording._bindings[key]) for key in binding_ids}
        self.external_trace_id = external_trace_id
        self._check_overlap()
        self._lock = Lock()
        self._condition = Condition(self._lock)
        self._inflight = 0
        self._closed = False
        self._cursors: dict[tuple[str, str, str], int] = defaultdict(int)
        self._events: list[dict[str, Any]] = []
        self._event_sequence = self.miss_count = 0
        self.dropped_events = 0
        self._id = None
        self._token = None
        self._entered = False
        self.delivery_ok = True
        self._completion: dict[str, Any] | None = None

    @property
    def selected(self) -> dict[str, Any]:
        return json_copy(self._selected)

    def _check_overlap(self):
        http = [binding["http"] for binding in self.selected.values() if "http" in binding]
        for index, left in enumerate(http):
            for right in http[index + 1 :]:
                if left["origin"] == right["origin"] and (
                    left["pathPrefix"].startswith(right["pathPrefix"])
                    or right["pathPrefix"].startswith(left["pathPrefix"])
                ):
                    raise SnapshotMissError("overlapping_bindings")
        for call_id, call in self.recording._calls.items():
            current = call.get("start") or call["finish"]
            if current["bindingId"] not in self.selected:
                continue
            seen = {call_id}
            while current.get("parentCallId"):
                parent_id = current["parentCallId"]
                if parent_id in seen:
                    raise SnapshotMissError("integrity")
                seen.add(parent_id)
                parent = self.recording._calls.get(parent_id)
                if parent is None:
                    break
                current = parent.get("start") or parent["finish"]
                if current["bindingId"] in self.selected:
                    raise SnapshotMissError("overlapping_bindings")

    def __enter__(self) -> Replay:
        scenes = self.recording.scenes
        if self._entered or (scenes and scenes._active.get() is not None):
            raise ValueError("A replay runs once and cannot nest with capture or another replay.")
        if scenes:
            response = scenes.api.request(
                "POST",
                "/scene-replays",
                {
                    "idempotencyKey": str(uuid4()),
                    "sceneId": self.recording.snapshot.scene_id,
                    "revision": self.recording.snapshot.revision,
                    "bindingIds": list(self.selected),
                    "externalTraceId": self.external_trace_id,
                },
            )
            if not isinstance(response.get("id"), str):
                raise SceneTransportError()
            self._id = response["id"]
            self._token = scenes._active.set(self)
        self._entered = True
        return self

    def __exit__(self, exc_type, _error, _traceback) -> None:
        scenes = self.recording.scenes
        if scenes:
            scenes._active.reset(self._token)
        state = (
            "completed"
            if exc_type is None
            else (
                "interrupted"
                if issubclass(exc_type, (asyncio.CancelledError, KeyboardInterrupt))
                else "failed"
            )
        )
        self.complete(state=state)

    async def __aenter__(self) -> Replay:
        # ContextVar token must be established in the caller task, not a worker thread.
        scenes = self.recording.scenes
        if not scenes:
            return self.__enter__()
        if self._entered or scenes._active.get() is not None:
            raise ValueError("A replay runs once and cannot nest with capture or another replay.")
        response = await asyncio.to_thread(
            scenes.api.request,
            "POST",
            "/scene-replays",
            {
                "idempotencyKey": str(uuid4()),
                "sceneId": self.recording.snapshot.scene_id,
                "revision": self.recording.snapshot.revision,
                "bindingIds": list(self.selected),
                "externalTraceId": self.external_trace_id,
            },
        )
        if not isinstance(response.get("id"), str):
            raise SceneTransportError()
        self._id = response["id"]
        self._token = scenes._active.set(self)
        self._entered = True
        return self

    async def __aexit__(self, exc_type, _error, _traceback) -> None:
        if self.recording.scenes:
            self.recording.scenes._active.reset(self._token)
        state = (
            "completed"
            if exc_type is None
            else (
                "interrupted"
                if issubclass(exc_type, (asyncio.CancelledError, KeyboardInterrupt))
                else "failed"
            )
        )
        # Diagnostics continue even when the enclosing agent was cancelled.
        await asyncio.shield(asyncio.to_thread(self.complete, state=state))

    @property
    def events(self) -> list[dict[str, Any]]:
        with self._lock:
            return json_copy(self._events)

    def _event_locked(self, binding_id, operation, key, status, *, reason=None, call_id=None):
        self._event_sequence += 1
        if reason:
            self.miss_count += 1
        if len(self._events) >= 4000:
            self.dropped_events += 1
            self.delivery_ok = False
            return
        event = {
            "id": str(uuid4()),
            "sequence": self._event_sequence,
            "bindingId": binding_id,
            "operation": operation,
            "requestKey": key,
            "status": status,
            "at": now(),
        }
        if reason:
            event["reason"] = reason
        if call_id:
            event["recordedCallId"] = call_id
        self._events.append(event)

    def dispatch(
        self,
        binding_id: str,
        operation: str,
        arguments: Any,
        *,
        contract_version: str | None = None,
        result_decoder: Callable[[Any], Any] | None = None,
    ) -> Any:
        with self._condition:
            if self._closed:
                raise ValueError("Replay has completed.")
            self._inflight += 1
        try:
            return self._dispatch(
                binding_id,
                operation,
                arguments,
                contract_version=contract_version,
                result_decoder=result_decoder,
            )
        finally:
            with self._condition:
                self._inflight -= 1
                self._condition.notify_all()

    def _dispatch(
        self,
        binding_id: str,
        operation: str,
        arguments: Any,
        *,
        contract_version: str | None = None,
        result_decoder: Callable[[Any], Any] | None = None,
    ) -> Any:
        if not self._entered:
            raise ValueError("Enter the replay context before dispatching calls.")
        binding = self.selected.get(binding_id)
        if binding is None:
            raise SnapshotMissError("incompatible", binding_id, operation)
        key = request_key(binding_id, operation, binding["contractVersion"], None)
        reason = (
            "incompatible"
            if contract_version is not None and (contract_version != binding["contractVersion"])
            else None
        )
        call = None
        try:
            value = arguments() if callable(arguments) else arguments
            if self.recording.scenes:
                value = self.recording.scenes._clean("arguments", value)
            else:
                from ._json import clean_json

                value = clean_json(value)
            key = request_key(binding_id, operation, binding["contractVersion"], value)
        except Exception:
            reason = "nonportable"
        with self._lock:
            if reason is None:
                index_key = (binding_id, operation, key)
                calls = self.recording._index.get(index_key, [])
                cursor = self._cursors[index_key]
                if not calls:
                    reason = "unrecorded"
                elif _ambiguous(calls):
                    reason = "ambiguous"
                elif cursor >= len(calls):
                    reason = "exhausted"
                else:
                    self._cursors[index_key] += 1
                    call = calls[cursor]
                    start, finish = call.get("start"), call.get("finish")
                    if not start or not finish:
                        reason = "incomplete"
                    elif not start["replayable"] or not finish["replayable"]:
                        omissions = start.get("omissionReason", "") + finish.get(
                            "omissionReason", ""
                        )
                        reason = (
                            "nonportable"
                            if any(value in omissions for value in ("nonportable", "redacted"))
                            else "incomplete"
                        )
                    elif finish.get("outcome") not in {"success", "error"}:
                        reason = "incomplete"
            if reason:
                self._event_locked(binding_id, operation, key, "miss", reason=reason)
        if reason:
            raise SnapshotMissError(reason, binding_id, operation)
        assert call is not None
        finish = call["finish"]
        try:
            evidence = _payload.decode(call["start"]["arguments"], self.recording._blob)
            if request_key(binding_id, operation, binding["contractVersion"], evidence) != key:
                raise SnapshotMissError("integrity")
            del evidence
        except (SnapshotMissError, KeyError, ValueError) as error:
            reason = error.reason if isinstance(error, SnapshotMissError) else "integrity"
            with self._lock:
                self._event_locked(binding_id, operation, key, "miss", reason=reason)
            raise SnapshotMissError(reason, binding_id, operation) from None
        if finish["outcome"] == "error":
            with self._lock:
                self._event_locked(binding_id, operation, key, "error", call_id=finish["callId"])
            error = finish.get("error", {"type": "Error"})
            raise RecordedToolError(error["type"], code=error.get("code"))
        try:
            result = _payload.decode(finish["result"], self.recording._blob)
            if result_decoder:
                result = result_decoder(result)
        except (SnapshotMissError, KeyError) as error:
            reason = error.reason if isinstance(error, SnapshotMissError) else "incomplete"
            with self._lock:
                self._event_locked(binding_id, operation, key, "miss", reason=reason)
            raise SnapshotMissError(reason, binding_id, operation) from None
        with self._lock:
            self._event_locked(binding_id, operation, key, "matched", call_id=finish["callId"])
        return result

    def complete(self, *, state: str = "completed") -> bool:
        """Retry diagnostics without rerunning calls. Caught misses remain in the event log."""
        with self._condition:
            if not self._condition.wait_for(lambda: self._inflight == 0, timeout=30):
                self.delivery_ok = False
                return False
            self._closed = True
        scenes = self.recording.scenes
        if not scenes or not self._id:
            return True
        try:
            path = "/scene-replays/" + identifier(self._id)
            # Stable per-event keys permit retry after a lost acknowledgement.
            for event in self.events:
                response = scenes.api.request(
                    "POST",
                    path + "/events",
                    {
                        "idempotencyKey": event["id"],
                        "events": [event],
                    },
                )
                if response.get("accepted") != 1:
                    raise SceneTransportError()
            if self._completion is None:
                self._completion = {
                    "idempotencyKey": str(uuid4()),
                    "state": state,
                    "endedAt": now(),
                }
            response = scenes.api.request("POST", path + "/complete", self._completion)
            self.delivery_ok = (
                response.get("state") == self._completion["state"] and self.dropped_events == 0
            )
        except Exception:
            self.delivery_ok = False
        return self.delivery_ok
