"""Hosted-tool credentials removed from exported tool definitions.

Mirrors the TypeScript SDK's ``tool-definitions.ts`` so both export paths replace the same keys.
"""

from __future__ import annotations

import json
import re
from typing import Any

REDACTED = "[redacted]"

# Compared case-insensitively and ignoring "-" and "_": OpenAI hosted MCP ``authorization`` and
# ``headers``, Anthropic MCP ``authorization_token``, and common API key fields.
_CREDENTIAL_KEYS = frozenset(
    {"authorization", "authorizationtoken", "headers", "apikey", "accesstoken", "xapikey"}
)
# OpenInference records each tool as ``llm.tools.{index}.tool.json_schema``.
_OPENINFERENCE_TOOL = re.compile(r"llm\.tools\.\d+\.tool\.json_schema\Z")
_DEFINITION_KEYS = frozenset({"gen_ai.tool.definitions", "ai.prompt.tools"})
_REQUEST_KEYS = frozenset({"input.value", "output.value", "llm.invocation_parameters"})
_MAX_DEPTH = 256


def _is_credential_key(key: Any) -> bool:
    return (
        isinstance(key, str) and key.lower().replace("-", "").replace("_", "") in _CREDENTIAL_KEYS
    )


class _Scrub:
    def __init__(self) -> None:
        self.changed = False

    def node(self, value: Any, depth: int = 0, parameters: bool = False) -> Any:
        """Replace every credential key's value at any depth.

        Keys directly inside a JSON Schema ``properties`` object name tool parameters (a tool
        may take a ``headers`` argument), so their schemas are kept and scrubbed like any other
        value.
        """
        if depth > _MAX_DEPTH:
            raise ValueError("Tool definition exceeds its nesting limit.")
        if isinstance(value, list):
            return [self.node(item, depth + 1) for item in value]
        if not isinstance(value, dict):
            return value
        result = {}
        for key, item in value.items():
            if not parameters and item is not None and _is_credential_key(key):
                self.changed = True
                result[key] = REDACTED
            else:
                result[key] = self.node(item, depth + 1, key == "properties")
        return result


def _parse(text: str) -> Any:
    """Parse JSON text, returning ``None`` for text that is not JSON."""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def _dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _scrub_definition_text(text: str) -> str:
    parsed = _parse(text)
    if not isinstance(parsed, (dict, list)):
        return text
    scrub = _Scrub()
    scrubbed = scrub.node(parsed)
    return _dump(scrubbed) if scrub.changed else text


def _scrub_request_text(text: str) -> str:
    """Replace credentials in the ``tools`` and ``mcp_servers`` entries of a raw request only."""
    if '"tools"' not in text and '"mcp_servers"' not in text:
        return text
    parsed = _parse(text)
    if not isinstance(parsed, dict):
        return text
    scrub = _Scrub()
    request = dict(parsed)
    for field in ("tools", "mcp_servers"):
        if isinstance(request.get(field), (dict, list)):
            request[field] = scrub.node(request[field])
    return _dump(request) if scrub.changed else text


def scrub_tool_credentials(key: str, value: Any) -> Any:
    """Remove hosted-tool credentials from an exported attribute value.

    Tool definitions come from OpenTelemetry GenAI (``gen_ai.tool.definitions``), AI SDK 6
    (``ai.prompt.tools``, one JSON string per tool) and OpenInference
    (``llm.tools.{i}.tool.json_schema``, plus the raw request in ``input.value``). Other
    attributes, and values that are not JSON, are returned unchanged. Metadata-only export
    removes all of these attributes anyway. A definition nested too deeply to inspect raises
    ``ValueError`` so the record is dropped rather than exported with credentials.
    """
    if key in _DEFINITION_KEYS or _OPENINFERENCE_TOOL.match(key):
        scrub = _scrub_definition_text
    elif key in _REQUEST_KEYS:
        scrub = _scrub_request_text
    else:
        return value
    if isinstance(value, str):
        return scrub(value)
    if isinstance(value, (list, tuple)):
        return type(value)(scrub(item) if isinstance(item, str) else item for item in value)
    return value
