# Versioning and support policy

This policy covers `@hue-run/sdk` (npm) and `hue-run` (PyPI). Both packages are pre-1.0 and are versioned independently.

## Semantic versioning before 1.0

- A `0.MINOR` release (for example `0.2.0`) may change public API, defaults or wire behavior. Every such change is listed under **Breaking** in [CHANGELOG.md](CHANGELOG.md) with a migration note.
- A `0.x.PATCH` release is backwards compatible for the documented public API. It may add APIs and fix bugs. It does not change capture semantics (`captureContent` / `capture_content`), default queue or timeout budgets, or the wire format.
- Only stable `X.Y.Z` versions are published to npm and PyPI. Pilot builds ship as GitHub pre-releases.

## Public API

- TypeScript: the runtime exports and exported types of `@hue-run/sdk`, `@hue-run/sdk/ai-sdk`, `@hue-run/sdk/environment`, `@hue-run/sdk/evals`, `@hue-run/sdk/managed` and `@hue-run/sdk/setup`; the `hue` binary; and `@hue-run/sdk/setup-events.schema.json`.
- Python: the names listed in `hue_sdk.__all__`, `hue_sdk.evals.__all__` and `hue_sdk.managed.__all__`.

Everything else is internal even when importable: Python submodules such as `hue_sdk.client`, `hue_sdk.transport`, `hue_sdk.receipts`, `hue_sdk.processors` and `hue_sdk.snapshots`, any `_`-prefixed module or name, and class members prefixed with `_`. Internal names may change in any release.

## Deprecation

A deprecated public API keeps working for at least two subsequent `0.MINOR` releases. It is listed under **Deprecated** in the changelog when the deprecation starts and under **Removed** when it is removed. Where practical, using a deprecated API emits a one-time runtime warning (a Node.js `DeprecationWarning` or a Python `DeprecationWarning`) that names the replacement.

## Supported runtimes

- Node.js: Hue supports the Node.js release lines that are in Active LTS or Maintenance LTS when a release is cut. A new LTS line is added to CI within 60 days of entering Active LTS; a line is removed from `engines` in the first `0.MINOR` release after its end of life. The tested versions are listed in [COMPATIBILITY.md](COMPATIBILITY.md).
- Bun: the version recorded in CI runs the installed-package behavioral suite. COMPATIBILITY.md states what is and is not verified under Bun.
- Python: each CPython minor version is supported until its upstream end of life plus one Hue `0.MINOR` release. New minor versions are added to CI within 90 days of their final release. `requires-python` in `pyproject.toml` is the authoritative floor.
- OpenTelemetry: the OpenTelemetry package versions the SDKs are built and tested against are recorded in COMPATIBILITY.md and the lockfiles.

## Platforms

Linux is tested in CI. macOS is used for development and is supported. On Windows, the tracing, receipt and managed-target APIs are best-effort. The local evaluation runner (`runExperiment` / `runSimulation` / `runLocalAgent` / `rescore` and `run_experiment` / `rescore`) requires POSIX filesystem semantics for its checkpoint directory and is not supported natively on Windows; use WSL2 or a Linux runner for evaluations. `runSimulation` and `runLocalAgent` are currently TypeScript-only.

## Wire contract

- Transport: OTLP/HTTP for traces and logs (protobuf or JSON encoding, optional gzip) following OpenTelemetry protocol 1.x. Metrics and OTLP/gRPC are not accepted.
- Conventions: Hue helpers emit OpenTelemetry GenAI semantic conventions (currently Development status upstream), including `gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.provider.name`, `gen_ai.conversation.id`, `user.id`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, and opt-in message content carried by the `gen_ai.client.inference.operation.details` log event, whose record attributes repeat `gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.provider.name` and `gen_ai.conversation.id`. Generic spans use `input.value` and `output.value`. The third-party conventions recognized for metadata-only stripping are listed in COMPATIBILITY.md.
- A change to an emitted attribute name, event name or endpoint path is a wire change and is announced as **Breaking**.
- Managed-target requests carry `protocolVersion: 1` and evaluation checkpoints carry `format: 1`. A later 0.x release reads checkpoints written by an earlier 0.x release; a patch release never changes the checkpoint format.
- Installer setup-session JSONL events carry `contractVersion: 1` independently of the package
  version. Their `run.*` names describe command invocations, not Hue Runs. Setup checkpoints carry
  `format: 1`; later 0.x setup implementations either read that format or fail explicitly without
  mutating the project. New event versions use a new schema rather than silently changing version 1.

## Release cadence

Releases are cut from `main` by the [release workflow](RELEASING.md) after the version, changelog and package metadata have been reviewed. There is no fixed cadence; security fixes are released as soon as they are verified (see [SECURITY.md](SECURITY.md)).
