"""Canonical instance routing preserves compatibility and runtime identity."""

import json
import os
from threading import Event
from uuid import uuid4

import pytest

from hue_sdk.environment import EnvironmentClient, HueEnvironmentError
from hue_sdk.world import HueWorldError, WorldClient, world_handoff


@pytest.mark.parametrize("fail", [False, True])
@pytest.mark.parametrize("finish_status", [200, 403])
def test_postgres_handoff_uses_same_key_and_project_and_finishes(receiver, fail, finish_status):
    project_id, version_id, instance_id = (str(uuid4()) for _ in range(3))
    url = "postgresql://user:synthetic-password@localhost/db?sslmode=verify-full"
    for body in (
        {
            "id": instance_id,
            "nativeApps": [
                {"appKey": "selected-pg", "providerId": "postgres", "state": "preparing"}
            ],
        },
        {"state": "preparing"},
        {"state": "ready", "url": url},
    ):
        receiver.reply(200, json.dumps(body).encode(), **{"Content-Type": "application/json"})
    receiver.reply(finish_status, b"{}", **{"Content-Type": "application/json"})
    client = WorldClient(
        api_key="synthetic-world-key", base_url=receiver.url, project_id=project_id
    )
    parent = os.environ.get("WORLD_DATABASE_URL")

    def run():
        with client.with_postgres(idempotency_key=str(uuid4()), world_version_id=version_id) as (
            dsn,
            instance,
        ):
            assert dsn == url and instance["id"] == instance_id
            assert "url" not in instance["nativeApps"][0]
            assert os.environ.get("WORLD_DATABASE_URL") == parent
            if fail:
                raise ValueError("synthetic client failure")

    if fail:
        with pytest.raises(ValueError, match="synthetic client failure") as caught:
            run()
        if finish_status != 200:
            assert isinstance(caught.value.__cause__, HueEnvironmentError)
    elif finish_status != 200:
        with pytest.raises(HueEnvironmentError):
            run()
    else:
        run()
    for _, headers, _ in receiver.requests:
        assert headers["Authorization"] == "Bearer synthetic-world-key"
        assert headers["X-Hue-Project"] == project_id
    assert receiver.requests[0][1]["X-Hue-Native-Connections"] == "1"
    assert json.loads(receiver.requests[1][2]) == {"appKey": "selected-pg"}
    assert json.loads(receiver.requests[-1][2])["status"] == ("abandoned" if fail else "completed")


def test_postgres_handoff_cancellation_abandons_the_instance(receiver):
    event = Event()
    for body in (
        {
            "id": str(uuid4()),
            "nativeApps": [{"appKey": "postgres", "providerId": "postgres", "state": "ready"}],
        },
        {"state": "ready", "url": "postgresql://user:synthetic@localhost/db?sslmode=verify-full"},
        {},
    ):
        receiver.reply(200, json.dumps(body).encode(), **{"Content-Type": "application/json"})
    world = WorldClient(api_key="synthetic-world-key", base_url=receiver.url)
    with (
        pytest.raises(HueEnvironmentError),
        world.with_postgres(
            idempotency_key=str(uuid4()), world_version_id=str(uuid4()), cancel_event=event
        ),
    ):
        event.set()
    assert json.loads(receiver.requests[-1][2])["status"] == "abandoned"


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


def _libpq_sslmode(connection_url: str) -> str | None:
    """Last assignment wins, matching libpq ``conninfo_storeval``."""
    if "?" not in connection_url:
        return None
    sslmode = None
    for pair in connection_url.split("?", 1)[1].split("&"):
        if "=" not in pair:
            continue
        keyword, value = pair.split("=", 1)
        keyword, value = _libpq_decode(keyword), _libpq_decode(value)
        if keyword == "ssl" and value == "true":
            sslmode = "require"
        elif keyword == "requiressl":
            sslmode = "require" if value.startswith("1") else "prefer"
        elif keyword == "sslmode":
            sslmode = value
    return sslmode


def _libpq_decode(text: str) -> str:
    out = []
    index = 0
    while index < len(text):
        if text[index] != "%":
            out.append(text[index])
            index += 1
            continue
        code = int(text[index + 1 : index + 3], 16)
        if code == 0:
            raise ValueError("forbidden percent-encoding")
        out.append(chr(code))
        index += 3
    return "".join(out)


@pytest.mark.parametrize(
    "offered",
    [
        "postgresql://user:synthetic@127.0.0.1/db?sslmode=verify-full&sslmode=disable",
        "postgres://user:synthetic@10.0.0.8/db?sslmode=verify-full&sslmode=disable",
        "postgresql://user:synthetic@127.0.0.1/db?sslmode=verify-full&sslmode=disa%62le",
        "postgresql://user:synthetic@127.0.0.1/db?sslmode=verify-full&ssl=true",
        "postgresql://user:synthetic@127.0.0.1/db?sslmode=verify-full&requiressl=0",
    ],
)
@pytest.mark.parametrize("client_type", [WorldClient, EnvironmentClient])
def test_postgres_handoff_keeps_verify_full(receiver, offered, client_type):
    instance_id = str(uuid4())
    for body in (
        {
            "id": instance_id,
            "nativeApps": [{"appKey": "postgres", "providerId": "postgres", "state": "ready"}],
        },
        {"state": "ready", "url": offered},
        {},
    ):
        receiver.reply(200, json.dumps(body).encode(), **{"Content-Type": "application/json"})
    client = client_type(api_key="synthetic-world-key", base_url=receiver.url)
    handed = None
    try:
        with client.with_postgres(idempotency_key=str(uuid4()), world_version_id=str(uuid4())) as (
            dsn,
            _instance,
        ):
            handed = dsn
    except HueEnvironmentError:
        assert handed is None
        return
    assert handed is not None and handed != offered
    assert _libpq_sslmode(handed) == "verify-full"


def test_model_cursors_are_opaque_and_cannot_add_query_parameters(receiver):
    from urllib.parse import parse_qs, urlsplit

    from hue_sdk.world import WorldModelClient

    receiver.reply(200, b'{"items": []}')
    cursor = "c1.opaque+cursor&limit=999"
    client = WorldModelClient(api_key="synthetic-world-key", base_url=receiver.url)
    assert client.list_models(after=cursor, limit=20)["items"] == []
    assert parse_qs(urlsplit(receiver.requests[0][0]).query) == {"after": [cursor], "limit": ["20"]}
