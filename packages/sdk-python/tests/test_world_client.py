"""Canonical instance routing preserves compatibility and runtime identity."""

import json
from uuid import uuid4

import pytest

from hue_sdk.environment import EnvironmentClient, HueEnvironmentError
from hue_sdk.world import HueWorldError, WorldClient, world_handoff


def test_world_and_compatibility_routes_keep_runtime_identity(receiver):
    instance_id, version_id = str(uuid4()), str(uuid4())
    run = {
        "id": instance_id,
        "worldId": instance_id,
        "environmentVersionId": version_id,
        "token": "synthetic-instance-token",
        "expiresAt": "2026-10-17T12:00:00.000Z",
        "lifecycle": "live",
        "env": {},
        "surfaces": [],
        "mcpConfig": {"mcpServers": {}},
        "actions": [],
    }
    for _ in range(4):
        receiver.reply(200, json.dumps(run).encode(), **{"Content-Type": "application/json"})
    connection = {"api_key": "synthetic-world-key", "base_url": receiver.url}
    world = WorldClient(**connection)
    legacy = EnvironmentClient(**connection)
    created = world.create_instance(idempotency_key="new-world", world_version_id=version_id)
    handoff = world_handoff(created)
    assert handoff is not None and handoff["id"] == instance_id
    assert created["worldId"] == instance_id
    world.get_instance(instance_id)
    legacy.create_run(idempotency_key="legacy", environment_version_id=version_id)
    legacy.get_run(instance_id)
    assert [path for path, _, _ in receiver.requests] == [
        "/api/v1/instances",
        f"/api/v1/instances/{instance_id}",
        "/api/v1/environment-runs",
        f"/api/v1/environment-runs/{instance_id}",
    ]
    assert json.loads(receiver.requests[0][2])["environmentVersionId"] == version_id
    assert HueWorldError is HueEnvironmentError


def test_world_refusal_is_caught_by_existing_handlers_without_content(receiver):
    receiver.reply(403, b"private response content")
    world = WorldClient(api_key="synthetic-world-key", base_url=receiver.url)
    with pytest.raises(HueEnvironmentError) as caught:
        world.get_instance(str(uuid4()))
    assert "private response content" not in str(caught.value)
    assert "synthetic-world-key" not in str(caught.value)


def test_model_identity_and_instance_retries_preserve_request(receiver):
    from hue_sdk.world import WorldModelClient

    model_id, instance_id = str(uuid4()), str(uuid4())
    identity = "user-" + "a" * 300
    receiver.reply(
        200,
        json.dumps(
            {"worldModel": {"id": model_id, "entity": {"namespace": "user", "id": identity}}}
        ).encode(),
    )
    receiver.reply(200, b'{"items": []}')
    receiver.reply(200, b'{"world": {"evidenceCutoff": 7}}')
    receiver.reply(503, **{"Retry-After": "0"})
    result = {"world": {"evidenceCutoff": 7}, "instance": {"id": instance_id}}
    receiver.reply(200, json.dumps(result).encode())
    receiver.reply(200, json.dumps(result).encode())
    client = WorldModelClient(api_key="synthetic-world-key", base_url=receiver.url)
    assert (
        client.create_model(entity={"namespace": "user", "id": identity})["worldModel"]["entity"][
            "id"
        ]
        == identity
    )
    client.list_accounts(model_id, after=instance_id, limit=20)
    client.materialize(model_id, at="2026-10-17T00:00:00Z")
    assert (
        client.start_instance(model_id, idempotency_key="stable-start", at="2026-10-17T00:00:00Z")[
            "instance"
        ]["id"]
        == instance_id
    )
    client.reproduce_instance(instance_id, idempotency_key="stable-reproduction")
    assert (
        receiver.requests[1][0]
        == f"/api/v1/world-models/{model_id}/accounts?after={instance_id}&limit=20"
    )
    assert receiver.requests[3][2] == receiver.requests[4][2]
    assert json.loads(receiver.requests[3][2])["idempotencyKey"] == "stable-start"
    assert receiver.requests[5][0] == f"/api/v1/instances/{instance_id}/reproduce"


def test_account_tokens_are_preserved_and_inherited_tokens_are_removed():
    from hue_sdk.world import agent_environment, legacy_mcp_capability

    instance = {
        "id": str(uuid4()),
        "token": "synthetic-unscoped-token",
        "expiresAt": "2026-10-17T12:00:00.000Z",
        "lifecycle": "live",
        "env": {"HUE_SIM_ACCOUNT_WORK_MCP_TOKEN": "synthetic-work-token"},
        "mcpConfig": {
            "mcpServers": {
                "work": {
                    "type": "http",
                    "url": "https://app.hue.test/mcp",
                    "headers": {"Authorization": "Bearer synthetic-work-token"},
                }
            }
        },
    }
    legacy = legacy_mcp_capability(instance)
    assert legacy is not None and legacy["token"] == "synthetic-work-token"
    child = agent_environment(
        instance, parent={"HUE_SIM_ACCOUNT_PERSONAL_MCP_TOKEN": "stale-personal-token"}
    )
    assert child["HUE_SIM_ACCOUNT_WORK_MCP_TOKEN"] == "synthetic-work-token"
    assert "HUE_SIM_ACCOUNT_PERSONAL_MCP_TOKEN" not in child
    assert child["HUE_MCP_TOKEN"] == "synthetic-work-token"


def test_model_cursors_are_opaque_and_cannot_add_query_parameters(receiver):
    from urllib.parse import parse_qs, urlsplit

    from hue_sdk.world import WorldModelClient

    receiver.reply(200, b'{"items": []}')
    cursor = "c1.opaque+cursor&limit=999"
    client = WorldModelClient(api_key="synthetic-world-key", base_url=receiver.url)
    assert client.list_models(after=cursor, limit=20)["items"] == []
    assert parse_qs(urlsplit(receiver.requests[0][0]).query) == {"after": [cursor], "limit": ["20"]}
