from __future__ import annotations

import asyncio
import functools
import inspect
import json
import os
import subprocess
import sys
import time
import tracemalloc
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Event, Lock, Thread, current_thread
from types import SimpleNamespace
from urllib.parse import urlsplit
from uuid import uuid4

import pytest

import hue_sdk.evals.runner as runner_module
from hue_sdk import Hue
from hue_sdk.evals import (
    MISSING,
    EvaluationClient,
    HueApiError,
    OutcomeSerializationError,
    TelemetryExportError,
    TraceEvidence,
    UncertainExecutionError,
    builtins,
    define_local_scorer,
    rescore,
    run_experiment,
    score_locally,
)
from hue_sdk.evals._checkpoint import CheckpointStore
from hue_sdk.evals._json import JsonLimitError, _utf16_order, encode, json_value


@pytest.fixture
def evaluation_receiver():
    state = SimpleNamespace(
        project_id=str(uuid4()),
        experiment_id=str(uuid4()),
        version_id=str(uuid4()),
        dataset_id=str(uuid4()),
        case_id=str(uuid4()),
        run_id=str(uuid4()),
        scorer_id=str(uuid4()),
        evaluator_id=str(uuid4()),
        evaluator_version_id=str(uuid4()),
        result_id=str(uuid4()),
        execution=None,
        completion=None,
        subject=None,
        scores={},
        requests=[],
        starts=0,
        fail_start=0,
        fail_complete=0,
        fail_result=0,
        fail_otlp=False,
        include_expected=True,
        output=None,
        inputs="sensitive-input",
        config={"answer": None},
        deferred=[],
        historical=None,
        # Further cases after ``case_id``, each with its own execution: id -> state.
        extra_cases={},
        lock=Lock(),
    )
    state.versions = [
        {
            "id": state.scorer_id,
            "scorerId": state.evaluator_id,
            "contentDigest": "b" * 64,
            "definition": builtins.exact_match(),
        }
    ]

    def extra_case(path, body):
        for case_id, case in state.extra_cases.items():
            if path.endswith(f"/items/{case_id}"):
                return 200, {
                    "id": case_id,
                    "externalKey": f"case-{case_id}",
                    "datasetVersionId": state.version_id,
                    "inputs": state.inputs,
                    "metadata": {},
                    "hasExpected": state.include_expected,
                    **({"expected": None} if state.include_expected else {}),
                }
            if path.endswith(f"/items/{case_id}/start"):
                case.setdefault(
                    "execution",
                    {"id": str(uuid4()), "state": "started", "attempt": 1, **body},
                )
                return 200, case["execution"]
            execution = case.get("execution")
            if execution and f"/experiment-executions/{execution['id']}" in path:
                if not path.endswith("/complete"):
                    return 200, execution
                case.setdefault("complete_body", body)
                execution["state"] = case["complete_body"]["state"]
                case.setdefault(
                    "completion",
                    {
                        "executionId": execution["id"],
                        "subjectId": str(uuid4()),
                        "evaluationItemId": str(uuid4()),
                        "traceSnapshotId": str(uuid4()),
                    },
                )
                return 200, case["completion"]
        return None

    def dispatch(method, path, body):
        handled = extra_case(path, body)
        if handled is not None:
            return handled
        registry_version = {
            "id": state.version_id,
            "datasetId": state.dataset_id,
            "version": 1,
            "revision": 1,
            "frozenAt": None,
            "contentDigest": None,
        }
        registry_set = {
            "id": state.dataset_id,
            "name": "Synthetic set",
            "slug": "synthetic-set",
            "versions": [registry_version],
        }
        registry_case = {
            "id": state.case_id,
            "datasetVersionId": state.version_id,
            "externalKey": "one",
            "inputs": {"datasetId": "customer-input"},
            "metadata": {"scorerId": "customer-metadata"},
        }
        evaluator_version = {
            "id": state.evaluator_version_id,
            "scorerId": state.evaluator_id,
            "contentDigest": "b" * 64,
            "definition": {"kind": "builtin", "scorerId": "customer-definition"},
        }
        evaluator = {
            "id": state.evaluator_id,
            "name": "Synthetic evaluator",
            "slug": "synthetic-evaluator",
            "versions": [evaluator_version],
        }
        if "/otlp/" in path:
            return (400, {}) if state.fail_otlp else (200, b"")
        if path.endswith("/datasets"):
            return 200, {
                "items": [registry_set],
                "nextCursor": None,
            } if method == "GET" else registry_set
        if path.endswith(f"/datasets/{state.dataset_id}"):
            return 200, registry_set
        if path.endswith(f"/datasets/{state.dataset_id}/versions"):
            return 200, registry_version
        if path.endswith(f"/dataset-versions/{state.version_id}/cases"):
            return (
                (200, {"items": [registry_case], "nextCursor": None})
                if method == "GET"
                else (200, {"item": registry_case, "version": registry_version})
            )
        if path.endswith(f"/dataset-versions/{state.version_id}/freeze"):
            return 200, {**registry_version, "frozenAt": "2026-09-15T00:00:00Z"}
        if path.endswith("/scorers"):
            return 200, {"items": [evaluator], "nextCursor": None} if method == "GET" else evaluator
        if path.endswith(f"/scorers/{state.evaluator_id}"):
            return 200, evaluator
        if path.endswith(f"/scorers/{state.evaluator_id}/versions"):
            return 200, evaluator_version
        if path.endswith(f"/scorer-versions/{state.evaluator_version_id}"):
            return 200, evaluator_version
        if path.endswith("/projects/current"):
            return 200, {
                "id": state.project_id,
                "organizationId": str(uuid4()),
                "name": "Synthetic",
                "slug": "synthetic",
            }
        if path.endswith("/experiments") and method == "POST":
            return 200, {"id": state.experiment_id, "evaluationRunId": state.run_id}
        if path.endswith(f"/experiments/{state.experiment_id}"):
            return 200, {
                "id": state.experiment_id,
                "datasetVersionId": state.version_id,
                "caseCount": 1 + len(state.extra_cases),
                "config": state.config,
                "configDigest": "c" * 64,
                "evaluation": {"id": state.run_id, "scorerVersions": state.versions},
            }
        if path.endswith(f"/dataset-versions/{state.version_id}"):
            return 200, {
                "id": state.version_id,
                "datasetId": state.dataset_id,
                "frozenAt": "2026-09-15T00:00:00Z",
                "contentDigest": "a" * 64,
            }
        if path.endswith(f"/experiments/{state.experiment_id}/items"):
            return 200, {
                "items": [
                    {"id": state.case_id, "execution": state.execution},
                    *(
                        {"id": case_id, "execution": case.get("execution")}
                        for case_id, case in state.extra_cases.items()
                    ),
                ],
                "nextCursor": None,
            }
        if path.endswith(f"/items/{state.case_id}"):
            return 200, {
                "id": state.case_id,
                "externalKey": "case",
                "datasetVersionId": state.version_id,
                "inputs": state.inputs,
                "metadata": {},
                "hasExpected": state.include_expected,
                **({"expected": None} if state.include_expected else {}),
            }
        if path.endswith("/start"):
            if state.execution is None:
                state.starts += 1
                state.execution = {
                    "id": str(uuid4()),
                    "state": "started",
                    "attempt": 1,
                    "traceExternalId": body.get("traceExternalId"),
                }
                state.start_body = body
            elif state.start_body != body:
                return 409, {}
            if state.fail_start:
                state.fail_start -= 1
                return 503, {}
            return 200, state.execution
        if path.endswith("/complete"):
            if state.completion is None:
                state.complete_body = body
                state.completion = {
                    "executionId": state.execution["id"],
                    "subjectId": str(uuid4()),
                    "evaluationItemId": str(uuid4()),
                    "traceSnapshotId": str(uuid4()),
                }
                state.execution["state"] = body["state"]
                state.subject = {
                    "id": state.completion["subjectId"],
                    "experimentId": state.experiment_id,
                    "datasetVersionId": state.version_id,
                    "inputs": "sensitive-input",
                    "hasOutput": "output" in body,
                    **({"output": body["output"]} if "output" in body else {}),
                    "hasExpected": state.include_expected,
                    "metadata": {},
                    "executionState": body["state"],
                    **({"expected": None} if state.include_expected else {}),
                }
            elif body != state.complete_body:
                return 409, {}
            if state.fail_complete:
                state.fail_complete -= 1
                return 503, {}
            return 200, state.completion
        if "/experiment-executions/" in path:
            return 200, state.execution
        if path.endswith("/results") and method == "GET":
            return 200, {
                "items": [
                    {
                        "id": state.result_id,
                        "itemId": state.case_id,
                        "scorerVersionId": state.scorer_id,
                    }
                ],
                "nextCursor": None,
            }
        if path.endswith("/results"):
            key = body["idempotencyKey"]
            if key not in state.scores:
                state.scores[key] = {"body": body, "ids": [str(uuid4())]}
            elif state.scores[key]["body"] != body:
                return 409, {}
            if state.fail_result:
                state.fail_result -= 1
                return 503, {}
            return 200, {"ids": state.scores[key]["ids"]}
        if path.endswith("/finish"):
            return 200, {"id": state.experiment_id, "finishedAt": "2026-09-15T00:00:00Z"}
        if path.endswith("/evaluation-runs") and method == "POST":
            state.historical = {"id": str(uuid4()), "itemId": str(uuid4())}
            return 200, {"id": state.historical["id"]}
        if path.endswith("/evaluation-runs") and method == "GET":
            return 200, {
                "items": [
                    {
                        "id": state.historical["id"] if state.historical else state.run_id,
                        "experimentId": state.experiment_id,
                    }
                ],
                "nextCursor": None,
            }
        if path.endswith(f"/evaluation-results/{state.result_id}"):
            return 200, {
                "id": state.result_id,
                "itemId": state.case_id,
                "runId": state.historical["id"] if state.historical else state.run_id,
                "scorerVersionId": state.scorer_id,
                "state": "scored",
                "metrics": [],
                "evidence": {"runId": "customer-evidence"},
            }
        if "/evaluation-subjects/" in path:
            return 200, state.subject
        if state.historical and f"/evaluation-runs/{state.historical['id']}" in path:
            if path.endswith("/items"):
                return 200, {
                    "items": [{"id": state.historical["itemId"], "subjectId": state.subject["id"]}],
                    "nextCursor": None,
                }
            return 200, {
                "id": state.historical["id"],
                "itemCount": 1,
                "scorerVersions": state.versions,
            }
        return 404, {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.respond("GET")

        def do_POST(self):
            self.respond("POST")

        def respond(self, method):
            path = urlsplit(self.path).path
            raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            body = json.loads(raw) if raw and "/otlp/" not in path else None
            with state.lock:
                state.requests.append((method, path, raw))
                status, value = dispatch(method, path, body)
                payload = value if isinstance(value, bytes) else json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header(
                "Content-Type",
                "application/x-protobuf" if isinstance(value, bytes) else "application/json",
            )
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    state.url = f"http://127.0.0.1:{server.server_port}"
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield state
    finally:
        server.shutdown()
        server.server_close()
        thread.join(5)


def options(receiver, tmp_path, target, *, persist=True, evidence=None):
    return dict(
        client=EvaluationClient(receiver.url, "synthetic-key"),
        hue=Hue(receiver.url, "synthetic-key", capture_content=False),
        experiment_id=receiver.experiment_id,
        target=target,
        checkpoint_directory=tmp_path / "checkpoints",
        persist_result_content=persist,
        trace_evidence=evidence or TraceEvidence("required"),
    )


def test_requests_refused_with_a_short_retry_after_are_sent_again_and_others_are_not():
    seen: list[tuple[str, str, bytes]] = []
    replies: list[tuple[int, str | None]] = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.answer()

        def do_POST(self):
            self.answer()

        def answer(self):
            length = int(self.headers.get("Content-Length") or 0)
            seen.append((self.command, urlsplit(self.path).path, self.rfile.read(length)))
            status, retry_after = replies.pop(0) if replies else (200, None)
            payload = json.dumps({"id": "synthetic"} if status == 200 else {"error": "x"})
            self.send_response(status)
            if retry_after is not None:
                self.send_header("Retry-After", retry_after)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(payload.encode())

        def log_message(self, *_args):
            pass

    def exchange(planned, call):
        replies[:] = planned
        seen.clear()
        try:
            return call(), None, list(seen), len(replies)
        except HueApiError as error:
            return None, error, list(seen), len(replies)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        client = EvaluationClient(f"http://127.0.0.1:{server.server_port}", "synthetic-key")
        value, error, calls, _ = exchange([(503, "0"), (429, "0")], client.check_connection)
        assert value == {"id": "synthetic"} and error is None
        assert calls == [("GET", "/api/v1/projects/current", b"")] * 3

        # A mutation Hue refused before acting on it is sent again with the same body.
        def create():
            return client.create_dataset(name="Greetings", slug="greetings")

        value, error, calls, _ = exchange([(503, "0")], create)
        assert value == {"id": "synthetic"} and error is None
        assert len(calls) == 2 and calls[0] == calls[1]
        assert calls[0][:2] == ("POST", "/api/v1/datasets")
        body = {"name": "Greetings", "slug": "greetings", "description": ""}
        assert json.loads(calls[0][2]) == body

        # Four more attempts at most, then the refusal is the caller's error.
        value, error, calls, unused = exchange([(503, "0")] * 6, client.check_connection)
        assert isinstance(error, HueApiError) and error.status == 503
        assert len(calls) == 5 and unused == 1

        for status, retry_after in (
            (503, "60"),
            (503, None),
            (503, "1.5"),
            (503, "\u00b2"),
            (429, "Wed, 21 Oct 2026 07:28:00 GMT"),
            (500, "0"),
            (502, "0"),
        ):
            value, error, calls, _ = exchange([(status, retry_after)], create)
            assert isinstance(error, HueApiError) and error.status == status
            assert len(calls) == 1

        started = time.monotonic()
        value, error, calls, _ = exchange([(429, "1")], client.check_connection)
        assert value == {"id": "synthetic"} and len(calls) == 2
        assert time.monotonic() - started >= 1
    finally:
        server.shutdown()
        server.server_close()
        thread.join(5)


def test_a_write_whose_connection_drops_or_times_out_is_sent_once_and_fails():
    # Hue may have acted on a request that got no answer, so neither failure may send it again.
    seen: list[tuple[str, str, bytes]] = []
    answer = {"mode": "drop"}
    release = Event()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("Content-Length") or 0)
            seen.append((self.command, urlsplit(self.path).path, self.rfile.read(length)))
            if answer["mode"] == "hang":
                release.wait(5)
            # Returning without a status line closes the HTTP/1.0 connection unanswered.
            self.close_connection = True

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        client = EvaluationClient(
            f"http://127.0.0.1:{server.server_port}", "synthetic-key", timeout_seconds=0.2
        )
        body = {"name": "Greetings", "slug": "greetings", "description": ""}
        for mode in ("drop", "hang"):
            answer["mode"] = mode
            seen.clear()
            with pytest.raises(HueApiError) as caught:
                client.create_dataset(name="Greetings", slug="greetings")
            assert caught.value.status is None
            assert len(seen) == 1 and seen[0][:2] == ("POST", "/api/v1/datasets")
            assert json.loads(seen[0][2]) == body
    finally:
        release.set()
        server.shutdown()
        server.server_close()
        thread.join(5)


