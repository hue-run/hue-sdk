from __future__ import annotations

import asyncio
import copy
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event, Lock
from typing import Any, cast
from uuid import uuid4

from opentelemetry.context import Context

from ..client import Hue
from ._checkpoint import CheckpointStore
from ._json import MISSING, json_value, uuid
from .client import EvaluationClient
from .scorers import invoke, persisted_score, score_locally, validate_bindings
from .types import LocalScorer, RunnerReport, ScoreContext, TargetContext, TraceEvidence


class UncertainExecutionError(RuntimeError):
    def __init__(self, case_id: str, execution_id: str | None = None) -> None:
        self.case_id, self.execution_id = case_id, execution_id
        super().__init__(
            "Execution has no saved outcome. Inspect it and explicitly authorize a new attempt; "
            "the target will not run again."
        )


class OutcomeSerializationError(RuntimeError):
    def __init__(self, execution_id: str) -> None:
        self.execution_id = execution_id
        super().__init__(
            "Target completed but its output could not be serialized. Resolve completion "
            "explicitly; the target will not run again."
        )


class TelemetryExportError(RuntimeError):
    def __init__(self, execution_id: str) -> None:
        self.execution_id = execution_id
        super().__init__(
            "Target outcome is saved but trace acknowledgement is unavailable. "
            "Restore/export the trace or explicitly complete with omitted evidence; "
            "never rerun the target."
        )


def _settings(persist: bool, concurrency: int, timeout: int) -> None:
    if type(persist) is not bool:
        raise TypeError("Choose persist_result_content explicitly: True or False.")
    if type(concurrency) is not int or not 1 <= concurrency <= 16:
        raise ValueError("concurrency must be 1–16.")
    if type(timeout) is not int or not 100 <= timeout <= 60_000:
        raise ValueError("schema_timeout_millis must be 100–60000.")


