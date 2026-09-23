# Local evaluations

`hue_sdk.evals` adds a project-key HTTP client, local experiment runner, built-in scorers, explicit Python scorer declarations, and historical rescoring. Dataset versions and scorer versions must be frozen/published before execution. The runner reads their pinned IDs and digests from Hue; it never resolves mutable “latest” definitions while running.

Create a **Read and write** project service key under **Settings → Integrations & API keys** and expose it to this server-side process as `HUE_API_KEY`. A **Tracing only** key cannot author datasets or evaluation runs.

```python
import os
from hue_sdk import Hue
from hue_sdk.evals import EvaluationClient, TraceEvidence, run_experiment

client = EvaluationClient(api_key=os.environ["HUE_API_KEY"])

def target(inputs, context):
    # Call your application here. context.config is the frozen experiment config;
    # context.item contains the frozen case and context.span is an ordinary Hue span helper.
    return inputs["question"].upper()

with Hue(api_key=os.environ["HUE_API_KEY"], capture_content=False) as hue:
    report = run_experiment(
        client=client, hue=hue, experiment_id=os.environ["HUE_EXPERIMENT_ID"],
        target=target, checkpoint_directory=".local/my-evaluation",
        persist_result_content=True,
        trace_evidence=TraceEvidence("required"),
    )
    print(report.run_id)
```

The [evaluation guide](https://docs.hue.run/evaluations/first-evaluation) covers creating datasets and scorers before running an experiment.

## Client and definitions

`EvaluationClient(api_key=..., timeout_seconds=10)` uses the same project service key as telemetry and defaults to `https://app.hue.run`. Set `base_url` to override the origin for another Hue deployment; `EvaluationClient(base_url, api_key)` remains supported. Its methods cover dataset creation/versioning/cases/freezing, scorer creation/publication, experiment creation/start/completion/finish, evaluation runs/subjects/results, and hosted judge job submission/list/get/cancel/budget reads. Python method arguments use snake_case; response dictionaries and `complete_execution` payloads retain the documented HTTP camelCase fields. Reads are paged with `after`/`limit`. Mutations never retry implicitly: retain their `idempotency_key` when retrying an experiment or result write. HTTP failures expose only status, with no server body, key or content in the error.

`builtin_scorers.exact_match()`, `builtin_scorers.includes(case_sensitive=True)` and `builtin_scorers.json_schema(schema)` return publishable declarations. Exact match preserves JSON types (`False` differs from `0`), object key order is irrelevant, and equivalent JSON numbers compare equally. Missing output/reference produces a skipped score, never zero. `None` is present JSON null; the exported `MISSING` sentinel represents intentional absence.

`define_local_scorer(source=..., entrypoint=..., metrics=..., score=...)` hashes explicitly supplied source text or bytes. The binding must match the pinned language, source digest, entry point and complete metric definition. This is a caller declaration, not independent attestation of closures or installed dependencies. Callbacks receive a private `ScoreContext` copy with `inputs`, optional `output`/`expected`, `has_output`/`has_expected`, `metadata`, and `execution_state`. They return `state` (`scored`, `error`, `skipped`), typed `metrics` and meaningful explanation/evidence. A false quality verdict remains a scored result; invalid callback results and exceptions become typed scorer errors.

Manual and `llm_judge` pins are deferred to their owning service and returned in `report.deferred_scorer_version_ids`. The local runner writes no synthetic skipped result into those slots. Use the explicit judge-job client methods to request hosted execution; submitting jobs can consume the project's configured allowance.

JSON Schema uses pinned `jsonschema` 4.26.0 with Draft 2020-12, a non-fetching registry, no format checker, no coercion/default insertion, and a fresh subprocess that is terminated on timeout. The default timeout is 2 seconds; `schema_timeout_millis` supports 100–60000. Python regular expressions follow Python's regex engine; use portable expressions for comparisons with other runtime implementations. [Official reference resolution documentation](https://python-jsonschema.readthedocs.io/en/stable/referencing/) explains the explicit registry model. Trusted custom target/scorer callbacks have no claimed timeout or cancellation sandbox.

JSON values are bounded to 200 KB, depth 32 and 20,000 nodes; request bodies are at most 1 MiB and responses at most 4 MiB. Invalid Unicode/NUL, non-finite numbers, non-string object keys, cycles and non-JSON objects are rejected before writes. Shared object references are serialized at each occurrence and count toward expansion limits. Python integers outside the JavaScript safe integer range are rejected rather than silently rounded by the API; encode larger exact integers as strings. Connection/read timeouts bound HTTP I/O; the client does not follow redirects.

## Content and durable recovery

`persist_result_content` is required independently of telemetry `capture_content`. When false, HTTP completions and local checkpoints omit raw target output, target exception messages, scorer evidence and arbitrary explanations. Typed metrics and caller-owned identity/configuration/policy metadata remain. Locally computed scores can still be uploaded. Historical scorers skip missing stored output without invoking a local callback. Telemetry content follows the separately chosen helper setting and redactor.

`TraceEvidence("required")` ends the root span, flushes both OTLP signals, records acknowledgement in the checkpoint, then completes the execution. A failed flush leaves the known target outcome saved and raises `TelemetryExportError`. A fresh exporter cannot acknowledge a prior failed export. `TraceEvidence("omit", "reason")` is an explicit policy that omits a copied trace snapshot even if export succeeds; it permits completion when export fails and retains the declared trace identity and reason. There is no automatic fallback or target rerun.

The checkpoint directory has one exclusive owner, mode 0700, atomic fsynced files with mode 0600, integrity digests, and project/run/version/config/content-policy identity. These durability guarantees require a POSIX filesystem supporting private permissions and no-follow opens. A crash leaves `.lock`; verify that its process stopped before explicitly removing it. A lock is never automatically considered stale based on elapsed time.

The runner saves a starting marker before requesting an execution and a running marker before invoking a target. Missing saved outcomes raise `UncertainExecutionError`. A successfully returned but non-serializable output raises `OutcomeSerializationError`; it is not recorded as target failure. Inspect the exposed execution ID and use the explicit client recovery API when necessary. A new uncertain attempt requires both the latest `previous_execution_id` and `allow_uncertain_retry=True`; restarting the runner never grants this permission. An explicit new attempt should use a new checkpoint directory after the previous owner is stopped.

Prepared completion/results and their stable request keys are saved before upload. A dropped acknowledgement can replay the same request without repeating the target or acknowledged scoring. A crash before the prepared checkpoint exists is uncertain; custom scorers may recompute after a crash before their results are saved. The runner stops starting new cases after a failure and lets already-running callbacks finish safely.

`run_experiment` and `rescore` are synchronous entry points with bounded worker concurrency (1–16). Sync and async callbacks are supported inside their workers. From an async application, call the runner through `asyncio.to_thread`.

## Historical rescoring

Create a fresh run with `client.create_evaluation_run(idempotency_key=..., name=..., subject_ids=..., scorer_version_ids=...)`, then call `rescore(client=..., run_id=..., checkpoint_directory=..., persist_result_content=...)`. It reads existing immutable subjects and pins new scorer versions. It has no target callback and never re-executes an agent. Existing scores and execution states remain unchanged.