def test_product_registry_methods_use_v1_paths_and_preserve_customer_fields(evaluation_receiver):
    receiver = evaluation_receiver
    client = EvaluationClient(receiver.url, "synthetic-key")
    created = client.create_eval_set(name="Synthetic set", slug="synthetic-set")
    assert created["versions"][0]["evalSetId"] == receiver.dataset_id
    assert (
        client.get_eval_set(receiver.dataset_id)["versions"][0]["evalSetId"] == receiver.dataset_id
    )
    assert client.list_eval_sets()["items"][0]["id"] == receiver.dataset_id
    assert client.create_eval_set_version(receiver.dataset_id)["evalSetId"] == receiver.dataset_id
    assert client.get_eval_set_version(receiver.version_id)["evalSetId"] == receiver.dataset_id
    listed = client.list_eval_set_cases(receiver.version_id)["items"][0]
    assert listed["evalSetVersionId"] == receiver.version_id
    assert listed["inputs"] == {"datasetId": "customer-input"}
    added = client.add_eval_set_case(
        receiver.version_id,
        expected_revision=1,
        external_key="one",
        inputs={"datasetId": "customer-input"},
    )
    assert added["item"]["evalSetVersionId"] == receiver.version_id
    assert added["version"]["evalSetId"] == receiver.dataset_id
    assert client.freeze_eval_set_version(receiver.version_id, 1)["frozenAt"]
    assert (
        client.create_evaluator(name="Synthetic evaluator", slug="synthetic-evaluator")["id"]
        == receiver.evaluator_id
    )
    assert (
        client.get_evaluator(receiver.evaluator_id)["versions"][0]["evaluatorId"]
        == receiver.evaluator_id
    )
    assert client.list_evaluators()["items"][0]["id"] == receiver.evaluator_id
    published = client.publish_evaluator_version(receiver.evaluator_id, builtins.exact_match())
    assert published["evaluatorId"] == receiver.evaluator_id
    assert published["definition"]["scorerId"] == "customer-definition"
    assert (
        client.get_evaluator_version(receiver.evaluator_version_id)["evaluatorId"]
        == receiver.evaluator_id
    )
    assert all(
        "/eval-sets" not in path and "/evaluators" not in path for _, path, _ in receiver.requests
    )


