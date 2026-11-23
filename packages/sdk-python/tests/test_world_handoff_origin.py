"""A create-instance response must not hand an agent a mirror off the Hue origin it called."""

import json
from pathlib import Path
from uuid import uuid4

from hue_sdk.world import WorldClient, agent_environment, mcp_config_file, world_handoff

PROJECT_KEY = "placeholder-project-key"
WORLD_TOKEN = "placeholder-world-token"
VERSION = "0b7e3f5c-9d2a-4e1b-a6c8-7f9e0d1c2b3a"


def _markers(origin: str) -> list[str]:
    port = origin.rsplit(":", 1)[-1]
    return [
        "http://127.0.0.1:1/",
        f"http://localhost:{port}/",
        "169.254.169.254",
        "10.0.0.8",
        "192.168.0.9",
        "attacker.example",
        "file:///",
        "javascript:",
        "placeholder:placeholder@",
        "[::1]",
        "[::ffff:7f00:1]",
        "2130706433",
        "0.0.0.0",
        "127.0.0.1.attacker.example",
    ]


def _body(origin: str, urls: list[str]) -> dict[str, object]:
    world_id = str(uuid4())
    env = {
        "HUE_WORLD_ID": world_id,
        "HUE_WORLD_TOKEN": WORLD_TOKEN,
        "HUE_WORLD_NOW": "2026-03-02T09:00:00.000Z",
        "BAGGAGE": f"hue-world={world_id}",
        "HTTP_PROXY": "http://127.0.0.1:1",
    }
    servers: dict[str, object] = {}
    for index, url in enumerate(urls):
        env[f"HUE_SIM_MIRROR_{index}_URL"] = url
        servers[f"mirror-{index}"] = {
            "type": "http",
            "url": url,
            "headers": {"Authorization": f"Bearer {WORLD_TOKEN}"},
        }
    return {
        "id": world_id,
        "worldId": world_id,
        "environmentVersionId": VERSION,
        "clockNs": "0",
        "stateDigest": "d" * 64,
        "maxSteps": 50,
        "expiresAt": "2026-12-01T00:00:00.000Z",
        "actions": [],
        "token": WORLD_TOKEN,
        "lifecycle": "live",
        "completingUntil": None,
        "baggage": f"hue-world={world_id}",
        "traceparent": None,
        "now": "2026-03-02T09:00:00.000Z",
        "surfaces": [{"url": url} for url in urls],
        "env": env,
        "mcpConfig": {"mcpServers": servers},
        "connection": None,
    }


def _delivered(receiver, urls: list[str], tmp_path: Path) -> list[str] | None:
    receiver.reply(
        201,
        json.dumps(_body(receiver.url, urls)).encode(),
        **{"Content-Type": "application/json"},
    )
    client = WorldClient(api_key=PROJECT_KEY, base_url=receiver.url)
    try:
        run = client.create_instance(idempotency_key="handoff-origin", world_version_id=VERSION)
        handoff = world_handoff(run)
    except Exception:
        if not receiver.requests:
            raise
        return None
    if handoff is None:
        return None
    texts = [
        json.dumps(handoff),
        json.dumps(agent_environment(handoff, parent={"PATH": "/usr/bin"})),
    ]
    try:
        with mcp_config_file(handoff, directory=str(tmp_path)) as path:
            texts.append(Path(path).read_text(encoding="utf-8"))
    except Exception:
        texts.extend(path.read_text(encoding="utf-8") for path in tmp_path.rglob("mcp.json"))
    return texts


def test_same_origin_mirror_is_handed_to_the_agent(receiver, tmp_path):
    mirror = f"{receiver.url}/api/sim/gmail/mcp"
    texts = _delivered(receiver, [mirror], tmp_path)
    assert texts is not None
    assert mirror in texts[0]
    assert mirror in texts[1]


def test_off_origin_mirrors_are_not_handed_to_the_agent(receiver, tmp_path):
    origin = receiver.url
    port = origin.rsplit(":", 1)[-1]
    urls = [
        f"{origin}/api/sim/gmail/mcp",
        "http://127.0.0.1:1/mcp",
        f"http://localhost:{port}/mcp",
        "http://169.254.169.254/latest",
        "http://10.0.0.8/mcp",
        "http://192.168.0.9/mcp",
        "https://attacker.example/mcp",
        "http://127.0.0.1.attacker.example/mcp",
        "https://placeholder:placeholder@hue.example.test/mcp",
        "file:///tmp/hue-mcp.json",
        "javascript:alert(1)",
        "http://[::1]/mcp",
        "http://[::ffff:7f00:1]/mcp",
        "http://2130706433/mcp",
        "http://0.0.0.0/mcp",
    ]
    texts = _delivered(receiver, urls, tmp_path)
    if texts is None:
        assert not any(tmp_path.rglob("mcp.json"))
        return
    for text in (item.replace(WORLD_TOKEN, "[token]") for item in texts):
        for marker in _markers(origin):
            assert marker not in text
