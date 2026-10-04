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

# capture_content=False sends metadata only.
with Hue(api_key=os.environ["HUE_API_KEY"], capture_content=True) as hue:
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

`EvaluationClient(api_key=..., timeout_seconds=10, max_attempts=4)` uses the same project service key as telemetry and defaults to `https://app.hue.run`. Set `base_url` to override the origin for another Hue deployment; `EvaluationClient(base_url, api_key)` remains supported. Its methods cover dataset creation/versioning/cases/freezing, scorer creation/publication, experiment creation/start/completion/finish, evaluation runs/subjects/results, and hosted judge job submission/list/get/cancel/budget reads. Python method arguments use snake_case; response dictionaries and `complete_execution` payloads retain the documented HTTP camelCase fields. Reads are paged with `after`/`limit`. A read, or a mutation the server deduplicates by the `idempotencyKey` in its body (experiment creation, start, completion and finish, result and judge-job writes), is sent again after a connection failure, a timeout or a 408 or 5xx without `Retry-After`, up to `max_attempts` (default 4) times with a jittered backoff, so one lost acknowledgement does not surface; `is_transient_api_error` names those failures. A mutation without a key is sent once: retain the `idempotency_key` you would send when retrying an experiment or result write yourself. Whatever the method, a request Hue refused before acting on it with HTTP 429 or 503 and a `Retry-After` of at most 5 seconds is sent again after that wait, up to four times; a longer wait is the caller's error at once, with `retry_after_seconds`. HTTP failures expose only status and Hue's `X-Hue-Diagnostic` code (`diagnostic`), with no server body, key or content in the error.

For new registry code, use `create_eval_set`, `get_eval_set`, `list_eval_sets`,
`create_eval_set_version`, `get_eval_set_version`, `list_eval_set_cases`,
`add_eval_set_case`, and `freeze_eval_set_version`. Evaluators use
`create_evaluator`, `get_evaluator`, `list_evaluators`,
`publish_evaluator_version`, and `get_evaluator_version`. Their dictionaries
include product fields such as `evalSetId` and `evalSetVersionId` alongside the
existing v1 fields. Evaluator versions include `evaluatorId` when the server
supplies their owning identity; older v1 responses may omit it. These methods use the existing
v1 paths; earlier method names remain callable for existing integrations.

For new run and scoring code, use `create_run`, `get_run`, `list_run_items`,
`get_run_case`, `start_run_execution`, `get_run_execution`,
`complete_run_execution`, and `finish_run`. Use `create_scoring`,
`get_scoring`, `list_scorings`, `list_scoring_items`, `get_scoring_subject`,
`submit_scoring_results`, `list_scoring_results`, and `get_scoring_result` to
score saved subjects. `create_run` accepts `eval_set_version_id` and
`evaluator_version_ids`; scoring writes use evaluator version IDs. A run ID and
a scoring ID identify different records. These methods use the existing v1
paths and leave existing runner entry points callable.

Tags group eval sets, evaluators and runs, for example by the area of the agent they test. Methods
take tag names: a name the project has no tag for creates one, and names match without case.
`create_eval_set`, `create_evaluator` and `create_run` (and their v1 counterparts) accept `tags`;
`update_eval_set`, `update_evaluator` and `update_run` replace an item's tags; `list_eval_sets`,
`list_evaluators` and their v1 counterparts filter by `tags`, matching any of them; and
`list_tags()` returns the project's tags. A run also shows its eval set's tags, which run filters
match as well. Tags require a Hue server that supports them.

```python
client.create_eval_set(name="Refunds", slug="refunds", tags=["billing"])
client.update_evaluator(evaluator_id, tags=["billing", "regression"])
billing = client.list_eval_sets(tags=["billing"])
```

`builtin_scorers.exact_match()`, `builtin_scorers.includes(case_sensitive=True)` and `builtin_scorers.json_schema(schema)` return publishable declarations. Exact match preserves JSON types (`False` differs from `0`), object key order is irrelevant, and equivalent JSON numbers compare equally. Missing output/reference produces a skipped score, never zero. `None` is present JSON null; the exported `MISSING` sentinel represents intentional absence.

`define_local_scorer(source=..., entrypoint=..., metrics=..., score=...)` hashes explicitly supplied source text or bytes. The binding must match the pinned language, source digest, entry point and complete metric definition. Each metric may include an optional `description` (1–500 characters) shown with its check in Hue's run view. This is a caller declaration, not independent attestation of closures or installed dependencies. Callbacks receive a private `ScoreContext` copy with `inputs`, optional `output`/`expected`, `has_output`/`has_expected`, `metadata`, and `execution_state`. They return `state` (`scored`, `error`, `skipped`), typed `metrics` and meaningful explanation/evidence. A false quality verdict remains a scored result; invalid callback results and exceptions become typed scorer errors.