def test_product_run_and_scoring_methods_keep_distinct_ids(evaluation_receiver):
    receiver = evaluation_receiver
    client = EvaluationClient(receiver.url, "synthetic-key")
    created = client.create_run(
        idempotency_key=str(uuid4()),
        name="Run",
        eval_set_version_id=receiver.version_id,
        evaluator_version_ids=[receiver.scorer_id],
        config={"experimentId": "customer-config"},
    )
    assert created["scoringId"] == receiver.run_id
    body = json.loads(receiver.requests[-1][2])
    assert body["evalSetVersionId"] == receiver.version_id
    assert body["evaluatorVersionIds"] == [receiver.scorer_id]
    assert body["config"] == {"experimentId": "customer-config"}
    run = client.get_run(receiver.experiment_id)
    assert run["evalSetVersionId"] == receiver.version_id
    assert run["scoring"]["evaluatorVersions"][0]["evaluatorId"] == receiver.evaluator_id
    assert run["config"] == {"answer": None}
    assert client.list_run_items(receiver.experiment_id)["items"][0]["id"] == receiver.case_id
    case = client.get_run_case(receiver.experiment_id, receiver.case_id)
    assert case["evalSetVersionId"] == receiver.version_id
    assert case["inputs"] == "sensitive-input"
    execution = client.start_run_execution(
        receiver.experiment_id, receiver.case_id, idempotency_key=str(uuid4())
    )
    assert client.get_run_execution(execution["id"])["id"] == execution["id"]
    completion = client.complete_run_execution(
        execution["id"], {"idempotencyKey": str(uuid4()), "state": "succeeded"}
    )
    assert completion["subjectId"] == receiver.subject["id"]
    assert client.finish_run(receiver.experiment_id, str(uuid4()))["id"] == receiver.experiment_id
    scoring = client.create_scoring(
        idempotency_key=str(uuid4()),
        name="Scoring",
        subject_ids=[receiver.subject["id"]],
        evaluator_version_ids=[receiver.scorer_id],
    )
    assert json.loads(receiver.requests[-1][2])["evaluatorVersionIds"] == [receiver.scorer_id]
    assert (
        client.get_scoring(scoring["id"])["evaluatorVersions"][0]["evaluatorId"]
        == receiver.evaluator_id
    )
    assert client.list_scorings()["items"][0]["runId"] == receiver.experiment_id
    assert (
        client.list_scoring_items(scoring["id"])["items"][0]["subjectId"] == receiver.subject["id"]
    )
    subject = client.get_scoring_subject(receiver.subject["id"])
    assert subject["runId"] == receiver.experiment_id
    assert subject["evalSetVersionId"] == receiver.version_id
    result = {
        "evaluationItemId": receiver.case_id,
        "evaluatorVersionId": receiver.scorer_id,
        "state": "scored",
        "metrics": [],
        "evidence": {"runId": "customer-evidence"},
    }
    assert client.submit_scoring_results(
        scoring["id"], idempotency_key=str(uuid4()), results=[result]
    )["ids"]
    assert json.loads(receiver.requests[-1][2])["results"] == [result]
    assert (
        client.list_scoring_results(scoring["id"])["items"][0]["evaluatorVersionId"]
        == receiver.scorer_id
    )
    stored = client.get_scoring_result(receiver.result_id)
    assert stored["scoringId"] == scoring["id"]
    assert stored["evidence"] == {"runId": "customer-evidence"}
    assert all(
        "/api/v1/runs" not in path and "/api/v1/scorings" not in path
        for _, path, _ in receiver.requests
    )


