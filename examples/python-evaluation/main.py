"""Standalone synthetic evaluation journey through the installed public Hue SDK."""

from __future__ import annotations

import argparse
import inspect
import json
import os
from pathlib import Path
from uuid import uuid4

from hue_sdk import Hue
from hue_sdk.evals import (
    MISSING,
    EvaluationClient,
    ScoreContext,
    TargetContext,
    TraceEvidence,
    builtins,
    define_local_scorer,
    rescore,
    run_experiment,
)


def has_value(context: ScoreContext):
    value = context["output"] is not None
    return {
        "state": "scored",
        "metrics": [{"name": "has_value", "value": value, "passed": value}],
        "explanation": "Output presence evaluated locally",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture-content", choices=("yes", "no"), required=True)
    parser.add_argument("--persist-result-content", choices=("yes", "no"), required=True)
    parser.add_argument("--checkpoint-directory", type=Path, required=True)
    parser.add_argument("--name-prefix", default="Python evaluation")
    args = parser.parse_args()
    prefix = f"{args.name_prefix[:50]} {str(uuid4())[:8]}"
    client = EvaluationClient(os.environ["HUE_BASE_URL"], os.environ["HUE_API_KEY"])
    local = define_local_scorer(
        source=inspect.getsource(has_value),
        entrypoint="has_value",
        metrics=[{"name": "has_value", "type": "boolean"}],
        score=has_value,
    )
    definitions = [
        builtins.exact_match(),
        builtins.includes(False),
        builtins.json_schema({"type": ["string", "null"]}),
        local.definition,
    ]
    versions = []
    for label, definition in zip(
        ("Exact", "Includes", "Schema", "Has value"), definitions, strict=True
    ):
        scorer = client.create_scorer(name=f"{prefix} {label}", slug=f"python-eval-{uuid4()}")
        versions.append(client.publish_scorer_version(scorer["id"], definition)["id"])
    dataset = client.create_dataset(name=f"{prefix} cases", slug=f"python-eval-{uuid4()}")
    draft = dataset["versions"][0]
    for key, inputs, expected in [
        ("greeting", {"answer": "Hello Hue"}, "Hello Hue"),
        ("explicit-null", {"answer": None}, None),
        ("target-error", {"fail": True}, MISSING),
    ]:
        response = client.add_case(
            draft["id"],
            expected_revision=draft["revision"],
            external_key=key,
            inputs=inputs,
            expected=expected,
            metadata={"example": "python-evaluation"},
        )
        draft = response["version"]
    frozen = client.freeze_dataset_version(draft["id"], draft["revision"])
    invocations = []

    def target(inputs, context: TargetContext):
        invocations.append(context.item["id"])
        with hue.tool("format-answer") as tool:
            if inputs.get("fail"):
                raise ValueError("Synthetic target failure")
            result = inputs["answer"]
            if context.config["variant"] == "uppercase" and isinstance(result, str):
                result = result.upper()
            tool.set_output(result)
            return result

    experiments, subjects, results = [], [], []
    with Hue(
        os.environ["HUE_BASE_URL"],
        os.environ["HUE_API_KEY"],
        capture_content=args.capture_content == "yes",
    ) as hue:
        for variant in ("baseline", "uppercase"):
            experiment = client.create_experiment(
                idempotency_key=str(uuid4()),
                name=f"{prefix} {variant}",
                dataset_version_id=frozen["id"],
                scorer_version_ids=versions,
                config={"variant": variant},
            )
            options = dict(
                client=client,
                hue=hue,
                experiment_id=experiment["id"],
                target=target,
                checkpoint_directory=args.checkpoint_directory / experiment["id"],
                persist_result_content=args.persist_result_content == "yes",
                trace_evidence=TraceEvidence("required"),
                scorers=[local],
            )
            report = run_experiment(**options)
            count = len(invocations)
            repeated = run_experiment(**options)
            assert len(invocations) == count
            assert set(repeated.result_ids) == set(report.result_ids)
            experiments.append(experiment["id"])
            subjects.extend(report.subject_ids)
            results.extend(report.result_ids)
    historical = client.create_evaluation_run(
        idempotency_key=str(uuid4()),
        name=f"{prefix} rescore",
        subject_ids=subjects,
        scorer_version_ids=versions,
    )
    report = rescore(
        client=client,
        run_id=historical["id"],
        checkpoint_directory=args.checkpoint_directory / historical["id"],
        persist_result_content=args.persist_result_content == "yes",
        scorers=[local],
    )
    assert len(invocations) == 6
    assert len(results) == 24 and len(report.result_ids) == 24
    print(
        json.dumps(
            {
                "mode": "synthetic",
                "experiments": experiments,
                "dataset_version_id": frozen["id"],
                "historical_run_id": historical["id"],
                "target_invocations": len(invocations),
                "primary_results": len(results),
                "historical_results": len(report.result_ids),
            }
        )
    )


if __name__ == "__main__":
    main()
