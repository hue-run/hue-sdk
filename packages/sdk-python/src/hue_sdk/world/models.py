"""Project-scoped World models and reconstructed starting states."""

from __future__ import annotations

import threading
from typing import Literal, TypedDict
from urllib.parse import urlencode
from uuid import uuid4

from ..evals._json import uuid
from .client import WorldClient
from .readiness import WorldModelProcessing, WorldPreparationProgress
from .types import WorldHandoff


class WorldEntity(TypedDict):
    namespace: str
    id: str


class _WorldModelOptional(TypedDict, total=False):
    processing: WorldModelProcessing


class WorldModel(_WorldModelOptional):
    id: str
    projectId: str
    entity: WorldEntity
    name: str
    createdAt: str
    lastUsedAt: str | None
    evidenceCutoff: int
    status: Literal["ready", "preparing", "erased"]


class _AccountOptional(TypedDict, total=False):
    scope: str


class WorldModelAccount(_AccountOptional):
    id: str
    providerId: str
    providerInstanceKey: str
    accountId: str
    generation: int
    syntheticPrincipalId: str


class StartingWorld(TypedDict):
    id: str
    modelId: str
    at: str
    evidenceCutoff: int
    digest: str | None
    status: Literal["ready", "preparing"]


class _CursorPage(TypedDict, total=False):
    nextCursor: str


class WorldModelPage(_CursorPage):
    items: list[WorldModel]


class WorldModelAccountPage(_CursorPage):
    items: list[WorldModelAccount]


class WorldModelResult(TypedDict):
    worldModel: WorldModel


class _PreparationOptional(TypedDict, total=False):
    preparation: WorldPreparationProgress


class StartingWorldResult(_PreparationOptional):
    world: StartingWorld


class WorldInstanceResult(StartingWorldResult):
    instance: WorldHandoff


class ErasedWorldModel(TypedDict):
    erased: Literal[True]


def _page(after: str | None, limit: int | None) -> str:
    query: dict[str, str] = {}
    if after is not None:
        if not isinstance(after, str) or not after:
            raise ValueError("Page cursor must be a nonempty string.")
        query["after"] = after
    if limit is not None:
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError("Page limit must be 1–100.")
        query["limit"] = str(limit)
    return "?" + urlencode(query) if query else ""


class WorldModelClient(WorldClient):
    """Read entity histories and start isolated instances from reconstructed Worlds.

    Instance creation and reproduction carry caller-owned idempotency keys. Retrying them
    keeps its first usable starting World. An unfinished start may recover after new evidence.
    """

    def create_model(self, *, entity: WorldEntity, name: str | None = None) -> WorldModelResult:
        """Create or retrieve the model for one full project-scoped entity identity."""
        return self._request(
            "POST",
            "/world-models",
            {"entity": entity, **({"name": name} if name is not None else {})},
        )

    def list_models(self, *, after: str | None = None, limit: int | None = None) -> WorldModelPage:
        """List models without reading their evidence or runtime state."""
        return self._request("GET", f"/world-models{_page(after, limit)}")

    def get_model(self, model_id: str) -> WorldModelResult:
        """Read a model's identity and committed evidence cutoff."""
        return self._request("GET", f"/world-models/{uuid(model_id)}")

    def list_accounts(
        self, model_id: str, *, after: str | None = None, limit: int | None = None
    ) -> WorldModelAccountPage:
        """List account bindings, including multiple accounts for the same app."""
        return self._request("GET", f"/world-models/{uuid(model_id)}/accounts{_page(after, limit)}")

    def materialize(
        self, model_id: str, *, at: str, cancel_event: threading.Event | None = None
    ) -> StartingWorldResult:
        """Reconstruct a chosen time without starting an instance."""
        return self._request(
            "POST",
            f"/world-models/{uuid(model_id)}/materializations",
            {"at": at, "idempotencyKey": str(uuid4())},
            wait_for_world=True,
            cancel_event=cancel_event,
        )

    def start_instance(
        self,
        model_id: str,
        *,
        idempotency_key: str,
        at: str,
        ttl_seconds: int | None = None,
        cancel_event: threading.Event | None = None,
    ) -> WorldInstanceResult:
        """Start an isolated instance using the latest committed reconstruction."""
        return self._request(
            "POST",
            f"/world-models/{uuid(model_id)}/instances",
            {
                "idempotencyKey": idempotency_key,
                "at": at,
                **({"ttlSeconds": ttl_seconds} if ttl_seconds is not None else {}),
            },
            wait_for_world=True,
            cancel_event=cancel_event,
        )

    def reproduce_instance(
        self,
        instance_id: str,
        *,
        idempotency_key: str,
        ttl_seconds: int | None = None,
        cancel_event: threading.Event | None = None,
    ) -> WorldInstanceResult:
        """Start a fresh instance from an earlier instance's original immutable World."""
        return self._request(
            "POST",
            f"/instances/{uuid(instance_id)}/reproduce",
            {
                "idempotencyKey": idempotency_key,
                **({"ttlSeconds": ttl_seconds} if ttl_seconds is not None else {}),
            },
            wait_for_world=True,
            cancel_event=cancel_event,
        )

    def erase_model(self, model_id: str) -> ErasedWorldModel:
        """Revoke and erase the model. Erased starting Worlds cannot be reproduced."""
        return self._request("DELETE", f"/world-models/{uuid(model_id)}")
