"""Duck-typed async MCP client wrapper. No global patches or live replay fallback."""

from __future__ import annotations

import asyncio
import base64
from collections.abc import Callable
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import urlsplit

from .client import Capture, Scenes
from .types import MAX_ARTIFACT_BYTES, RecordedToolError, SnapshotMissError, SourceFile


def _portable(value):
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json", by_alias=True, exclude_unset=True)
    return value


def _sources(value):
    value = _portable(value)
    if not isinstance(value, dict):
        return []
    resources = list(value.get("contents", []))
    resources.extend(
        item["resource"]
        for item in value.get("content", [])
        if isinstance(item, dict)
        and item.get("type") == "resource"
        and isinstance(item.get("resource"), dict)
    )
    sources = []
    for resource in resources[:200]:
        if not isinstance(resource, dict) or not isinstance(resource.get("uri"), str):
            continue
        uri = resource["uri"]
        data = None
        if isinstance(resource.get("text"), str):
            data = resource["text"].encode("utf-8")
        elif isinstance(resource.get("blob"), str):
            if len(resource["blob"]) > 4 * ((MAX_ARTIFACT_BYTES + 2) // 3):
                continue
            data = base64.b64decode(resource["blob"], validate=True)
        if data is not None and len(data) > MAX_ARTIFACT_BYTES:
            continue
        name = PurePosixPath(urlsplit(uri).path).name or "observed-resource"
        sources.append(
            SourceFile(name, data, resource.get("mimeType", "text/plain"), "tool_source", uri)
        )
    return sources


class SceneMCPClient:
    """Wrap an initialized client session; its connection lifecycle remains caller-owned.

    Live calls return the original SDK object. Playback returns portable dictionaries, or
    the supplied result_decoder(operation, payload), e.g. CallToolResult.model_validate.
    """

    def __init__(
        self,
        scenes: Scenes,
        binding_id: str,
        client: Any,
        *,
        result_decoder: Callable[[str, Any], Any] | None = None,
        contract_version: str = "1",
    ):
        self.scenes, self.binding_id, self.client = scenes, binding_id, client
        self.result_decoder = result_decoder
        self.contract_version = contract_version

    def _decode_result(self, operation, result):
        key = (
            "content"
            if operation.startswith("tools/call:")
            else {
                "resources/read": "contents",
                "tools/list": "tools",
                "resources/list": "resources",
                "resources/templates/list": "resourceTemplates",
            }[operation]
        )
        try:
            if not isinstance(result, dict) or not isinstance(result.get(key), list):
                raise ValueError()
            if not all(isinstance(item, dict) for item in result[key]):
                raise ValueError()
            if self.result_decoder:
                return self.result_decoder(operation, result)
            return result
        except Exception:
            raise SnapshotMissError("nonportable") from None

    async def _call(self, operation, arguments, live):
        active = self.scenes._active.get()
        replaying = (
            active is not None
            and not isinstance(active, Capture)
            and self.binding_id in active.selected
        )
        try:
            if replaying:
                return await asyncio.to_thread(
                    active.dispatch,
                    self.binding_id,
                    operation,
                    arguments,
                    contract_version=self.contract_version,
                    result_decoder=lambda result: self._decode_result(operation, result),
                    error_decoder=lambda _error: self._decode_error(operation),
                )
            result = await self.scenes.acall(
                self.binding_id,
                operation,
                arguments,
                live,
                serializer=_portable,
                sources=_sources,
                contract_version=self.contract_version,
            )
        except SnapshotMissError as error:
            result = {"isError": True, "content": [{"type": "text", "text": str(error)}]}
        except RecordedToolError:
            result = {
                "isError": True,
                "content": [{"type": "text", "text": "HUE_RECORDED_TOOL_ERROR"}],
            }
        if replaying and self.result_decoder:
            try:
                return self.result_decoder(operation, result)
            except Exception:
                # The underlying miss is already durable, even if a caller's result class
                # cannot represent the MCP error envelope.
                raise SnapshotMissError("nonportable") from None
        return result

    def _decode_error(self, operation):
        result = {"isError": True, "content": [{"type": "text", "text": "HUE_RECORDED_TOOL_ERROR"}]}
        try:
            return self.result_decoder(operation, result) if self.result_decoder else result
        except Exception:
            raise SnapshotMissError("nonportable") from None

    async def call_tool(self, name: str, arguments: dict[str, Any] | None = None, **kwargs):
        return await self._call(
            "tools/call:" + name,
            arguments or {},
            lambda: self.client.call_tool(name, arguments=arguments, **kwargs),
        )

    async def read_resource(self, uri: str, **kwargs):
        return await self._call(
            "resources/read", {"uri": str(uri)}, lambda: self.client.read_resource(uri, **kwargs)
        )

    async def list_tools(self, cursor: str | None = None, **kwargs):
        args = {} if cursor is None else {"cursor": cursor}
        return await self._call(
            "tools/list", args, lambda: self.client.list_tools(**args, **kwargs)
        )

    async def list_resources(self, cursor: str | None = None, **kwargs):
        args = {} if cursor is None else {"cursor": cursor}
        return await self._call(
            "resources/list", args, lambda: self.client.list_resources(**args, **kwargs)
        )

    async def list_resource_templates(self, cursor: str | None = None, **kwargs):
        args = {} if cursor is None else {"cursor": cursor}
        return await self._call(
            "resources/templates/list",
            args,
            lambda: self.client.list_resource_templates(**args, **kwargs),
        )
