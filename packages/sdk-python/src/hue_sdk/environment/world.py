"""The world handoff of the World API: mirror URLs, the world token and agent configuration.

A world the simulation gateway serves comes back from ``create_run`` with a token, mirror URLs
(``surfaces``), environment carriers (``env``) and an MCP configuration (``mcpConfig``). The agent
is pointed at the mirrors by configuration only; these helpers build that configuration without
letting the project key reach the agent and without logging the token.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from copy import deepcopy

from .types import EnvironmentRun, LegacyMcpCapability, WorldHandoff

#: Variables that authenticate against Hue's control plane rather than a simulated provider.
HUE_CONTROL_PLANE_VARIABLES: tuple[str, ...] = (
    "HUE_API_KEY",
    "HUE_MCP_KEY",
    "HUE_PROJECT_KEY",
    "HUE_SERVICE_KEY",
)
# Hue's own credential shapes: project keys, attempt grants and the project MCP key.
_HUE_CREDENTIAL_SHAPE = re.compile(r"^hue_(sk|attempt|mcp)_")


def world_handoff(run: EnvironmentRun) -> WorldHandoff | None:
    """The world an agent acts on through provider mirrors, or ``None`` for a world created
    while the gateway was off (that world has Hue-native tools and no mirror URLs)."""
    if not (run.get("token") and "env" in run and "mcpConfig" in run and "surfaces" in run):
        return None
    world_id = run.get("worldId") or run["id"]
    return {
        "id": world_id,
        "token": run["token"],
        "expiresAt": run["expiresAt"],
        "lifecycle": run.get("lifecycle", "live"),
        "completingUntil": run.get("completingUntil"),
        "traceparent": run.get("traceparent"),
        "baggage": run.get("baggage") or f"hue-world={world_id}",
        "surfaces": deepcopy(run["surfaces"]),
        "env": dict(run["env"]),
        "mcpConfig": deepcopy(run["mcpConfig"]),
    }


def is_hue_control_plane_credential(name: str, value: str | None) -> bool:
    """True for a control-plane variable by name, or for any variable holding a Hue credential."""
    if name in HUE_CONTROL_PLANE_VARIABLES:
        return True
    return isinstance(value, str) and _HUE_CREDENTIAL_SHAPE.match(value.strip()) is not None


def strip_hue_control_plane_credentials(parent: Mapping[str, str]) -> dict[str, str]:
    """The parent's variables without Hue control-plane credentials."""
    return {
        name: value
        for name, value in parent.items()
        if isinstance(value, str) and not is_hue_control_plane_credential(name, value)
    }


def legacy_mcp_capability(world: WorldHandoff) -> LegacyMcpCapability | None:
    """The ``{url, token, expiresAt}`` shape the ``hue_sim_`` capability had, projected from the
    world's first MCP mirror for one compatibility release; ``None`` without an MCP surface."""
    servers = list(world["mcpConfig"]["mcpServers"].values())
    if not servers:
        return None
    return {"url": servers[0]["url"], "token": world["token"], "expiresAt": world["expiresAt"]}


def agent_environment(
    world: WorldHandoff,
    *,
    parent: Mapping[str, str] | None = None,
    include_hue_credentials: bool = False,
    legacy_mcp_variables: bool = True,
) -> dict[str, str]:
    """The environment for an agent child process running one case: the parent's variables
    minus Hue control-plane credentials (unless ``include_hue_credentials``), then the world's
    carriers, which win. ``legacy_mcp_variables`` also sets ``HUE_MCP_URL``, ``HUE_MCP_TOKEN``
    and ``HUE_MCP_EXPIRES_AT`` from the first MCP mirror, the names the ``hue_sim_`` bridge
    used. Nothing here is logged."""
    source = os.environ if parent is None else parent
    child = (
        {name: value for name, value in source.items() if isinstance(value, str)}
        if include_hue_credentials
        else strip_hue_control_plane_credentials(source)
    )
    child.update(world["env"])
    if legacy_mcp_variables:
        legacy = legacy_mcp_capability(world)
        if legacy is not None:
            child["HUE_MCP_URL"] = legacy["url"]
            child["HUE_MCP_TOKEN"] = legacy["token"]
            child["HUE_MCP_EXPIRES_AT"] = legacy["expiresAt"]
    return child


@contextmanager
def mcp_config_file(world: WorldHandoff, *, directory: str | None = None) -> Iterator[str]:
    """Write the world's ``mcpConfig`` as an owner-only file (mode 0600 in a private 0700
    directory) for the duration of the block and remove the directory afterwards. The file
    carries the world token; never log its contents."""
    private = tempfile.mkdtemp(prefix="hue-world-", dir=directory)
    try:
        os.chmod(private, 0o700)
        path = os.path.join(private, "mcp.json")
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(world["mcpConfig"], handle, indent=2)
            handle.write("\n")
        yield path
    finally:
        shutil.rmtree(private, ignore_errors=True)