def test_real_http_retries_saved_completion_and_scores_without_replaying_target(
    evaluation_receiver, tmp_path
):
    receiver, calls = evaluation_receiver, []
    receiver.fail_complete = receiver.fail_result = 1
    arguments = options(receiver, tmp_path, lambda _inputs, _context: calls.append(1))
    try:
        for _ in range(2):
            with pytest.raises(HueApiError) as failure:
                run_experiment(**arguments)
            assert failure.value.status == 503
        report = run_experiment(**arguments)
        assert calls == [1] and receiver.starts == 1
        assert len(report.subject_ids) == len(report.result_ids) == 1
        assert receiver.complete_body["output"] is None
        assert list(receiver.scores.values())[0]["body"]["results"][0]["metrics"] == [
            {"name": "match", "value": True, "passed": True}
        ]
        assert run_experiment(**arguments) == report
        assert calls == [1]
    finally:
        arguments["hue"].shutdown()


def test_content_opt_out_covers_http_and_checkpoints_and_historical_unavailable(
    evaluation_receiver, tmp_path
):
    receiver, called, scored = evaluation_receiver, [], []

    def custom_score(_context):
        scored.append(1)
        return {
            "state": "scored",
            "metrics": [{"name": "quality", "value": False, "passed": False}],
            "explanation": "sensitive-explanation",
            "evidence": "sensitive-evidence",
        }

    local = define_local_scorer(
        source=inspect.getsource(custom_score),
        entrypoint="score",
        metrics=[{"name": "quality", "type": "boolean"}],
        score=custom_score,
    )
    receiver.versions = [
        {"id": str(uuid4()), "contentDigest": "d" * 64, "definition": local.definition}
    ]

    def target(_inputs, _context):
        called.append(1)
        return "sensitive-output"

    arguments = options(receiver, tmp_path, target, persist=False)
    arguments["scorers"] = [local]
    try:
        report = run_experiment(**arguments)
        assert "output" not in receiver.complete_body
        score = list(receiver.scores.values())[0]["body"]["results"][0]
        assert score["metrics"][0]["value"] is False and score["state"] == "scored"
        assert "evidence" not in score and score["sourceDigest"] == local.definition["sourceDigest"]
        persisted = b"".join(
            path.read_bytes() for path in arguments["checkpoint_directory"].glob("*.json")
        )
        sent = b"".join(body for _, _, body in receiver.requests)
        for content in (
            b"sensitive-output",
            b"sensitive-evidence",
            b"sensitive-explanation",
            b"sensitive-input",
        ):
            assert content not in persisted + sent
        historical = arguments["client"].create_evaluation_run(
            idempotency_key=str(uuid4()),
            name="Rescore",
            subject_ids=report.subject_ids,
            scorer_version_ids=[receiver.versions[0]["id"]],
        )
    finally:
        arguments["hue"].shutdown()
    rescored = rescore(
        client=arguments["client"],
        run_id=historical["id"],
        checkpoint_directory=tmp_path / "rescore",
        persist_result_content=False,
        scorers=[local],
    )
    assert len(rescored.result_ids) == 1 and called == [1] and scored == [1]
    result = list(receiver.scores.values())[-1]["body"]["results"][0]
    assert (
        result["state"] == "skipped" and result["explanation"] == "Output evidence is unavailable"
    )