def _pages(page: Callable[[str | None], dict[str, Any]]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    cursors: set[str] = set()
    after = None
    while True:
        response = page(after)
        items.extend(response["items"])
        if len(items) > 5000:
            raise ValueError("Runner supports at most 5000 items.")
        if response["nextCursor"] is None:
            return items
        after = uuid(response["nextCursor"])
        if after in cursors:
            raise ValueError("API pagination repeated a cursor.")
        cursors.add(after)


def _pool(
    items: list[dict[str, Any]], concurrency: int, execute: Callable[[dict[str, Any]], None]
) -> None:
    iterator = iter(items)
    lock, stopped = Lock(), Event()
    failures: list[BaseException] = []

    def worker() -> None:
        while True:
            with lock:
                if stopped.is_set():
                    return
                item = next(iterator, None)
            if item is None:
                return
            try:
                execute(item)
            except BaseException as error:
                with lock:
                    failures.append(error)
                    stopped.set()
                return

    with ThreadPoolExecutor(max_workers=concurrency, thread_name_prefix="hue-eval") as executor:
        futures = [executor.submit(worker) for _ in range(min(concurrency, len(items)))]
        for future in futures:
            future.result()
    if len(failures) == 1:
        raise failures[0]
    if failures:
        raise RuntimeError(
            "Multiple case operations failed; resume uses saved outcomes."
        ) from failures[0]


def _pins(versions: list[dict[str, Any]]) -> list[dict[str, str]]:
    return sorted(
        ({"id": v["id"], "contentDigest": v["contentDigest"]} for v in versions),
        key=lambda value: value["id"],
    )


def _deferred(versions: list[dict[str, Any]]) -> list[str]:
    for version in versions:
        if version["definition"]["kind"] not in ("builtin", "local_code", "manual", "llm_judge"):
            raise ValueError("Pinned scorer kind is unsupported.")
    return [v["id"] for v in versions if v["definition"]["kind"] in ("manual", "llm_judge")]


def _scores(
    versions: list[dict[str, Any]],
    context: dict[str, Any],
    scorers: list[LocalScorer],
    persist: bool,
    timeout: int,
) -> list[dict[str, Any]]:
    results = []
    for version in versions:
        definition = version["definition"]
        if definition["kind"] in ("manual", "llm_judge"):
            continue
        score = persisted_score(
            score_locally(
                version, cast(ScoreContext, context), scorers=scorers, schema_timeout_millis=timeout
            ),
            persist,
        )
        results.append(
            {
                "key": str(uuid4()),
                "payload": {
                    **score,
                    "scorerVersionId": version["id"],
                    **(
                        {"sourceDigest": definition["sourceDigest"]}
                        if definition["kind"] == "local_code"
                        else {}
                    ),
                },
            }
        )
    return results


def _upload(
    client: EvaluationClient, run_id: str, scores: list[dict[str, Any]], save: Callable[[], None]
) -> None:
    for score in scores:
        if "receipt" in score:
            continue
        if not score["payload"].get("evaluationItemId"):
            raise ValueError("Scoring requires an acknowledged evaluation item.")
        result = client.submit_results(
            run_id, idempotency_key=score["key"], results=[score["payload"]]
        )
        score["receipt"] = result["ids"]
        save()


def _error_message(error: Exception) -> str:
    # The caller opted into storing result content; PostgreSQL still rejects invalid text.
    return "".join(
        char for char in str(error)[:4000] if char != "\0" and not 0xD800 <= ord(char) <= 0xDFFF
    )


def run_experiment(
    *,
    client: EvaluationClient,
    hue: Hue,
    experiment_id: str,
    target: Callable[[Any, TargetContext], Any],
    checkpoint_directory: str | Path,
    persist_result_content: bool,
    trace_evidence: TraceEvidence,
    scorers: list[LocalScorer] | None = None,
    concurrency: int = 1,
    schema_timeout_millis: int = 2000,
) -> RunnerReport:
    """Run trusted sync/async targets locally; never automatically repeat uncertain work.

    This synchronous entry point runs callbacks in worker threads. In an async application,
    call it with asyncio.to_thread. Custom callbacks have no claimed cancellation timeout.
    """
    _settings(persist_result_content, concurrency, schema_timeout_millis)
    if not isinstance(trace_evidence, TraceEvidence) or trace_evidence.mode not in (
        "required",
        "omit",
    ):
        raise TypeError("Choose a trace evidence policy explicitly.")
    if trace_evidence.mode == "omit" and (
        not isinstance(trace_evidence.reason, str)
        or not trace_evidence.reason.strip()
        or len(trace_evidence.reason) > 4000
    ):
        raise ValueError("Omitting trace evidence requires a bounded reason.")
    if trace_evidence.mode == "required" and trace_evidence.reason is not None:
        raise ValueError("Required evidence cannot include an omission reason.")
    if hue.base_url != client.base_url:
        raise ValueError("Telemetry and evaluations must use the same Hue origin.")
    project, telemetry_project = client.check_connection(), hue.validate_project()
    if project["id"] != telemetry_project.id:
        raise ValueError("Telemetry and evaluations must use the same Hue project.")
    experiment = client.get_experiment(experiment_id)
    configuration = json_value(experiment["config"])
    version = client.get_dataset_version(experiment["datasetVersionId"])
    if not version["frozenAt"] or not version["contentDigest"]:
        raise ValueError("Experiment dataset must be frozen.")
    versions = experiment["evaluation"]["scorerVersions"]
    local = scorers or []
    validate_bindings(versions, local)
    deferred = _deferred(versions)
    items = _pages(lambda after: client.list_experiment_items(experiment_id, after=after))
    if len(items) != experiment["caseCount"]:
        raise ValueError("Frozen experiment case count differs from its API items.")
    evidence = {
        "mode": trace_evidence.mode,
        **({"reason": trace_evidence.reason} if trace_evidence.mode == "omit" else {}),
    }
    store = CheckpointStore(
        checkpoint_directory,
        {
            "kind": "experiment",
            "projectId": project["id"],
            "baseUrl": client.base_url,
            "experimentId": experiment_id,
            "datasetVersionId": version["id"],
            "datasetDigest": version["contentDigest"],
            "configDigest": experiment["configDigest"],
            "pins": _pins(versions),
            "persistResultContent": persist_result_content,
            "captureContent": hue.capture_content,
            "traceEvidence": evidence,
        },
    )
    report = RunnerReport(experiment["evaluation"]["id"], [], [], deferred)
    report_lock = Lock()

    def execute(item: dict[str, Any]) -> None:
        file = f"case-{uuid(item['id'])}"
        checkpoint = store.read(file)
        if checkpoint is not None and checkpoint["stage"] != "prepared":
            if checkpoint["stage"] == "serialization_failed":
                raise OutcomeSerializationError(checkpoint["executionId"])
            execution = (
                client.start_execution(
                    experiment_id,
                    item["id"],
                    idempotency_key=checkpoint["startKey"],
                    trace_external_id=checkpoint["traceExternalId"],
                )
                if checkpoint["stage"] == "starting"
                else client.get_execution(checkpoint["executionId"])
            )
            raise UncertainExecutionError(item["id"], execution["id"])
        if checkpoint is None:
            if item["execution"] is not None:
                raise UncertainExecutionError(item["id"], item["execution"]["id"])
            case = client.get_experiment_case(experiment_id, item["id"])
            if case["datasetVersionId"] != version["id"]:
                raise ValueError("Case is not from the pinned dataset version.")
            # Validate before creating a remote execution. SDK/input failures are
            # not target failures, and cannot consume a case's execution slot.
            target_inputs = copy.deepcopy(json_value(case["inputs"]))
            target_config = copy.deepcopy(configuration)
            target_case = copy.deepcopy(case)
            with hue.span(
                "hue.experiment.case",
                parent_context=Context(),
                attributes={"hue.experiment.id": experiment_id, "hue.dataset.case.id": item["id"]},
            ) as span:
                span.set_input(case["inputs"])
                start = {
                    "stage": "starting",
                    "startKey": str(uuid4()),
                    "traceExternalId": span.trace_id,
                }
                store.write(file, start)
                execution = client.start_execution(
                    experiment_id,
                    item["id"],
                    idempotency_key=start["startKey"],
                    trace_external_id=span.trace_id,
                )
                store.write(file, {"stage": "running", "executionId": execution["id"]})
                state, output, target_error = "succeeded", MISSING, None
                try:
                    output = invoke(
                        target,
                        target_inputs,
                        TargetContext(target_config, target_case, span),
                    )
                except asyncio.CancelledError as error:
                    state = "cancelled"
                    span.record_error(error)
                except Exception as error:
                    state, target_error = "error", error
                    span.record_error(error)
                if output is not MISSING:
                    try:
                        json_value(output)
                    except (ValueError, TypeError, RecursionError):
                        store.write(
                            file, {"stage": "serialization_failed", "executionId": execution["id"]}
                        )
                        raise OutcomeSerializationError(execution["id"]) from None
                    span.set_output(output)
                scores = _scores(
                    versions,
                    {
                        "inputs": case["inputs"],
                        "has_expected": case["hasExpected"],
                        **({"expected": case["expected"]} if case["hasExpected"] else {}),
                        "metadata": case["metadata"],
                        "has_output": output is not MISSING,
                        **({"output": output} if output is not MISSING else {}),
                        "execution_state": state,
                    },
                    local,
                    persist_result_content,
                    schema_timeout_millis,
                )
                complete = {
                    "idempotencyKey": str(uuid4()),
                    "state": state,
                    **(
                        {"output": output}
                        if persist_result_content and output is not MISSING
                        else {}
                    ),
                    **(
                        {
                            "error": {
                                "type": "TargetError",
                                **(
                                    {"message": _error_message(target_error)}
                                    if persist_result_content
                                    else {}
                                ),
                            }
                        }
                        if target_error is not None
                        else {}
                    ),
                    "traceEvidence": trace_evidence.mode,
                    **(
                        {"omissionReason": trace_evidence.reason}
                        if trace_evidence.mode == "omit"
                        else {}
                    ),
                }
                checkpoint = {
                    "stage": "prepared",
                    "executionId": execution["id"],
                    "complete": complete,
                    "scores": scores,
                    "exportState": "pending",
                }
                store.write(file, checkpoint)
            if hue.force_flush():
                checkpoint["exportState"] = "accepted"
                store.write(file, checkpoint)
            elif trace_evidence.mode != "omit":
                raise TelemetryExportError(execution["id"])
        client.get_execution(checkpoint["executionId"])
        if (
            checkpoint["exportState"] != "accepted"
            and checkpoint["complete"]["traceEvidence"] != "omit"
        ):
            raise TelemetryExportError(checkpoint["executionId"])

        def save() -> None:
            store.write(file, checkpoint)

        if "completion" not in checkpoint:
            checkpoint["completion"] = client.complete_execution(
                checkpoint["executionId"], checkpoint["complete"]
            )
            for score in checkpoint["scores"]:
                score["payload"]["evaluationItemId"] = checkpoint["completion"]["evaluationItemId"]
            save()
        _upload(client, report.run_id, checkpoint["scores"], save)
        with report_lock:
            report.subject_ids.append(checkpoint["completion"]["subjectId"])
            for score in checkpoint["scores"]:
                report.result_ids.extend(score["receipt"])

    try:
        _pool(items, concurrency, execute)
        finish = store.read("finish")
        if finish is None:
            finish = {"key": str(uuid4())}
            store.write("finish", finish)
        client.finish_experiment(experiment_id, finish["key"])
        return report
    finally:
        store.release()


def rescore(
    *,
    client: EvaluationClient,
    run_id: str,
    checkpoint_directory: str | Path,
    persist_result_content: bool,
    scorers: list[LocalScorer] | None = None,
    concurrency: int = 1,
    schema_timeout_millis: int = 2000,
) -> RunnerReport:
    """Score existing immutable subjects. This entry point has no target callback."""
    _settings(persist_result_content, concurrency, schema_timeout_millis)
    project, run = client.check_connection(), client.get_evaluation_run(run_id)
    versions, local = run["scorerVersions"], scorers or []
    validate_bindings(versions, local)
    deferred = _deferred(versions)
    items = _pages(lambda after: client.list_evaluation_items(run_id, after=after))
    if len(items) != run["itemCount"]:
        raise ValueError("Evaluation run item count differs from its API items.")
    store = CheckpointStore(
        checkpoint_directory,
        {
            "kind": "rescore",
            "projectId": project["id"],
            "baseUrl": client.base_url,
            "runId": run_id,
            "pins": _pins(versions),
            "persistResultContent": persist_result_content,
        },
    )
    report, report_lock = RunnerReport(run_id, [], [], deferred), Lock()

    def execute(item: dict[str, Any]) -> None:
        file = f"item-{uuid(item['id'])}"
        saved = store.read(file)
        if saved is None:
            subject = client.get_subject(item["subjectId"])
            scores = _scores(
                versions,
                {
                    "inputs": subject["inputs"],
                    "has_output": subject["hasOutput"],
                    "has_expected": subject["hasExpected"],
                    **({"output": subject["output"]} if subject["hasOutput"] else {}),
                    **({"expected": subject["expected"]} if subject["hasExpected"] else {}),
                    "metadata": subject["metadata"],
                    "execution_state": subject["executionState"],
                },
                local,
                persist_result_content,
                schema_timeout_millis,
            )
            for score in scores:
                score["payload"]["evaluationItemId"] = item["id"]
            saved = {"scores": scores}
            store.write(file, saved)
        _upload(client, run_id, saved["scores"], lambda: store.write(file, saved))
        with report_lock:
            report.subject_ids.append(item["subjectId"])
            for score in saved["scores"]:
                report.result_ids.extend(score["receipt"])

    try:
        _pool(items, concurrency, execute)
        return report
    finally:
        store.release()
