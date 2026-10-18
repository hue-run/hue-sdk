import json
from uuid import uuid4

import pytest

from hue_sdk.world import HueWorldError, WorldModelClient

PROGRESS = {
    "state": "processing_limit",
    "selectedEvidenceCutoff": 1,
    "retainedEvidenceCutoff": 2,
    "readyEvidenceCutoff": 1,
    "pendingEvidence": True,
}


def test_terminal_world_failure_keeps_only_bounded_progress_and_never_retries(receiver):
    receiver.reply(
        503,
        json.dumps(
            {"error": "private body", "preparation": {**PROGRESS, "private": "private body"}}
        ).encode(),
        **{"X-Hue-Diagnostic": "world_processing_limit"},
    )
    with pytest.raises(HueWorldError) as caught:
        WorldModelClient(receiver.url, "synthetic-readiness-key", max_attempts=4).start_instance(
            str(uuid4()), at="2026-10-17T00:00:00Z", idempotency_key="same"
        )
    assert caught.value.preparation == PROGRESS
    assert "private body" not in str(caught.value)
    assert len(receiver.requests) == 1


@pytest.mark.parametrize(
    "body",
    [
        {"preparation": {**PROGRESS, "readyEvidenceCutoff": -1}},
        {"preparation": {**PROGRESS, "state": "ready"}},
        {"preparation": PROGRESS, "error": "private" * 4000},
    ],
)
def test_oversized_or_invalid_error_metadata_is_discarded(receiver, body):
    receiver.reply(503, json.dumps(body).encode(), **{"X-Hue-Diagnostic": "world_processing_limit"})
    with pytest.raises(HueWorldError) as caught:
        WorldModelClient(receiver.url, "synthetic-readiness-key").start_instance(
            str(uuid4()), at="2026-10-17T00:00:00Z", idempotency_key="same"
        )
    assert caught.value.preparation is None