def test_start_ambiguity_and_serialization_failure_never_reinvoke(evaluation_receiver, tmp_path):
    receiver, calls = evaluation_receiver, []
    receiver.fail_start = 1
    arguments = options(receiver, tmp_path, lambda *_: calls.append(1))
    try:
        with pytest.raises(HueApiError):
            run_experiment(**arguments)
        with pytest.raises(UncertainExecutionError) as uncertain:
            run_experiment(**arguments)
        assert uncertain.value.execution_id == receiver.execution["id"] and calls == []
    finally:
        arguments["hue"].shutdown()


@pytest.mark.parametrize("persist", [True, False])
@pytest.mark.parametrize(
    ("output", "message"),
    [
        (
            "x" * 250_000,
            "The output is larger than 200,000 bytes of JSON, the most Hue stores for one case; "
            "return a large result as a generated file",
        ),
        (
            functools.reduce(lambda inner, _: [inner], range(40), "leaf"),
            "The output has more than 20,000 JSON values or nests deeper than 32 levels, the most "
            "Hue stores for one case",
        ),
    ],
    ids=["bytes", "structure"],
)
def test_output_over_the_case_bounds_fails_that_case_and_the_run_goes_on(
    evaluation_receiver, tmp_path, persist, output, message
):
    later = str(uuid4())
    evaluation_receiver.extra_cases[later] = {}
    calls = []

    def target(_inputs, context):
        calls.append(context.item["id"])
        return output if context.item["id"] == evaluation_receiver.case_id else "fits"

    arguments = options(evaluation_receiver, tmp_path, target, persist=persist)
    try:
        report = run_experiment(**arguments)
        body = evaluation_receiver.complete_body
        assert body["state"] == "error" and "output" not in body
        assert body["error"] == (
            {"type": "OutputTooLarge", "message": message}
            if persist
            else {"type": "OutputTooLarge"}
        )
        # The later case still ran and succeeded, and the run finished.
        assert calls == [evaluation_receiver.case_id, later]
        completed = evaluation_receiver.extra_cases[later]["complete_body"]
        assert completed["state"] == "succeeded"
        assert completed.get("output") == ("fits" if persist else None)
        assert any(path.endswith("/finish") for _, path, *_ in evaluation_receiver.requests)
        # The saved outcomes resume without invoking the target again.
        assert run_experiment(**arguments) == report and len(calls) == 2
    finally:
        arguments["hue"].shutdown()


@pytest.mark.parametrize("output_kind", ["object", "cycle"])
def test_non_json_target_output_is_not_target_error_or_replayed(
    evaluation_receiver, tmp_path, output_kind
):
    calls = []

    def target(*_args):
        calls.append(1)
        if output_kind == "object":
            return object()
        cycle = []
        cycle.append(cycle)
        return cycle

    arguments = options(evaluation_receiver, tmp_path, target)
    try:
        for _ in range(2):
            with pytest.raises(OutcomeSerializationError):
                run_experiment(**arguments)
        assert calls == [1] and evaluation_receiver.completion is None
        assert evaluation_receiver.execution["state"] == "started"
    finally:
        arguments["hue"].shutdown()


def test_shared_acyclic_output_completes_and_resumes_without_replaying_target(
    evaluation_receiver, tmp_path
):
    calls = []
    shared = {"message": "same value", "items": [None, False]}
    output = {"first": shared, "second": shared, "list": [shared, shared]}

    def target(*_args):
        calls.append(1)
        return output

    arguments = options(evaluation_receiver, tmp_path, target)
    try:
        report = run_experiment(**arguments)
        assert evaluation_receiver.complete_body["output"] == json.loads(json.dumps(output))
        assert evaluation_receiver.complete_body["state"] == "succeeded"
        assert run_experiment(**arguments) == report
        assert calls == [1] and evaluation_receiver.starts == 1
    finally:
        arguments["hue"].shutdown()


def test_json_counts_each_expansion_of_shared_references_and_rejects_real_cycles():
    shared = [None] * 100
    assert json_value([shared, shared]) == [shared, shared]
    with pytest.raises(ValueError, match="depth or node limits"):
        json_value([shared] * 200)
    left, right = {}, {}
    left["next"] = right
    right["next"] = left
    with pytest.raises(ValueError, match="cycles"):
        json_value(left)


def test_object_keys_are_not_counted_as_values_as_in_the_typescript_sdk():
    # Counting keys too refused an object of 10,001 members that TypeScript accepts.
    json_value({f"k{index}": index for index in range(10_001)})
    # The object and its members are 20,000 values; one member more is over the limit.
    json_value({f"k{index}": index for index in range(19_999)}, max_bytes=1_000_000)
    with pytest.raises(JsonLimitError) as refused:
        json_value({f"k{index}": index for index in range(20_000)}, max_bytes=1_000_000)
    assert refused.value.limit == "structure"


def test_a_container_with_more_elements_than_values_left_is_refused_before_it_is_read():
    elements = [0] * 5_000_000
    started = time.perf_counter()
    with pytest.raises(JsonLimitError) as refused:
        json_value(elements)
    assert refused.value.limit == "structure"
    # Queueing five million children first took about a second and hundreds of megabytes.
    assert time.perf_counter() - started < 0.1


def test_both_sdks_refuse_an_output_for_the_same_reason():
    # The TypeScript suite checks the same outputs. Values are read in order, members by key, and
    # each is checked for its type before it is counted.
    big = "x" * 300_000
    cases = [
        ([big, float("nan")], "bytes"),
        ([float("nan"), big], "not JSON"),
        ({"b": [0] * 25_000, "a": big}, "bytes"),
        ([big, *[0] * 25_000], "structure"),
        ({"key\x00": 1}, "not JSON"),
        ({"\ud800": 1}, "not JSON"),
        # JavaScript sorts 😀 (a surrogate pair) before \uffff; by code point it sorts after.
        ({"\uffff": float("nan"), "😀": big}, "bytes"),
    ]
    for value, reason in cases:
        try:
            json_value(value)
            outcome = "accepted"
        except JsonLimitError as error:
            outcome = error.limit
        except ValueError:
            outcome = "not JSON"
        assert outcome == reason


