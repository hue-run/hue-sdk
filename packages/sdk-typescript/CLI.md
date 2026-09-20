# Hue setup-session CLI contract

Unreleased TypeScript `0.3.1` includes the merged local setup-session CLI core:

```sh
hue setup
hue setup --agent
hue resume
hue status
hue claim # reports account attachment unavailable in this local core
```

These commands belong only to an installer setup session. They do not create or launch a Hue Run,
Scenario, evaluation, or worker. `claim` only means attaching the anonymous setup project to an
account; there is no generic `connect` command or local-agent connection in this CLI.

`setup` only inspects bounded manifest and lockfile metadata. It does not execute repository code,
change project files, open a browser, ask a question, create a trial, or contact Hue. `claim` also
makes no network request in this build and reports that account attachment is unavailable. `resume`
deterministically continues the same setup-session checkpoint; `status` reads it without changing
it.

Checkpoints are secret-free JSON files outside the project, under the operating system's user state
directory. On POSIX, directories use mode `0700` and files use mode `0600`; Windows uses its
per-user local state directory without interpreting POSIX mode bits. Writes are atomic, and a
configured state location inside the project is rejected. Checkpoints contain project categories
and hashes, never environment values, credentials, source contents, or claim URLs.

`--agent` is explicitly noninteractive JSONL. It never uses ANSI, stdin, or a browser, and each
invocation emits exactly one terminal `run.completed` or `run.failed` installer event. Those names
describe the setup-session lifecycle, not a Hue Run. Human output is an append-only inline
transcript. Plain and JSONL output contain no ANSI; `NO_COLOR`, `TERM=dumb`, CI, and non-TTY output
select plain mode automatically.

Every JSONL record carries `contractVersion: 1`. The TypeScript union is exported from
`@hue-run/sdk/setup`; the JSON Schema is exported as
`@hue-run/sdk/setup-events.schema.json`. Consumers must ignore neither unknown versions nor terminal
failures.

The future Fern implementation plugs into `SetupBackendAdapter`. Its three installer operations
create an anonymous setup trial hard-pinned to `trial_metadata_v1`, verify instrumentation-only
receipt evidence, and read account-claim state. Inputs carry deterministic idempotency keys and an
optional abort signal. Adapter results must use bounded, non-secret IDs; claim URLs may be sensitive
and therefore must never be checkpointed. Receipt verification does not prove that task or
environment content was captured and must never authorize Scenario publication. The adapter must
not create a Scenario, evaluation, worker, or Hue Run. No live implementation ships in this slice.

The V1 handoff is deliberately staged: setup verifies the anonymous instrumentation trace; `hue claim`
preserves the project and trace history; then the user performs an explicit content-approved capture
or rerun, with a prepared tester as the first golden path. Only that content-approved trace passes to
the separate review/publication flow for a Scenario. The actual URL and that handoff contract remain
deferred. Setup itself does not capture content, create, publish, or run a Scenario.
