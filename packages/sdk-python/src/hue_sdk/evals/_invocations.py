"""Validate invocation boundaries without importing optional evaluation dependencies."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from ._json import aggregate_bounds, json_value, uuid


def _object(value: Any, keys: set[str] | None = None) -> dict[str, Any]:
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise ValueError("Expected an invocation object.")
    if keys is not None and value.keys() - keys:
        raise ValueError("Unknown invocation field.")
    return value


def _text(value: Any, maximum: int | None = None) -> str:
    if not isinstance(value, str) or not value or maximum is not None and len(value) > maximum:
        raise ValueError("Invalid invocation text.")
    return value


def _ids(value: Any) -> list[str]:
    if not isinstance(value, list):
        raise ValueError("Expected invocation IDs.")
    return [uuid(item) for item in value]


def _timestamp(value: Any) -> str:
    text = _text(value)
    parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    if parsed.utcoffset() is None:
        raise ValueError("Invocation timestamp needs a timezone.")
    return text


def _positive(value: Any) -> int:
    if type(value) is not int or value <= 0:
        raise ValueError("Expected a positive invocation integer.")
    return value


def policy(value: Any) -> dict[str, Any]:
    obj = _object(value, {"thresholds", "baselineComparisons"})
    thresholds = obj.get("thresholds", [])
    if not isinstance(thresholds, list):
        raise ValueError("Expected thresholds.")
    for threshold in thresholds:
        item = _object(threshold, {"evaluatorVersionId", "metric", "operator", "value"})
        uuid(item["evaluatorVersionId"])
        _text(item["metric"])
        if item["operator"] not in ("gte", "lte") or type(item["value"]) not in (int, float):
            raise ValueError("Invalid threshold.")
    if "baselineComparisons" in obj:
        comparisons = obj["baselineComparisons"]
        if not isinstance(comparisons, list):
            raise ValueError("Expected baseline comparisons.")
        for comparison in comparisons:
            item = _object(comparison, {"evaluatorVersionId", "metric", "operator", "tolerance"})
            uuid(item["evaluatorVersionId"])
            _text(item["metric"])
            if (
                item["operator"] not in ("gte", "lte")
                or type(item["tolerance"]) not in (int, float)
                or not item["tolerance"] >= 0
            ):
                raise ValueError("Invalid baseline comparison.")
    return {**obj, "thresholds": thresholds}


def ci_context(value: Any) -> dict[str, Any]:
    text_fields = {
        "repository",
        "commitSha",
        "baseSha",
        "pullRequestHeadSha",
        "workflowRunId",
        "eventName",
    }
    integer_fields = {"pullRequestNumber", "workflowRunAttempt"}
    obj = _object(value, {"provider"} | text_fields | integer_fields)
    if obj["provider"] not in ("github", "local"):
        raise ValueError("Invalid CI provider.")
    for key in text_fields & obj.keys():
        _text(obj[key])
    for key in integer_fields & obj.keys():
        _positive(obj[key])
    return obj


def creation(value: dict[str, Any]) -> dict[str, Any]:
    obj = _object(
        value,
        {
            "idempotencyKey",
            "name",
            "evalSetId",
            "evalSetVersionId",
            "evaluatorIds",
            "evaluatorVersionIds",
            "config",
            "policy",
            "ci",
            "deadlineAt",
            "baselineRunId",
        },
    )
    _text(obj["idempotencyKey"], 128)
    _timestamp(obj["deadlineAt"])
    if ("evalSetId" in obj) + ("evalSetVersionId" in obj) != 1:
        raise ValueError("Choose exactly one eval set selector.")
    for key in {"evalSetId", "evalSetVersionId", "baselineRunId"} & obj.keys():
        uuid(obj[key])
    for key in {"evaluatorIds", "evaluatorVersionIds"} & obj.keys():
        _ids(obj[key])
    if "name" in obj:
        _text(obj["name"], 100)
    if "policy" in obj:
        obj = {**obj, "policy": policy(obj["policy"])}
    if "ci" in obj:
        ci_context(obj["ci"])
    json_value(obj)
    return obj


def response(value: Any) -> dict[str, Any]:
    obj = _object(_object(value)["invocation"])
    for key in ("id", "runId"):
        uuid(obj[key])
    _text(obj["runUrl"])
    _timestamp(obj["deadlineAt"])
    if obj["state"] not in ("active", "finalized", "cancelled", "expired"):
        raise ValueError("Invalid invocation state.")
    manifest = _object(obj["manifest"])
    if manifest["version"] != 1:
        raise ValueError("Unknown invocation manifest version.")
    _text(manifest["digest"])
    for key in ("evalSetId", "evalSetVersionId", "scoringRunId"):
        uuid(manifest[key])
    if manifest["baselineRunId"] is not None:
        uuid(manifest["baselineRunId"])
    json_value(manifest["config"])
    policy(manifest["policy"])
    if not isinstance(manifest["cases"], list) or not isinstance(manifest["evaluators"], list):
        raise ValueError("Invalid invocation manifest entries.")
    for item in manifest["cases"]:
        case = _object(item)
        uuid(case["caseId"])
        _text(case["contentDigest"])
        if "inputIdentity" in case:
            _text(case["inputIdentity"])
        if "judgePinning" in case:
            for evaluator_id, scope in _object(case["judgePinning"]).items():
                uuid(evaluator_id)
                if scope not in ("this_case", "other_cases", "no_case"):
                    raise ValueError("Invalid case judge ownership.")
        _ids(case["evaluatorVersionIds"])
        json_value(case["world"])
    for item in manifest["evaluators"]:
        evaluator = _object(item)
        uuid(evaluator["id"])
        uuid(evaluator["evaluatorId"])
        _positive(evaluator["version"])
        _text(evaluator["kind"])
        _text(evaluator["contentDigest"])
    if obj["receipt"] is not None:
        receipt = _object(obj["receipt"])
        for key in ("id", "runId", "scoringRunId"):
            uuid(receipt[key])
        _text(receipt["manifestDigest"])
        if (
            receipt["runId"] != obj["runId"]
            or receipt["scoringRunId"] != manifest["scoringRunId"]
            or receipt["manifestDigest"] != manifest["digest"]
        ):
            raise ValueError("Gate receipt does not belong to this invocation manifest.")
        for key in {"baselineRunId", "baselineReceiptId"} & receipt.keys():
            uuid(receipt[key])
        if "comparisons" in receipt:
            if not isinstance(receipt["comparisons"], list):
                raise ValueError("Expected baseline comparisons.")
            for comparison in receipt["comparisons"]:
                policy(
                    {
                        "baselineComparisons": [
                            {
                                key: comparison[key]
                                for key in ("evaluatorVersionId", "metric", "operator", "tolerance")
                            }
                        ]
                    }
                )
                _ids(comparison["caseIds"])
                if (
                    type(comparison["candidateMean"]) not in (int, float)
                    or type(comparison["baselineMean"]) not in (int, float)
                    or type(comparison["passed"]) is not bool
                ):
                    raise ValueError("Invalid baseline comparison result.")
        _timestamp(receipt["finalizedAt"])
        _ids(receipt["executionIds"])
        if receipt["verdict"] not in ("pass", "fail", "incomplete", "error", "cancelled"):
            raise ValueError("Invalid gate verdict.")
        if not isinstance(receipt["reasons"], list) or not all(
            isinstance(reason, str) for reason in receipt["reasons"]
        ):
            raise ValueError("Invalid gate reasons.")
        if not isinstance(receipt["results"], list):
            raise ValueError("Invalid gate results.")
        for item in receipt["results"]:
            result = _object(item)
            for key in ("caseId", "executionId", "evaluatorVersionId", "resultId"):
                uuid(result[key])
            _text(result["state"])
            if not isinstance(result["metrics"], list):
                raise ValueError("Invalid result metrics.")
            for item in result["metrics"]:
                metric = _object(item)
                _text(metric["name"])
                if type(metric["value"]) not in (str, bool, int, float):
                    raise ValueError("Invalid metric value.")
                if "passed" in metric and type(metric["passed"]) is not bool:
                    raise ValueError("Invalid metric verdict.")
    json_value(obj, **aggregate_bounds(256 * 1024 * 1024))
    return obj


def operation(key: str, execution_ids: list[str] | None = None) -> dict[str, Any]:
    body: dict[str, Any] = {"idempotencyKey": _text(key, 128)}
    if execution_ids is not None:
        body["executionIds"] = _ids(execution_ids)
    return body


def hydrate(value: Any, load: Any) -> dict[str, Any]:
    """Read bounded pages pinned to the original manifest and immutable receipt."""
    import json
    from urllib.parse import urlencode

    obj = response(value)
    size = len(json.dumps(value, ensure_ascii=False).encode("utf-8"))
    fields = {"manifest.cases", "receipt.results", "receipt.reasons", "receipt.comparisons"}
    pages = _object(value).get("pages", [])
    if not isinstance(pages, list):
        raise ValueError("Invalid evidence pages.")
    seen: set[str] = set()
    for descriptor in pages:
        descriptor = _object(descriptor, {"field", "total"})
        field, total = descriptor["field"], _positive(descriptor["total"])
        if field not in fields or field in seen or total > 5_000_000:
            raise ValueError("Invalid evidence field.")
        seen.add(field)
        root, key = field.split(".")
        target = _object(obj[root])
        if target.get(key) != []:
            raise ValueError("Invalid evidence placeholder.")
        items: list[Any] = []
        while len(items) < total:
            query = {
                "field": field,
                "offset": str(len(items)),
                "manifestDigest": obj["manifest"]["digest"],
            }
            if obj["receipt"] is not None:
                query["receiptId"] = obj["receipt"]["id"]
            page = _object(load(f"/eval-invocations/{obj['id']}?{urlencode(query)}"))
            part = page["items"]
            if not isinstance(part, list) or not 1 <= len(part) <= 100:
                raise ValueError("Invalid evidence page entries.")
            end = len(items) + len(part)
            if (
                page["id"] != obj["id"]
                or page["manifestDigest"] != obj["manifest"]["digest"]
                or root == "receipt"
                and page["receiptId"] != obj["receipt"]["id"]
                or page["field"] != field
                or type(page["offset"]) is not int
                or page["offset"] != len(items)
                or type(page["total"]) is not int
                or page["total"] != total
                or end > total
                or page["nextOffset"] != (None if end == total else end)
            ):
                raise ValueError("Evidence page does not belong to this invocation.")
            size += len(json.dumps(part, ensure_ascii=False).encode("utf-8"))
            if size > 256 * 1024 * 1024:
                raise ValueError("Invocation evidence exceeds 256 MiB.")
            items.extend(part)
        target[key] = items
    return response({"invocation": obj})