def test_the_byte_bound_is_the_exact_length_of_the_json_text():
    # A quote or backslash escapes to two bytes, a control character to six; é, € and 😀 take two,
    # three and four bytes.
    sample = {'k"\\': ['"\\\n\u0001é€😀', 1.5, 1e-07, True, False, None, [], {}]}
    exact = len(encode(sample))
    json_value(sample, exact)
    with pytest.raises(JsonLimitError) as refused:
        json_value(sample, exact - 1)
    assert refused.value.limit == "bytes"


def test_an_output_too_large_to_serialize_is_refused_by_its_count_before_it_is_serialized():
    # Checking and serializing each of eleven references to a 50 MB string took tens of seconds
    # and a gigabyte.
    big = "x" * 50_000_000
    started = time.perf_counter()
    with pytest.raises(JsonLimitError) as refused:
        json_value([big] * 11)
    assert refused.value.limit == "bytes"
    assert time.perf_counter() - started < 0.5


def test_a_huge_key_is_refused_without_copying_it_to_sort_the_keys():
    # Encoding each key to sort it by UTF-16 code unit copied a 50 MB key twice over.
    for members in ({"x" * 50_000_000: 1, "b": 2}, {"\uffff" + "x" * 50_000_000: 1, "😀": 2}):
        tracemalloc.start()
        try:
            with pytest.raises(JsonLimitError) as refused:
                json_value(members)
            peak = tracemalloc.get_traced_memory()[1]
        finally:
            tracemalloc.stop()
        assert refused.value.limit == "bytes"
        assert peak < 10_000_000


def test_keys_sort_by_utf16_code_unit_as_javascript_sorts_them():
    keys = ["\uffff", "😀", "a", "\ue000b", "𝄞", "z", "\ud7ff"]
    assert _utf16_order(keys, 1_000) == sorted(
        keys, key=lambda key: key.encode("utf-16-be", "surrogatepass")
    )


def test_an_output_the_process_cannot_hold_fails_its_case_as_too_large(
    evaluation_receiver, tmp_path, monkeypatch
):
    output = "an output the process cannot hold"
    checked = runner_module.json_value

    def exhausted(value, *args):
        if value == output:
            raise MemoryError
        return checked(value, *args)

    monkeypatch.setattr(runner_module, "json_value", exhausted)
    arguments = options(evaluation_receiver, tmp_path, lambda *_args: output, persist=False)
    try:
        run_experiment(**arguments)
        body = evaluation_receiver.complete_body
        assert body["state"] == "error" and body["error"] == {"type": "OutputTooLarge"}
        assert any(path.endswith("/finish") for _, path, *_ in evaluation_receiver.requests)
    finally:
        arguments["hue"].shutdown()


def test_fresh_exporter_cannot_acknowledge_a_prior_failed_trace(evaluation_receiver, tmp_path):
    receiver, calls = evaluation_receiver, []
    receiver.fail_otlp = True
    arguments = options(receiver, tmp_path, lambda *_: calls.append(1))
    with pytest.raises(TelemetryExportError):
        run_experiment(**arguments)
    arguments["hue"].shutdown()
    receiver.fail_otlp = False
    arguments["hue"] = Hue(receiver.url, "synthetic-key", capture_content=False)
    try:
        with pytest.raises(TelemetryExportError):
            run_experiment(**arguments)
        assert calls == [1] and receiver.completion is None
    finally:
        arguments["hue"].shutdown()


def test_explicit_omission_and_deferred_scorers_preserve_remote_result_slots(
    evaluation_receiver, tmp_path
):
    receiver = evaluation_receiver
    receiver.fail_otlp = True
    receiver.versions.extend(
        [
            {"id": str(uuid4()), "contentDigest": "e" * 64, "definition": {"kind": kind}}
            for kind in ("manual", "llm_judge")
        ]
    )
    arguments = options(
        receiver,
        tmp_path,
        lambda *_: None,
        evidence=TraceEvidence("omit", "Trace receiver is unavailable"),
    )
    try:
        report = run_experiment(**arguments)
        assert len(report.deferred_scorer_version_ids) == 2
        assert len(receiver.scores) == 1
        assert receiver.complete_body["traceEvidence"] == "omit"
        assert receiver.complete_body["omissionReason"] == "Trace receiver is unavailable"
    finally:
        arguments["hue"].shutdown()


def test_exclusive_checkpoint_owner_prevents_concurrent_target_invocation(
    evaluation_receiver, tmp_path
):
    entered, release, calls = Event(), Event(), []

    def target(*_args):
        calls.append(1)
        entered.set()
        assert release.wait(5)
        return None

    arguments = options(evaluation_receiver, tmp_path, target)
    try:
        with ThreadPoolExecutor(1) as executor:
            future = executor.submit(run_experiment, **arguments)
            assert entered.wait(5)
            try:
                with pytest.raises(RuntimeError, match="locked"):
                    run_experiment(**arguments)
            finally:
                release.set()
            future.result(5)
        assert calls == [1]
        with pytest.raises(RuntimeError, match="identity differs"):
            run_experiment(**{**arguments, "persist_result_content": False})
    finally:
        arguments["hue"].shutdown()


