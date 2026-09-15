"""Installed Python SDK against an approved Hue API with deterministic local source calls."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from uuid import uuid4

import requests

from hue_sdk.scenes import Binding, Scenes, SnapshotMissError, SourceFile

scenes = Scenes(
    os.environ["HUE_BASE_URL"], os.environ["HUE_API_KEY"], capture_content=True, request_timeout=30
)
calls = {"live": 0, "model": 0, "transform": 0, "generation": 0}
enabled = True


@scenes.tool("documents", "search")
def search(q):
    if not enabled:
        raise RuntimeError("Upstream has been disabled")
    calls["live"] += 1
    return {"answer": q, "occurrence": calls["live"]}


def agent(q):
    calls["model"] += 1
    data = search(q)
    calls["transform"] += 1
    calls["generation"] += 1
    return {
        "generatedOutput": f"{data['answer']}: generation {calls['generation']}",
        "occurrence": data["occurrence"],
    }


binding = Binding(
    "documents",
    operations=(
        {
            "name": "search",
            "inputSchema": {
                "type": "object",
                "properties": {"q": {"type": "string"}},
                "required": ["q"],
                "additionalProperties": False,
            },
        },
    ),
)
document = b"%" * (25 * 1024 * 1024)
with scenes.capture(
    bindings=[binding], external_trace_id=uuid4().hex, input="Synthetic snapshot acceptance"
) as capture:
    assert capture.add_source(SourceFile("source.pdf", document, "application/pdf"))
    assert agent("renewal")["occurrence"] == 1
    assert agent("renewal")["occurrence"] == 2
finalized = capture.finalize()
assert finalized.ok and finalized.pending == 0 and finalized.dropped == 0, finalized
snapshot = finalized.snapshot
enabled = False
recording = scenes.load(snapshot)
with recording.replay(binding_ids=["documents"], external_trace_id=uuid4().hex) as replay:
    assert agent("renewal")["occurrence"] == 1
    assert agent("renewal")["occurrence"] == 2
    for query, reason in (("renewal", "exhausted"), ("changed query", "unrecorded")):
        try:
            agent(query)
        except SnapshotMissError as error:
            assert error.reason == reason
        else:
            raise AssertionError("Expected an explicit snapshot miss")
assert replay.delivery_ok and replay.miss_count == 2
assert calls == {"live": 2, "model": 6, "transform": 4, "generation": 4}
manifest = recording.manifest
assert len(manifest["observations"]) == 4 and len(manifest["sources"]) == 1
assert "generatedOutput" not in json.dumps(manifest)
source = manifest["sources"][0]
assert source["byteSize"] == len(document)
assert source["sha256"] == hashlib.sha256(document).hexdigest()
assert recording.download_source(source["id"]) == document
response = requests.get(
    os.environ["HUE_BASE_URL"] + "/api/v1/scene-replays",
    params={"sceneId": snapshot.scene_id},
    headers={"Authorization": "Bearer " + os.environ["HUE_API_KEY"]},
    timeout=30,
    allow_redirects=False,
)
response.raise_for_status()
assert response.json()["items"][0]["missCount"] == 2
Path(os.environ["HUE_ACCEPTANCE_RESULT"]).write_text(
    json.dumps(
        {
            "snapshot": snapshot.wire(),
            "calls": calls,
            "sourceBytes": len(document),
            "missCount": 2,
        }
    )
)
print(
    "Installed Python SDK: capture, 25 MiB source, immutable playback and two caught misses."
)