Manual and `llm_judge` pins are deferred to their owning service and returned in `report.deferred_scorer_version_ids`. The local runner writes no synthetic skipped result into those slots. Use the explicit judge-job client methods to request hosted execution; submitting jobs can consume the project's configured allowance.

JSON Schema uses pinned `jsonschema` 4.26.0 with Draft 2020-12, a non-fetching registry, no format checker, no coercion/default insertion, and a fresh subprocess that is terminated on timeout. The default timeout is 2 seconds; `schema_timeout_millis` supports 100–60000. Python regular expressions follow Python's regex engine; use portable expressions for comparisons with other runtime implementations. [Official reference resolution documentation](https://python-jsonschema.readthedocs.io/en/stable/referencing/) explains the explicit registry model. Trusted custom target/scorer callbacks have no claimed timeout or cancellation sandbox.

JSON values are bounded to 200 KB, depth 32 and 20,000 nodes; request bodies are at most 1 MiB and responses at most 4 MiB. Invalid Unicode/NUL, non-finite numbers, non-string object keys, cycles and non-JSON objects are rejected before writes. Shared object references are serialized at each occurrence and count toward expansion limits. Python integers outside the JavaScript safe integer range are rejected rather than silently rounded by the API; encode larger exact integers as strings. Connection/read timeouts bound HTTP I/O; the client does not follow redirects.

## Content and durable recovery

`persist_result_content` is required independently of telemetry `capture_content`. When false, HTTP completions and local checkpoints omit raw target output, target exception messages, scorer evidence and arbitrary explanations. Typed metrics and caller-owned identity/configuration/policy metadata remain. Locally computed scores can still be uploaded. Historical scorers skip missing stored output without invoking a local callback. Telemetry content follows the separately chosen helper setting and redactor.

`TraceEvidence("required")` ends the root span, flushes both OTLP signals, records acknowledgement in the checkpoint, then completes the execution. The client is shared by every case in flight, so each export failure names the traces of the records it concerned (`Hue.export_issues()`): a failure naming the case's trace marks the saved outcome `failed` and raises `TelemetryExportError`, final because its evidence is incomplete; one naming only other cases' traces leaves it accepted; one naming no trace, or a flush that did not succeed without a new failure, is decided by the case's trace receipt, which must hold the case's root span and at least as many spans as the case ended. A saved outcome still `pending` is decided by its receipt again on resume; one marked `failed`, or one the receipt does not hold, is refused as itself. One case's telemetry failure no longer fails the cases running beside it. A fresh exporter cannot acknowledge a prior failed export. `TraceEvidence("omit", "reason")` is an explicit policy that omits a copied trace snapshot even if export succeeds; it permits completion when export fails and retains the declared trace identity and reason. There is no automatic fallback or target rerun.

The checkpoint directory has one exclusive owner, mode 0700, atomic fsynced files with mode 0600, integrity digests, and project/run/version/config/content-policy identity. These durability guarantees require a POSIX filesystem supporting private permissions and no-follow opens. A crash leaves `.lock`; verify that its process stopped before explicitly removing it. A lock is never automatically considered stale based on elapsed time.

The runner saves a starting marker before requesting an execution and a running marker before invoking a target. Missing saved outcomes raise `UncertainExecutionError`. An output beyond what Hue stores for one case (200,000 bytes of JSON, 20,000 values or 32 levels of nesting) is that case's own failure: it completes as `error` with the error type `OutputTooLarge` (and, when result content is persisted, a message naming the bound), no output is stored and the other cases keep running. A successfully returned output that is not JSON raises `OutcomeSerializationError`; it is not recorded as target failure. The output is checked as it is read (object keys are not values), and the first value that is not JSON or past the value or depth bound decides which; the byte bound is checked last, so an output past it that also holds a value that is not JSON raises `OutcomeSerializationError`, and one too large to serialize, or to hold in memory, is refused as `OutputTooLarge` too. Inspect the exposed execution ID and use the explicit client recovery API when necessary. A new uncertain attempt requires both the latest `previous_execution_id` and `allow_uncertain_retry=True`; restarting the runner never grants this permission. An explicit new attempt should use a new checkpoint directory after the previous owner is stopped.

Prepared completion/results and their stable request keys are saved before upload. A dropped acknowledgement can replay the same request without repeating the target or acknowledged scoring. A crash before the prepared checkpoint exists is uncertain; custom scorers may recompute after a crash before their results are saved. The runner stops starting new cases after a failure and lets already-running callbacks finish safely.

`run_experiment` and `rescore` are synchronous entry points with bounded worker concurrency (1–64). Sync and async callbacks are supported inside their workers. From an async application, call the runner through `asyncio.to_thread`.

## Historical rescoring

Create a fresh run with `client.create_evaluation_run(idempotency_key=..., name=..., subject_ids=..., scorer_version_ids=...)`, then call `rescore(client=..., run_id=..., checkpoint_directory=..., persist_result_content=...)`. It reads existing immutable subjects and pins new scorer versions. It has no target callback and never re-executes an agent. Existing scores and execution states remain unchanged.
