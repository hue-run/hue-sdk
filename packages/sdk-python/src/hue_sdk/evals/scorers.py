from __future__ import annotations

import asyncio
import copy
import hashlib
import importlib.util
import inspect
import json
import subprocess
import sys
from collections.abc import Awaitable, Callable
from typing import Any

from ._json import encode, json_equal, json_value
from .types import LocalScorer, Score, ScoreContext


class Builtins:
    @staticmethod
    def exact_match() -> dict[str, Any]:
        return {"kind": "builtin", "entry": "hue.exact_match.v1", "config": {}}

    @staticmethod
    def includes(case_sensitive: bool = True) -> dict[str, Any]:
        if type(case_sensitive) is not bool:
            raise TypeError("case_sensitive must be a boolean.")
        return {
            "kind": "builtin",
            "entry": "hue.includes.v1",
            "config": {"caseSensitive": case_sensitive},
        }

    @staticmethod
    def json_schema(schema: Any) -> dict[str, Any]:
        if not _schema_validator_available():
            raise ImportError(_SCHEMA_VALIDATOR_HINT)
        return {
            "kind": "builtin",
            "entry": "hue.json_schema.v1",
            "config": {"schema": copy.deepcopy(json_value(schema))},
        }


builtins = Builtins()


def define_local_scorer(
    *,
    source: str | bytes,
    entrypoint: str,
    metrics: list[dict[str, Any]],
    score: Callable[[ScoreContext], Score | Awaitable[Score]],
) -> LocalScorer:
    """Hash explicitly supplied source. Closures and installed dependencies are not attested."""
    if not isinstance(source, (str, bytes)) or not callable(score):
        raise TypeError("Supply source text/bytes and a trusted local score callback.")
    definition = {
        "kind": "local_code",
        "language": "python",
        "entrypoint": entrypoint,
        "sourceDigest": hashlib.sha256(
            source.encode("utf-8") if isinstance(source, str) else source
        ).hexdigest(),
        "metrics": copy.deepcopy(metrics),
    }
    json_value(definition)
    return LocalScorer(definition, score)


def invoke(callback: Callable[..., Any], *args: Any) -> Any:
    value = callback(*args)
    if inspect.isawaitable(value):

        async def await_value() -> Any:
            return await value

        return asyncio.run(await_value())
    return value


def validate_bindings(versions: list[dict[str, Any]], scorers: list[LocalScorer]) -> None:
    for version in versions:
        definition = version["definition"]
        if definition["kind"] == "local_code" and not any(
            json_equal(local.definition, definition) for local in scorers
        ):
            raise ValueError(
                "Pinned local scorer has no matching language/source/entrypoint/metric binding."
            )


def _match(value: bool, explanation: str) -> Score:
    return {
        "state": "scored",
        "metrics": [{"name": "match", "value": value, "passed": value}],
        "explanation": explanation,
    }


def _skip(reason: str) -> Score:
    return {"state": "skipped", "explanation": reason}


_SCHEMA_VALIDATOR_HINT = (
    "JSON Schema scoring requires the optional evals extra: pip install 'hue-run[evals]'"
)


def _schema_validator_available() -> bool:
    """jsonschema is optional: only JSON Schema scoring uses it, in an isolated process."""
    return importlib.util.find_spec("jsonschema") is not None


def _schema_score(schema: Any, output: Any, timeout_millis: int) -> Score:
    if not _schema_validator_available():
        return {
            "state": "error",
            "error": {"type": "SchemaValidatorUnavailable", "message": _SCHEMA_VALIDATOR_HINT},
        }
    # Async execution is not part of JSON Schema and cannot be opted into by stored config.
    pending = [schema]
    while pending:
        value = pending.pop()
        if isinstance(value, dict):
            if "$async" in value:
                return {"state": "error", "error": {"type": "InvalidSchema"}}
            for key in (
                "$defs",
                "definitions",
                "properties",
                "patternProperties",
                "dependentSchemas",
            ):
                if isinstance(value.get(key), dict):
                    pending.extend(value[key].values())
            for key in ("allOf", "anyOf", "oneOf", "prefixItems"):
                if isinstance(value.get(key), list):
                    pending.extend(value[key])
            for key in (
                "not",
                "if",
                "then",
                "else",
                "items",
                "contains",
                "additionalProperties",
                "unevaluatedProperties",
                "unevaluatedItems",
                "propertyNames",
            ):
                if key in value:
                    pending.append(value[key])
    try:
        result = subprocess.run(
            [sys.executable, "-I", "-m", "hue_sdk.evals._schema_worker"],
            input=encode({"schema": schema, "output": output}),
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=timeout_millis / 1000,
            check=False,
        )
        if result.returncode != 0:
            return {"state": "error", "error": {"type": "SchemaWorkerExit"}}
        value = json.loads(result.stdout)
        if type(value.get("match")) is bool:
            return _match(value["match"], "JSON Schema conformance evaluated locally")
        return {"state": "error", "error": {"type": "InvalidSchema"}}
    except subprocess.TimeoutExpired:
        return {"state": "error", "error": {"type": "SchemaTimeout"}}
    except (OSError, ValueError):
        return {"state": "error", "error": {"type": "SchemaWorkerError"}}


