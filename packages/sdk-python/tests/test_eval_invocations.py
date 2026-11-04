from __future__ import annotations

import json
from uuid import uuid4

import pytest

from hue_sdk.evals import EvaluationClient, HueApiError


@pytest.fixture
def invocation():
    run_id, scoring_id, case_id, evaluator_id = (str(uuid4()) for _ in range(4))
    return {
        "id": str(uuid4()),
        "runId": run_id,
        "runUrl": "https://example.com/run",
        "deadlineAt": "2026-12-01T00:00:00Z",
        "state": "active",
        "receipt": None,
        "manifest": {
            "version": 1,
            "digest": "a" * 64,
            "evalSetId": str(uuid4()),
            "evalSetVersionId": str(uuid4()),
            "scoringRunId": scoring_id,
            "config": {},
            "policy": {"thresholds": []},
            "baselineRunId": None,
            "cases": [
                {
                    "caseId": case_id,
                    "contentDigest": "b" * 64,
                    "inputIdentity": "d" * 64,
                    "judgePinning": {
                        evaluator_id: "this_case",
                        str(uuid4()): "other_cases",
                        str(uuid4()): "no_case",
                    },
                    "evaluatorVersionIds": [evaluator_id],
                    "world": None,
                }
            ],
            "evaluators": [
                {
                    "id": evaluator_id,
                    "evaluatorId": str(uuid4()),
                    "version": 1,
                    "kind": "llm_judge",
                    "contentDigest": "c" * 64,
                }
            ],
        },
    }


def reply(receiver, invocation):
    receiver.reply(
        200, json.dumps({"invocation": invocation}).encode(), **{"Content-Type": "application/json"}
    )


def test_invocation_wire_retry_and_results_only_recovery(receiver, invocation):
    client = EvaluationClient(receiver.url, "synthetic-key")
    receiver.reply(503)
    reply(receiver, invocation)
    actual = client.create_eval_invocation(
        idempotency_key="ci:stable",
        deadline_at=invocation["deadlineAt"],
        eval_set_id=invocation["manifest"]["evalSetId"],
        ci={"provider": "local"},
    )
    assert actual == invocation
    first, second = receiver.requests
    assert first[0] == second[0] == "/api/v1/eval-invocations"
    assert first[2] == second[2]
    body = json.loads(first[2])
    assert body["idempotencyKey"] == "ci:stable"
    assert body["deadlineAt"] == invocation["deadlineAt"]
    reply(receiver, invocation)
    assert client.get_eval_invocation_by_key("ci:stable /?") == invocation
    assert receiver.requests[-1][0].endswith("?idempotencyKey=ci%3Astable%20%2F%3F")
    reply(receiver, invocation)
    assert client.get_eval_invocation(invocation["runId"])["receipt"] is None
    assert receiver.requests[-1][0] == f"/api/v1/eval-invocations/{invocation['runId']}"
    reply(receiver, invocation)
    ci = {"provider": "local", "commitSha": "base-revision"}
    assert (
        client.create_eval_baseline(invocation["id"], idempotency_key="base", ci=ci) == invocation
    )
    assert receiver.requests[-1][0] == f"/api/v1/eval-invocations/{invocation['id']}/baseline"
    assert json.loads(receiver.requests[-1][2]) == {"idempotencyKey": "base", "ci": ci}


@pytest.mark.parametrize("verdict", ["pass", "fail", "incomplete", "error", "cancelled"])
def test_invocation_receipt_preserves_server_verdict(receiver, invocation, verdict):
    invocation["state"] = "finalized"
    invocation["receipt"] = {
        "id": str(uuid4()),
        "manifestDigest": invocation["manifest"]["digest"],
        "runId": invocation["runId"],
        "scoringRunId": invocation["manifest"]["scoringRunId"],
        "verdict": verdict,
        "finalizedAt": "2026-11-04T00:00:00Z",
        "executionIds": [],
        "results": [],
        "reasons": [],
    }
    reply(receiver, invocation)
    client = EvaluationClient(receiver.url, "synthetic-key")
    actual = client.finalize_eval_invocation(invocation["id"], idempotency_key="finalize")
    assert actual["receipt"] == invocation["receipt"]
    assert json.loads(receiver.requests[-1][2]) == {"idempotencyKey": "finalize"}
    reply(receiver, invocation)
    assert (
        client.cancel_eval_invocation(invocation["id"], idempotency_key="cancel", reason="deadline")
        == invocation
    )
    assert json.loads(receiver.requests[-1][2])["reason"] == "deadline"


def test_invocation_boundary_rejects_bad_selection_and_untrusted_verdict(receiver, invocation):
    client = EvaluationClient(receiver.url, "synthetic-key")
    with pytest.raises(ValueError, match="selector"):
        client.create_eval_invocation(idempotency_key="x", deadline_at=invocation["deadlineAt"])
    with pytest.raises(ValueError, match="cancellation"):
        client.cancel_eval_invocation(invocation["id"], idempotency_key="x", reason="other")
    assert receiver.requests == []
    invocation["state"] = "success"
    reply(receiver, invocation)
    with pytest.raises(HueApiError):
        client.get_eval_invocation(invocation["id"])


def test_invocation_receipt_cannot_refer_to_another_manifest(receiver, invocation):
    invocation["receipt"] = {
        "id": str(uuid4()),
        "manifestDigest": "different",
        "runId": invocation["runId"],
        "scoringRunId": invocation["manifest"]["scoringRunId"],
        "verdict": "pass",
        "finalizedAt": "2026-11-04T00:00:00Z",
        "executionIds": [],
        "results": [],
        "reasons": [],
    }
    reply(receiver, invocation)
    with pytest.raises(HueApiError):
        EvaluationClient(receiver.url, "synthetic-key").get_eval_invocation(invocation["id"])
