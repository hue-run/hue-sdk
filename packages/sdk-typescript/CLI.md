# Hue setup-session CLI contract

This package includes the local first slice of the claimable anonymous onboarding CLI:

```sh
hue setup
hue setup --agent
hue resume
hue status
hue connect # account attachment; not local-agent connection
```

These commands belong only to an installer setup session. They do not create or launch a Hue Run,
Scenario, evaluation, or worker. `connect` means connect an account for setup; it is unrelated to
connecting a local agent.

`setup` only inspects bounded manifest and lockfile metadata. It does not execute repository code,
change project files, open a browser, ask a question, create a trial, or contact Hue. `connect` also
makes no network request in this build and reports that account attachment is unavailable. `resume`
deterministically continues the same setup-session checkpoint; `status` reads it without changing
it.

Checkpoints are secret-free JSON files outside the project, under the operating system's user state
directory. Directories use mode `0700`, files use mode `0600`, writes are atomic, and a configured
state location inside the project is rejected. They contain project categories and hashes, never
environment values, credentials, source contents, or claim URLs.

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
create an anonymous setup trial, check for a verified telemetry receipt, and read account-claim
state. Inputs carry deterministic idempotency keys and an optional abort signal. Adapter results
must use bounded, non-secret IDs; claim URLs may be sensitive and therefore must never be
checkpointed. It must not create a Scenario, evaluation, worker, or Hue Run. No live implementation
ships in this slice.

After telemetry is verified, the bounded product handoff is: “Open the captured trace in Hue;
review and publish it as a Scenario.” The actual URL and handoff contract are deliberately deferred.
Setup does not create, publish, or run that Scenario.
