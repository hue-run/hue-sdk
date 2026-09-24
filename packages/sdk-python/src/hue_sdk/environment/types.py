"""Public HTTP response types. Dictionary keys retain the API's camelCase spelling."""

from __future__ import annotations

from typing import Any, Literal, TypedDict

Json = None | bool | int | float | str | list[Any] | dict[str, Any]
RunStatus = Literal["open", "completed", "abandoned", "expired"]
FinishStatus = Literal["completed", "abandoned"]


class _StringItems(TypedDict):
    type: Literal["string"]
    maxLength: int


class _ParameterOptions(TypedDict, total=False):
    description: str
    enum: list[str]
    # Present for the runtime's bounded string-array parameters.
    items: _StringItems
    maxItems: int


class ActionParameter(_ParameterOptions):
    type: Literal["string", "number", "boolean", "array"]


class ActionSchema(TypedDict):
    type: Literal["object"]
    properties: dict[str, ActionParameter]
    required: list[str]
    additionalProperties: Literal[False]


class _ActionOptions(TypedDict, total=False):
    description: str


class ActionDefinition(_ActionOptions):
    name: str
    inputSchema: ActionSchema


class _ObservationFields(TypedDict, total=False):
    # The runtime supplies fields specific to the semantic entry that answered.
    entity: dict[str, Json]
    entities: list[dict[str, Json]]
    count: int
    action: str
    param: str
    expected: str
    unknown: list[str]
    collection: str
    id: str
    message: dict[str, Json]
    messages: list[dict[str, Json]]
    thread: dict[str, Json]
    draft: dict[str, Json]
    resultSizeEstimate: int
    nextPageToken: str | None


class OkObservation(_ObservationFields):
    status: Literal["ok"]


class ErrorObservation(_ObservationFields):
    status: Literal["error"]
    error: str


Observation = OkObservation | ErrorObservation


class Effect(TypedDict):
    kind: Literal["created", "updated", "deleted"]
    collection: str
    entityId: str
    fields: list[str]


WorldLifecycle = Literal["pending", "live", "completing", "sealed"]
WorldFlag = Literal["no_calls", "fingerprint_differs"]
WorldEvidenceSection = Literal["all", "start", "end", "diff", "ledger"]


class WorldSurface(TypedDict):
    """One pinned provider surface of one provider instance, as a mirror URL."""

    provider: str
    surface: str
    providerInstanceKey: str
    url: str
    alias: str | None


class _WorldMcpHeaders(TypedDict):
    Authorization: str


class WorldMcpServer(TypedDict):
    type: Literal["http"]
    url: str
    headers: _WorldMcpHeaders


class WorldMcpConfig(TypedDict):
    mcpServers: dict[str, WorldMcpServer]


class _WorldFields(TypedDict, total=False):
    """World API fields, present only for a world the simulation gateway serves."""

    worldId: str
    token: str
    lifecycle: WorldLifecycle
    completingUntil: str | None
    baggage: str
    traceparent: str | None
    surfaces: list[WorldSurface]
    env: dict[str, str]
    mcpConfig: WorldMcpConfig
    connection: None


class EnvironmentRun(_WorldFields):
    id: str
    environmentVersionId: str
    clockNs: str
    stateDigest: str
    maxSteps: int
    expiresAt: str
    actions: list[ActionDefinition]


class WorldHandoff(TypedDict):
    """What the World API hands an agent for one world; carries the world token, never log it."""

    id: str
    token: str
    expiresAt: str
    lifecycle: WorldLifecycle
    completingUntil: str | None
    traceparent: str | None
    baggage: str
    surfaces: list[WorldSurface]
    env: dict[str, str]
    mcpConfig: WorldMcpConfig


class LegacyMcpCapability(TypedDict):
    """The `{url, token, expiresAt}` shape the `hue_sim_` capability had."""

    url: str
    token: str
    expiresAt: str


class ActionResult(TypedDict):
    runId: str
    stepOrdinal: int
    observation: Observation
    effects: list[Effect]
    stateDigest: str
    clockNs: str
    replayed: bool
    stepsRemaining: int


class _SealedState(TypedDict, total=False):
    finalState: Json


class CoverageGapReporter(TypedDict):
    kind: Literal["project_key", "user"]
    id: str


class CoverageGap(TypedDict):
    provider: str
    operation: str
    code: str
    args: dict[str, Json]
    description: str
    reportedAt: str
    reportedBy: CoverageGapReporter


class EnvironmentCoverage(TypedDict, total=False):
    """Missing fields from older servers mean not_assessed, never verified parity."""

    validity: Literal["not_assessed", "environment_incomplete"]
    coverageGap: CoverageGap | None


class CoverageGapResult(TypedDict):
    runId: str
    validity: Literal["environment_incomplete"]
    coverageGap: CoverageGap


class _WorldStatusFields(TypedDict, total=False):
    """World API status fields; a status read never returns the token."""

    worldId: str
    lifecycle: WorldLifecycle
    completingUntil: str | None
    traceExternalId: str | None
    surfaces: list[WorldSurface]
    flags: list[WorldFlag]
    connection: None


class RunState(_SealedState, EnvironmentCoverage, _WorldStatusFields):
    id: str
    environmentVersionId: str
    executionId: str | None
    seed: str
    status: RunStatus
    stepCount: int
    maxSteps: int
    clockNs: str
    expiresAt: str
    createdAt: str
    sealedAt: str | None
    stateDigest: str


class Step(TypedDict):
    id: str
    ordinal: int
    invocationId: str
    action: str
    args: dict[str, Json]
    observation: Observation
    effects: list[Effect]
    mutated: bool
    clockNs: str
    stateDigest: str


class StepPage(TypedDict):
    items: list[Step]
    nextCursor: int | None


class _SealedRunFields(TypedDict, total=False):
    lifecycle: Literal["completing", "sealed"]
    completingUntil: str | None


class SealedRun(_SealedRunFields):
    id: str
    status: FinishStatus
    stepCount: int
    stateDigest: str
    sealedAt: str | None