def score_locally(
    version: dict[str, Any],
    context: ScoreContext,
    *,
    scorers: list[LocalScorer] | None = None,
    schema_timeout_millis: int = 2000,
) -> Score:
    if type(schema_timeout_millis) is not int or not 100 <= schema_timeout_millis <= 60_000:
        raise ValueError("schema_timeout_millis must be 100–60000.")
    if not context.get("has_output"):
        return _skip("Output evidence is unavailable")
    if "output" not in context:
        raise ValueError("has_output requires present JSON output.")
    try:
        owned = copy.deepcopy(json_value(context, 1024 * 1024))
        definition = version["definition"]
        if definition["kind"] not in ("builtin", "local_code"):
            raise ValueError(
                "Manual and hosted scorers must be deferred to their execution service."
            )
        if definition["kind"] == "local_code":
            binding = next(
                (local for local in (scorers or []) if json_equal(local.definition, definition)),
                None,
            )
            if binding is None:
                return {"state": "error", "error": {"type": "ScorerBindingUnavailable"}}
            return validate_score(invoke(binding.score, owned), definition)
        entry = definition["entry"]
        if entry == "hue.json_schema.v1":
            return _schema_score(
                definition["config"]["schema"], owned["output"], schema_timeout_millis
            )
        if not owned["has_expected"]:
            return _skip("Reference evidence is unavailable")
        if entry == "hue.exact_match.v1":
            return _match(
                json_equal(owned["output"], owned["expected"]), "JSON exact match evaluated locally"
            )
        if entry != "hue.includes.v1":
            return {"state": "error", "error": {"type": "UnsupportedBuiltin"}}
        if type(owned["output"]) is not str or type(owned["expected"]) is not str:
            return _skip("Includes requires string output and reference")
        output, expected = owned["output"], owned["expected"]
        if not definition["config"]["caseSensitive"]:
            output, expected = output.lower(), expected.lower()
        return _match(expected in output, "String inclusion evaluated locally")
    except Exception:
        return {"state": "error", "error": {"type": "LocalScorerError"}}


def validate_score(value: Score, definition: dict[str, Any]) -> Score:
    score = copy.deepcopy(json_value(value))
    state = score.get("state")
    allowed = (
        {"state", "metrics", "explanation", "evidence"}
        if state == "scored"
        else ({"state", "error"} if state == "error" else {"state", "explanation"})
    )
    if set(score) - allowed:
        raise ValueError("Unexpected scorer result fields.")
    if state == "error":
        error = score.get("error", {})
        if (
            set(error) - {"type", "message"}
            or not isinstance(error.get("type"), str)
            or not 1 <= len(error["type"]) <= 200
        ):
            raise ValueError("Scorer error requires a bounded type.")
        if "message" in error and (
            not isinstance(error["message"], str) or len(error["message"]) > 4000
        ):
            raise ValueError("Invalid scorer error message.")
        return score
    explanation = score.get("explanation")
    if explanation is not None and (
        type(explanation) is not str or not explanation.strip() or len(explanation) > 4000
    ):
        raise ValueError("Invalid scorer explanation.")
    if state == "skipped":
        if not explanation:
            raise ValueError("Skipped score requires a reason.")
        return score
    if state != "scored" or type(score.get("metrics")) is not list:
        raise ValueError("Invalid scorer result.")
    definitions = (
        [{"name": "match", "type": "boolean"}]
        if definition["kind"] == "builtin"
        else definition["metrics"]
    )
    actual = score["metrics"]
    if len(actual) != len(definitions) or len({m["name"] for m in actual}) != len(definitions):
        raise ValueError("Return every declared metric exactly once.")
    for metric in definitions:
        result = next((m for m in actual if m["name"] == metric["name"]), None)
        if (
            result is None
            or set(result) - {"name", "value", "passed"}
            or ("passed" in result and type(result["passed"]) is not bool)
        ):
            raise ValueError("Invalid metric.")
        item, kind = result["value"], metric["type"]
        valid = (kind == "boolean" and type(item) is bool) or (kind == "text" and type(item) is str)
        if kind == "number":
            valid = (
                type(item) in (int, float)
                and ("min" not in metric or item >= metric["min"])
                and ("max" not in metric or item <= metric["max"])
            )
        if kind == "category":
            valid = type(item) is str and item in metric["categories"]
        if not valid or (type(item) is str and len(item) > 4000):
            raise ValueError("Metric does not satisfy its declared type or bounds.")
    evidence = score.get("evidence")
    meaningful = evidence is not None and (
        not isinstance(evidence, (str, list, dict))
        or bool(evidence.strip() if isinstance(evidence, str) else evidence)
    )
    if not explanation and not meaningful:
        raise ValueError("Scored results require explanation or evidence.")
    return score


def persisted_score(score: Score, persist_result_content: bool) -> Score:
    if persist_result_content:
        return score
    if score["state"] == "scored":
        return {
            "state": "scored",
            "metrics": score["metrics"],
            "explanation": "Local scoring completed; result content storage disabled",
        }
    if score["state"] == "error":
        return {"state": "error", "error": {"type": "LocalScorerError"}}
    safe = {
        "Output evidence is unavailable",
        "Reference evidence is unavailable",
        "Includes requires string output and reference",
    }
    reason = score["explanation"]
    return _skip(
        reason if reason in safe else "Local scoring skipped; result content storage disabled"
    )