def test_builtin_types_schema_process_and_local_error_boundaries():
    context = {
        "inputs": None,
        "has_output": True,
        "output": False,
        "has_expected": True,
        "expected": 0,
        "metadata": {},
        "execution_state": "succeeded",
    }
    version = {"definition": builtins.exact_match()}
    assert score_locally(version, context)["metrics"][0]["value"] is False
    assert (
        score_locally(
            version, {**context, "output": {"a": 1, "b": None}, "expected": {"b": None, "a": 1.0}}
        )["metrics"][0]["value"]
        is True
    )
    for schema, output, expected in [
        ({"const": {"$async": True}}, {"$async": True}, True),
        ({"minimum": 0}, 1, True),
        ({"annotation": "allowed", "type": "string"}, 1, False),
        ({"$defs": {"value": {"type": "null"}}, "$ref": "#/$defs/value"}, None, True),
        ({"type": "object", "properties": {"child": {"$ref": "#"}}}, {"child": {}}, True),
        ({"type": "object", "properties": {"child": {"$ref": "#"}}}, {"child": 1}, False),
    ]:
        result = score_locally(
            {"definition": builtins.json_schema(schema)}, {**context, "output": output}
        )
        assert result["metrics"][0]["value"] is expected
    remote = score_locally(
        {"definition": builtins.json_schema({"$ref": "https://unreachable.test/schema"})}, context
    )
    assert remote == {"state": "error", "error": {"type": "InvalidSchema"}}
    timeout = score_locally(
        {"definition": builtins.json_schema({"type": "string", "pattern": "(a+)+$"})},
        {**context, "output": "a" * 100 + "!"},
        schema_timeout_millis=500,
    )
    assert timeout == {"state": "error", "error": {"type": "SchemaTimeout"}}
    local = define_local_scorer(
        source="score source",
        entrypoint="score",
        metrics=[{"name": "score", "type": "number"}],
        score=lambda _: {
            "state": "scored",
            "metrics": [{"name": "score", "value": True}],
            "explanation": "Invalid boolean-as-number",
        },
    )
    assert (
        score_locally({"definition": local.definition}, context, scorers=[local])["state"]
        == "error"
    )


@pytest.mark.parametrize("cancelled", [False, True])
def test_async_target_errors_and_cancellation_stay_distinct_and_redacted(
    evaluation_receiver, tmp_path, cancelled
):
    async def target(*_args):
        await asyncio.sleep(0)
        if cancelled:
            raise asyncio.CancelledError("sensitive-cancellation")
        raise RuntimeError("sensitive-target-error")

    arguments = options(evaluation_receiver, tmp_path, target, persist=False)
    try:
        run_experiment(**arguments)
        body = evaluation_receiver.complete_body
        assert body["state"] == ("cancelled" if cancelled else "error")
        assert "output" not in body
        if not cancelled:
            assert body["error"] == {"type": "TargetError"}
        persisted = b"".join(
            path.read_bytes() for path in arguments["checkpoint_directory"].glob("*.json")
        )
        assert b"sensitive-target-error" not in persisted
        assert b"sensitive-cancellation" not in persisted
        score = list(evaluation_receiver.scores.values())[0]["body"]["results"][0]
        assert score["state"] == "skipped"
    finally:
        arguments["hue"].shutdown()


def test_concurrency_allows_up_to_64_cases_in_flight():
    runner_module._settings(False, 64, 2000)
    for concurrency in (0, 65):
        with pytest.raises(ValueError, match="concurrency must be 1–64"):
            runner_module._settings(False, concurrency, 2000)


@pytest.mark.parametrize("field", ["inputs", "config"])
def test_invalid_runner_inputs_never_become_target_errors(evaluation_receiver, tmp_path, field):
    setattr(evaluation_receiver, field, {"unrepresentable_python_integer": 2**54})
    calls = []
    arguments = options(evaluation_receiver, tmp_path, lambda *_: calls.append(True))
    try:
        for _ in range(2):
            with pytest.raises(ValueError, match="Expected JSON"):
                run_experiment(**arguments)
        assert not calls
        assert evaluation_receiver.starts == 0 and evaluation_receiver.completion is None
        assert not list(arguments["checkpoint_directory"].glob("case-*.json"))
    finally:
        arguments["hue"].shutdown()


def test_worker_waiting_to_dequeue_cannot_start_after_sibling_failure(monkeypatch):
    waiting, failure_recorded = Event(), Event()
    calls = []
    roles = {}

    class ScheduledLock:
        """Pause a real worker at lock acquisition to reproduce the stop/dequeue race."""

        def __init__(self):
            self.lock = Lock()

        def __enter__(self):
            name = current_thread().name
            if roles.get(name) == 1:
                waiting.set()
                assert failure_recorded.wait(5)
            self.lock.acquire()

        def __exit__(self, *_args):
            name = current_thread().name
            if roles.get(name) == 0:
                failure_recorded.set()
            self.lock.release()

    monkeypatch.setattr(runner_module, "Lock", ScheduledLock)

    def execute(item):
        roles[current_thread().name] = item["id"]
        calls.append(item["id"])
        if item["id"] == 0:
            assert waiting.wait(5)
            raise RuntimeError("first case failed")

    with pytest.raises(RuntimeError, match="first case failed"):
        runner_module._pool([{"id": i} for i in range(4)], 2, execute)
    assert sorted(calls) == [0, 1]


def test_concurrent_flush_drains_later_spans_after_an_earlier_trace_drain(receiver):
    receiver.delay_seconds = 0.1
    with Hue(receiver.url, "synthetic-key", capture_content=True) as hue:
        with hue.span("first") as first:
            first.log_inference(output=None)
        with ThreadPoolExecutor(2) as executor:
            early = executor.submit(hue.force_flush)
            deadline = time.monotonic() + 5
            while True:
                with receiver.lock:
                    reached_logs = any(path.endswith("/logs") for path, _, _ in receiver.requests)
                if reached_logs:
                    break
                assert time.monotonic() < deadline
                time.sleep(0.005)
            # The first caller already drained traces and is waiting on its log request.
            with hue.span("later") as later:
                later.log_inference(output=None)
            following = executor.submit(hue.force_flush)
            assert following.result(5) is True and early.result(5) is True
            assert {span.name for span in receiver.spans()} == {"first", "later"}
        receiver.delay_seconds = 0
        receiver.reply(400)
        with hue.span("failed"):
            pass
        assert not hue.force_flush()
        with hue.span("after-failure"):
            pass
        assert not hue.force_flush()  # An earlier caller cannot consume exporter failure evidence.


def test_client_http_boundaries_and_hosted_controls(receiver):
    client = EvaluationClient(receiver.url, "synthetic-private-key")
    receiver.reply(302, b"synthetic-private-key", Location="http://127.0.0.1:1/stolen")
    with pytest.raises(HueApiError) as redirect:
        client.check_connection()
    assert redirect.value.status == 302 and "synthetic-private-key" not in str(redirect.value)
    assert len(receiver.requests) == 1 and "synthetic-private-key" not in repr(client)
    with pytest.raises(TypeError):
        client.start_execution(
            str(uuid4()), str(uuid4()), idempotency_key="key", allow_uncertain_retry="false"
        )
    receiver.reply(200, b'{"payload":"' + b"x" * (4 * 1024 * 1024) + b'"}')
    with pytest.raises(HueApiError):
        client.check_connection()
    run_id, job_id, item_id, scorer_id = [str(uuid4()) for _ in range(4)]
    for response, invoke_client, suffix in [
        (
            {"ids": [job_id]},
            lambda: client.create_judge_jobs(
                run_id,
                idempotency_key="stable",
                jobs=[{"evaluationItemId": item_id, "scorerVersionId": scorer_id}],
            ),
            f"/evaluation-runs/{run_id}/judge-jobs",
        ),
        (
            {"items": [], "nextCursor": None},
            lambda: client.list_judge_jobs(run_id),
            f"/evaluation-runs/{run_id}/judge-jobs?limit=100",
        ),
        (
            {"id": job_id, "state": "queued"},
            lambda: client.get_judge_job(job_id),
            f"/judge-jobs/{job_id}",
        ),
        (
            {"id": job_id, "state": "cancelled"},
            lambda: client.cancel_judge_job(job_id, reason="Requested cancellation"),
            f"/judge-jobs/{job_id}/cancel",
        ),
        (
            {"enabled": True, "allowanceMicroUsd": 1000, "reservedMicroUsd": 0, "spentMicroUsd": 0},
            client.get_judge_budget,
            "/judge-budget",
        ),
    ]:
        receiver.reply(200, json.dumps(response).encode(), **{"Content-Type": "application/json"})
        assert invoke_client() == response
        assert receiver.requests[-1][0].endswith(suffix)


def test_json_and_checkpoint_boundaries(tmp_path):
    for value in [float("inf"), 2**53, "\0", "\ud800", {1: "coercion"}, MISSING]:
        with pytest.raises(ValueError):
            json_value(value)
    assert json_value({"__proto__": {"literal": True}}) == {"__proto__": {"literal": True}}
    store = CheckpointStore(tmp_path / "private", {"run": "test"})
    try:
        store.write("case", {"value": None})
        assert (store.directory / "case.json").stat().st_mode & 0o077 == 0
        path = store.directory / "case.json"
        path.write_text(path.read_text().replace('"value":null', '"value":false'))
        with pytest.raises(RuntimeError, match="integrity"):
            store.read("case")
        (store.directory / "symlink.json").symlink_to(path)
        with pytest.raises(OSError):
            store.read("symlink")
    finally:
        store.release()


def test_installed_wheel_runs_evaluations_and_schema_subprocess(evaluation_receiver, tmp_path):
    package = Path(__file__).resolve().parents[1]
    dist, consumer = tmp_path / "dist", tmp_path / "consumer"
    for command in (
        [sys.executable, "-m", "build", "--no-isolation", str(package), "--outdir", str(dist)],
        ["uv", "venv", str(consumer), "--python", sys.executable],
    ):
        subprocess.run(command, check=True, capture_output=True)
    python = consumer / "bin" / "python"
    subprocess.run(
        ["uv", "pip", "install", "--python", str(python), f"{next(dist.glob('*.whl'))}[evals]"],
        check=True,
        capture_output=True,
    )
    program = """
import os, hue_sdk
from hue_sdk import Hue
from hue_sdk.evals import EvaluationClient, TraceEvidence, run_experiment, builtins, score_locally
assert os.environ['CONSUMER'] in hue_sdk.__file__
client = EvaluationClient(os.environ['HUE_BASE_URL'], os.environ['HUE_API_KEY'])
assert client.get_eval_set_version(os.environ['VERSION'])['evalSetId'] == os.environ['DATASET']
assert client.get_run(os.environ['EXPERIMENT'])['evalSetVersionId'] == os.environ['VERSION']
assert client.create_run(idempotency_key='installed-run', name='Installed run',
    eval_set_version_id=os.environ['VERSION'], evaluator_version_ids=[], config={})['scoringId']
with Hue(os.environ['HUE_BASE_URL'], os.environ['HUE_API_KEY'], capture_content=False) as hue:
    report = run_experiment(client=client, hue=hue, experiment_id=os.environ['EXPERIMENT'],
        target=lambda inputs, context: None, checkpoint_directory='checkpoints',
        persist_result_content=True, trace_evidence=TraceEvidence('required'))
    assert len(report.result_ids) == 1
result = score_locally({'definition':builtins.json_schema({'type':'null'})},
    {'inputs':None,'has_output':True,'output':None,'has_expected':False,
     'metadata':{},'execution_state':'succeeded'})
assert result['metrics'][0]['value'] is True
print('installed evaluation wheel passed')
"""
    completed = subprocess.run(
        [str(python), "-I", "-c", program],
        cwd=tmp_path,
        env={
            "PATH": os.environ["PATH"],
            "HUE_BASE_URL": evaluation_receiver.url,
            "HUE_API_KEY": "synthetic-wheel-key",
            "EXPERIMENT": evaluation_receiver.experiment_id,
            "VERSION": evaluation_receiver.version_id,
            "DATASET": evaluation_receiver.dataset_id,
            "CONSUMER": str(consumer),
        },
        check=True,
        capture_output=True,
        text=True,
    )
    assert "installed evaluation wheel passed" in completed.stdout
    assert "synthetic-wheel-key" not in completed.stdout + completed.stderr


def test_builtin_scorers_is_the_documented_name_and_builtins_stays_an_alias():
    import builtins as stdlib_builtins

    import hue_sdk.evals as evals
    from hue_sdk.evals import builtin_scorers
    from hue_sdk.evals.scorers import Builtins

    assert isinstance(builtin_scorers, Builtins)
    assert evals.builtins is builtin_scorers
    assert evals.builtins is not stdlib_builtins
    assert {"builtin_scorers", "builtins"} <= set(evals.__all__)
    assert builtin_scorers.exact_match() == builtins.exact_match()
