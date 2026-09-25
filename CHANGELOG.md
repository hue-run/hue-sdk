# Changelog

Both packages follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the pre-1.0 rules in
[VERSIONING.md](./VERSIONING.md): a `0.MINOR` release may contain **Breaking** entries with migration
notes; a patch release adds or fixes without changing capture semantics, default budgets or the wire
format. Entries marked **Wire** change emitted attributes, events or endpoints. The release workflow
refuses to publish a version without a matching entry below.

## @hue-run/sdk (TypeScript)

### Unreleased

#### Added

- `normalizeScorerDefinitionForPublication` and the `ScorerDefinition` type know every
  Hue-executed `world_outcome` entry: `hue.conversion_outcome.v2`,
  `hue.outcome_assertions.v2` and `hue.outcome_assertions.v3`, whose version pins its judge in
  `config.judge` (new `OutcomeJudgeConfig` type). Each entry's metrics are fixed by the entry and
  filled in when omitted; the local runner defers all of them to Hue, as it does v1.

#### Fixed

- A target output over what Hue stores for one case (200,000 bytes of JSON, 20,000 values or 32
  levels of nesting) no longer stops the whole run with `OutcomeSerializationError`: that case
  completes as `error` with the type `OutputTooLarge` and, when result content is persisted, a
  message naming the bound, and the other cases keep running. Output within the bounds that is not
  JSON still raises `OutcomeSerializationError`.
- A large inline file whose `data:` URL has a pathological number of `;` parameters is hashed as
  the bytes its own encoding gives. The header was read with a pattern repeated per parameter,
  which throws on Node (from about 3.4 million), leaving the message unhashed, or stops matching
  on Bun (from about 1.1 million), hashing the URL's text. The Python SDK reads the header the
  same way.

### [0.10.0] - 2026-09-25

This release changes a default of the `hue` binary (see Breaking), so it is a `0.MINOR` release.

#### Breaking

- One-shot `hue eval` stores each case's output, error message and explanations in Hue by default,
  as `--worker` already did, so answer checks can grade the output and the run page shows it.
  Everything the command prints on stdout is its answer and is stored, so an agent must not print
  credentials or debug logs there. Before storing, `hue eval` replaces with `[redacted]` the
  credentials it handed the case (the world token and MCP headers, a legacy MCP token, attempt
  bearers) and every Hue control-plane credential in its environment, in the answer, in an
  adapter's thrown message and in the checkpoint. `--content` now governs only telemetry content
  capture, which stays off by default. `--no-output` keeps outputs, error messages and
  explanations out of a one-shot run's stored results (with `--content`, the case span still
  carries the output); `--worker` refuses it. Migration: pass `--no-output` to keep the previous
  default. An interrupted one-shot run keeps the choice it started with, so resume one started
  without `--content` by an earlier version with `--no-output`; a rerun with other flags is refused
  with a message naming the flags the run started with.

#### Added

- `traceNotAccepted: "fail_case"` for `runExperiment`, `runSimulation` and `runLocalAgent`: a case
  whose required telemetry Hue did not accept is completed as failed (error `TelemetryNotAccepted`,
  evidence omitted with a reason starting `telemetry_not_accepted`, no output or generated files
  attached) instead of being left started, reported to the new `onTelemetryNotAccepted(entry)` as it
  completes and listed in the new `RunnerReport.telemetryNotAccepted` with sanitized issue counts.
  The default, `"stop"`, keeps the previous behavior. Exported types `TelemetryNotAccepted` and
  `TelemetryIssueCount`.
- Cases pinned to a world can carry input files. `runSimulation` and `runLocalAgent` download
  the case's agent-visible files before its execution starts, verify each one's size and SHA-256
  against the case manifest and hand the verified copies to the environment callback as
  `context.files`, beside the world, with a private `context.outputDirectory`. Evaluator-only
  files (`org_template`, `evaluator_reference`) never reach the agent. The callback may return
  `withFiles(output, files)`: the files are uploaded and linked to the execution as `artifactIds`
  and `primaryArtifactId`, within the limits of direct cases. The world token is never written
  to the case directory, which is removed when the case ends; only staged outputs an interrupted
  upload resumes from are kept until it does.
- `localAgentCapabilities.environmentFiles` (`environment-files:v1`). A worker that declares it,
  with `input:<extension>` for each file type it accepts, is offered world cases whose manifest
  holds agent-visible files; it requires `target`. The worker never adds it to a registration
  itself, so existing registrations keep their capabilities.
- `CaseFileError`, with the stable `code` `case_file_mismatch` when a downloaded pinned file
  differs from the manifest's size or SHA-256, and `case_file_name_refused` when a file for an
  agent in a world is not one safe file name (a path separator, `.` or `..`, a C0 or C1 control
  character, a character Windows reserves such as `:` or `?`, a Windows device name such as
  `CON`, a trailing dot or space, or more than 200 bytes). Both are raised before the case's
  execution starts, so no execution or world is spent on it.
- `EvaluationClient.downloadArtifact(id, { maxBytes })` stops one byte past `maxBytes` and throws
  the new `ArtifactSizeError`. Pinned downloads pass the manifest's size, so a longer body is a
  `case_file_mismatch` without reading the rest.
- `hue eval` hands a world case's files to the agent: an adapter receives `context.files` and
  `context.outputDirectory` and may return `withFiles`, and a `--command` also gets
  `HUE_CASE_DIR`, `HUE_CASE_INPUTS` and `HUE_CASE_OUTPUT_DIR` with the direct-case layout; every
  file it leaves in `output/` is uploaded. `--worker` registers each repeated
  `--capability <value>`, such as `environment-files:v1` and `input:pdf`, beside `environment:v1`.
- Evaluators that do not apply to a case. `StoredResult.notApplicable` is true for a skipped result
  Hue's own outcome scoring records because the case has no outcome criteria or conversion rubric
  to grade; `waitForResults` carries it, with what the evaluator needs, as
  `VerdictResult.notApplicable` and `requires`. `summarizeVerdicts` decides a case by the
  evaluators that apply to it, lists the others in the new `CaseVerdict.notApplicable` and counts
  them in `totals.notApplicable`, and makes a case no pinned evaluator applies to an error that
  names what they need. `hue eval` shows `n/a` in such a case's columns, counts the
  not-applicable results in its pass line and `--json`, and exits 0 when every case passed the
  evaluators that apply to it. Before, such a result was an ordinary skip: its columns showed `-`,
  its explanation was printed with a failing case's own, and a case no pinned evaluator applied to
  was reported as skipped. Only Hue's flag on a skipped result marks it not applicable: a scored
  or errored result keeps its verdict whatever flag it carries, and a skip without the flag, such
  as one for an incomplete environment, is still a skip.

- Provider tool spans from `recordProviderToolCalls` carry `hue.tool.call.position`, the 0-based
  position of the call's item in the provider response (the OpenAI `output` index or the Anthropic
  `content` block index), in both capture modes, so calls from one response that share a start
  time keep their order. **Wire**
- A `tools/list` span from `recordProviderToolCalls` with `captureContent: false` carries
  `hue.tool.names` and `hue.tool.definitions.sha256`, the same metadata-only summary export gives
  any record's tool definitions; before, it carried neither. Descriptions and schemas are still
  exported only with content capture. **Wire**
- With `captureContent: true`, a failed OpenAI MCP call's span has the provider's error text as
  its ERROR status description, credentials scrubbed and cut to 1,024 characters. Scrubbing drops
  an `http(s)`, `ws(s)` or `ftp` URL's userinfo and fragment and replaces its query values (quoted
  ones included) with `[redacted]`, replaces a URL with any other scheme whole when it has an `@`,
  `?` or `#`, and replaces a token with a known credential prefix (Hue's `hue_sk_`, `hue_mcp_`,
  `hue_world_` and `hue_attempt_`, and `sk-`, Stripe, Slack, Google OAuth, GitHub and GitLab
  tokens), the credential after `Bearer`, `Basic` or `Token`, an `Authorization` header's whole
  value and the value of a credential-named `key=value` or `key: value` pair (quoted, with
  backslash-escaped quotes as in JSON inside a string, or bare, and a pair inside another pair's
  value). The `redact` hook sees the text as `status.message`. Without content capture the span
  keeps `error.type` only. **Wire**

#### Changed

- A downloaded pinned file that differs from its manifest now raises `CaseFileError`
  (`case_file_mismatch`) instead of a plain `Error`, for direct cases and `rescore` too.
- Evaluator-only files for a local code evaluator are still checked before the execution starts,
  but saved only after the target finished, just before scoring, apart from the agent's copies, so
  they are not on disk while the agent runs. They are downloaded twice as a result. Before, they
  were saved with the agent's files before the execution started.
- A generated file declared by `path` is read once as a regular file, its size checked before
  reading, and staged owner-only (0600) from those bytes; a symlink, FIFO or device is the
  target's error. Before, it was read whole, then copied with its own mode.
- `safeFilename` keeps at most 200 UTF-8 bytes instead of 200 characters, so a long multibyte
  name no longer fails with the operating system's name-length error. A longer name keeps its
  extension (`.pdf` stays `.pdf`) and its shortened stem ends in `~` and 8 hex digits of the whole
  name's SHA-256, so two long names stay distinct.
- A files directory must be owned by the current user and closed to everyone else (mode 0700).
- `hue eval` stops whatever a command left running in its process group (SIGTERM, then SIGKILL
  after 5 seconds) before reading its answer and files. A forced exit (a second Ctrl+C) also
  removes the world case's files and the checkpoint locks, so a rerun is not refused on a stale
  lock.

#### Security

- `hue eval` collects a command's `output/` without following the agent's links. The output
  directory must be a real directory and a helper (`manifest.json`, `result.json`, `summary.txt`,
  …) a regular file; every file is opened without following a final symlink or blocking on a
  FIFO, must be the file the listing saw and within its limit (checked before reading), and is
  uploaded from the bytes read. Before, a helper or an output directory linked to a host path
  sent that host file to Hue, a file swapped for a link after the listing could be uploaded, and
  a FIFO named like a helper hung the CLI. The listing also stops past 32 documents or 1024
  entries, and an entry that vanishes or changes while it is collected fails the case with a
  plain "changed while it was collected" error. This applies to direct cases and world cases
  alike.
- Input copies in a direct case directory whose names differ only in case or Unicode
  normalization no longer overwrite each other on case-insensitive or normalizing filesystems.

#### Fixed

- **Wire.** A large inline file part in a recorded message is exported with the `sha256` and
  `size` of the file's own bytes whatever its media type. Base64 content is decoded for text,
  JSON and untyped parts too, and a `data:` URL without `;base64` is percent-decoded. Before,
  those were hashed as the UTF-8 of their base64 or URL text, so the digest did not match the
  file's bytes, and a text file sent as base64 could not be linked to its upload. Behavior change:
  content made only of base64 characters and padded to a multiple of four is now read as base64
  even under a text media type, as Hue reads it, so such a text (`AAAA…`, for example) is hashed
  as the bytes it decodes to and stays inline while those fit in 64 KiB. A text file's own text
  is still hashed as UTF-8. The Python SDK follows the same rule, checked against a shared fixture.
- An OpenAI `mcp_list_tools` tool's null `description`, `input_schema` or `annotations` is left
  out of its `tools/list` definition, as the Python SDK leaves it out, so both SDKs record the
  same definitions and give a catalog the same digest.
- `recordProviderToolCalls` no longer drops a whole response when one item's `type` (or any field)
  throws when read: the item is skipped and counted, and the other calls are recorded, as the
  Python SDK does.
- `hue eval` completes a case whose telemetry Hue did not accept as failed with
  `telemetry_not_accepted`, prints the export issue counts for it as it completes (and adds them to
  the case's `--json` entry), counts it as an error whatever its scores, exits 1 and goes on with
  the run. Before, the run stopped with "Hue could not accept all
  telemetry. Inspect issues and report for sanitized counts.", pointing at a report the CLI never
  printed, and the case's execution stayed started. Other export errors now print their counts
  too.
- `hue eval` treats a second SIGINT within 50 ms as the same Ctrl+C, since `npm run` and `npx`
  forward the terminal's own a moment later; before, a single Ctrl+C under them took the forced
  path. A forced exit now also removes the owner-only MCP configuration that holds the world
  token, a failure to signal an agent's process group is reported once rather than on every
  poll, and an interrupt that lands before a command starts stops it at once.

- The seal wait of `runSimulation`, `runLocalAgent` and `runEnvironmentTarget` honors a status
  read's `Retry-After` when a 429 or 503 outlasts the client's retries: it waits at least that
  long, capped at the time left, instead of polling again after 250 ms.
- A large inline file in a recorded message no longer drops its span. Inline files longer than
  64 KiB are replaced by their `sha256` and `size` when the record is queued, before its bytes are
  charged to the queue budget, as Python does; before, the full file was charged first, so under
  the default 8 MiB `maxQueueBytes` a span inlining a file over about 3 MiB was dropped. A message
  attribute longer than 8 MiB is still left to the budget. The same text is hashed once per record,
  a record inspects at most 16 MiB of message text, and with `captureContent: false` the messages
  export removes are neither hashed nor charged.
- `hue eval` stops a timed-out or cancelled `--command` by signalling its whole process group even
  after the shell has exited, then kills whatever is left after the 5-second grace, and settles the
  case only once the group is gone; a group found empty is never signalled again. Before, an agent
  started by a compound command (`a; b`, `a | b`) that ignored SIGTERM kept running, with its world
  credentials, after the case failed. A second Ctrl+C during the grace now kills the agent's group
  at once and exits with 130 instead of ending the CLI and leaving the agent running.
- `hue eval` replaces an adapter error whose message cannot be reassigned (a frozen error, or one
  whose `message` is a getter) with a new `Error` carrying the redacted message and name, instead
  of storing the unredacted message. An error's name, which the case span exports as its error
  type, is redacted the same way as its message. Values shorter than 16 characters are no longer
  treated as credentials, so a short environment value no longer redacts ordinary text in the
  answer.
- `hue eval` also replaces the credentials it redacts from the answer in the UTF-8 `.txt`, `.csv`
  and `.json` documents it collects from `output/`, and in every generated file's name, before
  uploading them; a name that redaction makes equal to another file's gains `-2`, `-3`, … before
  its extension, so both are still uploaded. PDF, Office and image documents and files an adapter
  returns by `path` are uploaded as written, so an agent must still never write credentials to
  `output/`.
- `hue eval --case` and `resolveScenarioPins` accept the published eval set case's own ID, the one
  Hue shows on the case page, and URLs naming `/cases/<id>` or `/case-conversions/<id>`. Before,
  only the case conversion's ID or a `/scenarios/<id>` URL resolved, and the case's own ID failed
  with HTTP 404. A case ID is looked up among the first 1,000 Scenarios listed, and a listing that
  repeats a cursor ends the lookup, or a name search, instead of paging forever.
- `EvaluationClient.registerLocalAgent` reads the registered key from the response's `agentKey`
  when it has no `key`, so `RegisteredLocalAgent.key` is set and `hue eval --worker` no longer
  prints "Registered agent undefined".
- `EvaluationClient` sends a request again, up to four times, when Hue refused it before acting on
  it with a short `Retry-After` (HTTP 429 or 503 asking for at most 5 seconds), and waits at least
  that long first. Hue does this when its key check is busy, which parallel cases can trigger; such
  a request previously failed the run. A refusal that asks for longer or gives a date, a timeout and
  any other failure still fail at once, so a write whose outcome is uncertain is never sent twice.
  A refused `downloadArtifact` is fetched again the same way and still stops at `maxBytes`.
- The retry jitter in `EvaluationClient` is written as `Math.random() * 0.5` instead of a bare
  division, so the release workflow's inspection of the built archive, which refuses ambiguous
  `/` syntax, accepts the package. The waits are unchanged. CI now runs that inspection on every
  change.

### [0.9.0] - 2026-09-24

#### Breaking

- `GmailProviderInstance.configuration` is now `GmailMailboxConfiguration`, a union discriminated
  by `kind`, instead of the `gmail_mailbox/v1` object alone. The change is type-only, with no
  runtime or wire effect, but code that assigns a read-back `configuration`, or its `kind`, to the
  old `gmail_mailbox/v1` type, or that checks `kind` exhaustively, no longer compiles. Migration:
  narrow on `configuration.kind` before treating a value as `GmailMailboxConfigurationV1` (the
  exported name of the old shape), and handle `gmail_mailbox/v2` in exhaustive checks.

#### Added

- `HueEnvironmentError.diagnostic` exposes a validated `X-Hue-Diagnostic` code from World API
  refusals. This is new after TypeScript 0.8.1, which does not include it.
- `gmail_mailbox/v2` Gmail provider instances. `GmailMailboxConfigurationV2` adds
  `labelsCollection`, so `publishVersion` and `runSimulation` author worlds on that carrier
  without a cast and `getVersion` reads `labelsCollection` back. `GmailMailboxConfiguration`,
  `GmailMailboxConfigurationV1` and `GmailMailboxConfigurationV2` are exported from
  `@hue-run/sdk/environment`. Hue accepts that carrier only with the synthetic mailbox address
  `owner@example.test`, and a definition whose provider instances all use it may publish with no
  actions.
- `runSimulation`, `runLocalAgent` and `runEnvironmentTarget` wait up to about 40 seconds for a
  gateway world to seal after its completion grace before the execution completes.
- `isTransientEnvironmentError` classifies retryable World API failures for bounded polling.

#### Changed

- `resolveScenarioPins`, and so `hue eval --case`, pin every scorer version a published Scenario
  lists in `publication.scorerVersionIds` (its outcome scorer first), falling back to the single
  `scorerVersionId` of older publications; extra `--scorer` pins still merge in.
  `CaseConversionPublication` gains the optional `scorerVersionIds`.

#### Fixed

- The hosted-tool recorder resolves `servers` entries with own-property lookup, so labels such as
  `constructor` keep their server name instead of inheriting from `Object.prototype`.
- Truncated provider responses count only provider tool calls toward instrumentation failures, so
  harmless message and reasoning tails no longer make strict `flush()` throw.

### [0.8.1] - 2026-09-24

#### Added

- **Wire.** `hue.recordFile(file, explicitContext?)` adds a `hue.file` event to the active span:
  `hue.file.sha256`, `hue.file.role` (`input`, `attachment` or `output`), `hue.file.media_type`,
  `hue.file.size` when known and, only when content is captured, `hue.file.name`. File bytes are
  hashed locally and never exported; the event is recorded in both capture modes. Exported type
  `FileRecord`.
- **Wire.** `hue.recordProviderToolCalls(response, { provider?, request?, servers?, parentContext? })`
  records OpenAI Responses `mcp_call`, `web_search_call`, `file_search_call` and
  `code_interpreter_call` items and Anthropic `mcp_tool_use` / `server_tool_use` blocks as
  `execute_tool` child spans with `gen_ai.tool.type` `extension`, `mcp.server.name` and, with
  `request`, `server.address`. Arguments and results are content. An OpenAI `mcp_list_tools` item
  becomes a `tools/list` span carrying that server's `gen_ai.tool.definitions`. Exported types
  `ProviderToolCallOptions`, `HostedServerInfo` and `HostedToolProvider`.
- **Wire.** `model()` accepts `systemInstructions` and `tools`, recorded as
  `gen_ai.system_instructions` and `gen_ai.tool.definitions` when content is captured;
  `recordMessages({ systemInstructions })` adds the instructions to the inference log body.
- **Wire.** `SpanOptions.workspaceId` (also on `model()`) records `hue.workspace.id`, inherited by
  nested helper spans and the AI SDK adapters like `userId`.
- **Wire.** `hue.tool(..., { mcp })` accepts `provider` and `surface`, recorded as
  `hue.mcp.provider` and `hue.mcp.surface`; `bindEnvironmentTools` passes a catalog entry's values.
- **Wire.** Metadata-only export that removes tool definitions leaves `hue.tool.names` and
  `hue.tool.definitions.sha256` (RFC 8785 canonical JSON of the credential-scrubbed definitions) on
  the same record.
- **Wire.** AI SDK 7 provider-executed (`extension`) MCP tool spans get `mcp.server.name` from the
  recorded `serverLabel`, and an MCP `error` in the result sets ERROR status and
  `error.type: mcp_error`. Both survive metadata-only export.
- `hue login --env-path <path>` and `hue eval --env-path <path>` name the env file like
  `--env-file`.

#### Changed

- Correction: multi-pin `resolveScenarioPins` (`publication.scorerVersionIds`) shipped after 0.8.1; it is documented under 0.9.0.
- `hue eval` names a run `<agent key> @ <revision>` when `--name` is not passed (commit hashes
  shortened to 7 characters); the eval set is already shown on the run page. Previously the name
  repeated the eval set name in a `·`-separated string.

#### Fixed

- **Wire.** Hosted-tool credentials in exported tool definitions (`authorization`,
  `authorization_token`, `headers`, `api_key`, `access_token`, `x-api-key`) are replaced with
  `"[redacted]"` before `redact` runs, in `gen_ai.tool.definitions`, `ai.prompt.tools`,
  `llm.tools.*.tool.json_schema` and the `tools` / `mcp_servers` entries of recorded raw requests
  and responses. Schema parameters with those names are kept.
- **Wire.** A `blob` or `file` part over 64 KiB in `gen_ai.input.messages`,
  `gen_ai.output.messages` or `ai.prompt.messages` is exported without its payload, with `sha256`
  and `size` instead, so a span that inlines a large file is no longer rejected at export. The
  digest matches `hue.file.sha256` for the same bytes.
- `hue login --env-path <path>` creates a new env file. With `--env-file`, Node 22 and 24 exit with
  `node: <path>: not found` before `hue` runs when the file does not exist yet, because Node reads
  `--env-file` from the whole command line. `--env-file` still works for an existing file.

### [0.8.0] - 2026-09-24

#### Added

- **World API handoff.** `createRun` accepts `traceparent` and `agentRevision`, and its response
  carries the world's `token`, `surfaces`, `env` and `mcpConfig` where Hue's simulation gateway
  serves the world. `worldHandoff`, `agentEnvironment`, `stripHueControlPlaneCredentials`,
  `legacyMcpCapability` and `writeMcpConfig` in `@hue-run/sdk/environment` build an agent child's
  configuration from it without the project key; `getEvidence` reads a sealed world's
  evaluator-only evidence; `HueEnvironmentError` carries `retryAfterMs` and the client waits
  Hue's `Retry-After` on 429 and 503. `runSimulation`, `runLocalAgent` and `runEnvironmentTarget`
  create the world with the case span's context and the agent revision (`agentRevision` on
  `runSimulation`), pass `context.world`, and finish before completing. `hue eval --command`
  hands the child the world's environment and an owner-only `HUE_MCP_CONFIG` file, removes
  `HUE_API_KEY` and other Hue control-plane credentials from it unless `--allow-hue-credentials`
  is passed, and sends `--revision` as the agent revision.

#### Changed

- `SimulationTargetContext.mcp`, `LocalAgentTargetContext.mcp` and `EnvironmentTargetContext.mcp`
  are optional: for a gateway world they hold the first MCP mirror with the world token; for a
  world created while the gateway is off they still hold the `hue_sim_` capability, now with a
  one-time `DeprecationWarning` (`HUE_NATIVE_SIMULATION_TOOLS`; the provider facade warns
  `HUE_PROVIDER_FACADE`). `SealedRun.sealedAt` is null while a gateway world is `completing`.
- `runExperiment()`, simulations and `hue eval --concurrency` accept up to 64 cases in flight
  (was 16). The default stays 1.

### [0.7.0] - 2026-09-23

#### Breaking

- Live spans are on by default: while a span from Hue's own helpers, the AI SDK adapter or a
  recognized AI instrumentation is still running, the transport also exports a placeholder for
  it (see Added). A Hue deployment that accepts placeholders answers with `Hue-Pending-Spans: 1`;
  if a receiver without that header gets placeholders, their rejections are credited to them, one
  `warning` issue is recorded and live spans switch off for that client. Placeholders may use up
  to a quarter of the export queue, and placeholder warnings carry a nonzero `count`.
  Migration: set `liveSpans: false` for the previous wire behavior. A wrapping processor that
  forwards `onStart` but scrubs, renames or drops spans in `onEnd` does not change their
  placeholders; scrub with `redact`, do not forward `onStart` for spans you filter, or set
  `liveSpans: false`. **Wire**
- A finished span no longer carries `hue.span_type` or `hue.pending_parent_id` attributes set by
  the application; Hue reserves them for placeholders. Migration: rename application attributes
  that use those keys. **Wire**

#### Added

- **Live spans.** A placeholder lets Hue show a trace, its request and its running model and tool
  calls before they finish. It is an ordinary OTLP span that names the running span as its
  parent, ends at 0 and carries `hue.span_type = "pending_span"` and `hue.pending_parent_id`;
  markers are added after redaction, and the content policy applies as for finished spans. A
  placeholder is queued at the transport's next 500 ms tick and sent with the next batch export
  (1 s batch delay), so it usually reaches Hue within about 1.5 s of its span starting: sooner when
  a batch is already scheduled, later while an earlier export is still in flight. A placeholder
  whose span has ended by export time is not sent, so a short span may send none. A request
  carrying only placeholders never fails `flush()`. **Wire**
- `liveSpans` option (default `true`; always off for setup credentials).


### [0.6.0] - 2026-09-23

#### Added

- Product-named eval set, evaluator, run and scoring methods on `EvaluationClient`, using the
  existing v1 paths. Responses retain both field names, and a run ID remains distinct from its
  scoring ID. Existing client methods and local runners remain callable.
- `hue eval --case` selects a published case by name, ID or URL; `--scenario` remains an alias for
  existing scripts.

#### Deprecated

- Older low-level evaluation client method names and the `--scenario` CLI flag now have product
  replacements. They remain supported for at least two subsequent `0.MINOR` releases. The v1
  response aliases remain available while the server compatibility window is open.

### [0.5.1] - 2026-09-23

#### Changed

- `hue login` asks for one **Read and write** key and stores it as both `HUE_API_KEY` and
  `HUE_MCP_KEY` (with `HUE_BASE_URL` and `HUE_MCP_URL`) in a single write. It checks evaluation
  access with `GET /api/v1/datasets`, so a **Read** or **Tracing only** key is refused before
  anything is stored instead of failing later in `hue eval`. `--keys evaluations` and
  `--keys coding-agent` still store one variable each; `--keys coding-agent` accepts a **Read**
  key.
- `hue login`, `hue eval`, the evaluation guides and the Hue skill name Hue's consolidated access
  presets: **Read and write** replaces **Tracing and evaluations** and **Coding agent (read +
  evaluations)**, and **Read** replaces **Coding agent (read-only)**. **Tracing only** is unchanged.
  Existing keys keep their access; only the names printed in prompts and errors change.

### [0.5.0] - 2026-09-22

#### Added

- `hue eval` runs document eval sets as **direct** cases: when the saved version's cases pin no
  simulated world (or with `--mode direct`), it creates one experiment through `runExperiment()`,
  hands each case's agent-visible pinned files to the agent and uploads the documents it produces.
  `--command` is spawned inside a private case directory with `HUE_CASE_DIR`, `HUE_CASE_INPUTS`,
  `HUE_CASE_OUTPUT_DIR`, `HUE_CASE_ID`, `HUE_CASE_KEY` and `HUE_EXECUTION_ID`; every file written
  to `output/` is uploaded (`manifest.json`, `result.json` and `summary.txt` are optional helpers).
  Adapter files receive a `DirectTargetContext` (`mode: "direct"`) and may return `withFiles(...)`.
  Code evaluators pinned to the run are left to Hue's grading executor (`deferUnboundLocalScorers`)
  and the verdict wait covers them; `--json` reports `mode` and `deferredScorerVersionIds`.
  `--set` also matches an eval set's slug, `--set-version <n>` pins a saved version and
  `--scorer <slug|name|id>` pins an evaluator at its newest published version.
- `runExperiment()` and `rescore()` accept `deferUnboundLocalScorers`: a pinned `local_code`
  version with no local binding is reported in `deferredScorerVersionIds` instead of refusing the
  run, so a customer process can upload outputs while a Hue-operated worker grades them, and a
  grading worker bound to one evaluator leaves other evaluators' pins alone. Scorer-only pinned
  files are downloaded only when a bound code evaluator runs in the process.
- `EvaluationClient.listEvaluationRuns()` pages the project's evaluation runs; `CaseFile.role`
  gains `evaluator_reference`, a scorer-only role for customer material an evaluator compares
  against. **Wire**
- `hue eval` runs a local adapter file or shell command against a published Scenario or a saved
  eval set through `runSimulation()`, or as an outbound worker through `runLocalAgent()`. It
  resolves Scenarios by name, ID or URL, creates a fresh experiment from the published pins, prints
  the run URL and per-case PASS/FAIL verdicts once Hue's outcome checks finish, compares against a
  `--baseline` experiment, emits `--json`, and exits 0, 1, 2 or 130. `HUE_API_KEY` must be a
  Tracing and evaluations key and is never printed; content capture stays off unless `--content`
  is passed, and in one-shot mode so does persisting case outputs and explanations (`--worker`
  keeps `runLocalAgent()`'s existing behavior of persisting them). A timed-out or interrupted
  `--command` agent is stopped by process group and then SIGKILL, and an interrupt during the
  verdict wait exits 130. Existing `setup`, `resume`, `status` and `claim` behavior and the
  JSONL event contract are unchanged.
- `runSimulation()` accepts `scenario: { kind: "pins", datasetVersionId, scorerVersionIds, config?, name? }`
  for already published immutable pins; the checkpoint identity binds those pins.
- `@hue-run/sdk/evals` exports `listScenarios`, `getScenario`, `resolveScenarioPins`,
  `resolveEvalSetPins`, `parseScenarioSelector` and `matchByName`, the `EvaluationClient` methods
  `listCaseConversions` and `getCaseConversion`, and the verdict helpers `waitForResults`,
  `summarizeVerdicts`, `compareVerdicts`, `collectExperimentVerdicts` and `metricPassed`, with
  their types.
- The portable skill gains an "Evaluate against a Scenario" section describing the `hue eval` loop
  for coding agents.
- `hue login` validates and stores keys created in Hue Settings > Integrations & API keys. The
  "Tracing and evaluations" key is checked with `GET /api/v1/projects/current` and stored as
  `HUE_API_KEY` with `HUE_BASE_URL`; the "Coding agent (read + evaluations)" key is checked with an
  MCP `tools/list` request and stored as `HUE_MCP_KEY` with `HUE_MCP_URL`. Keys are read without
  echo and never printed; `.env.hue` is written with mode `0600` through an atomic rename, symlinks
  are refused, `--force` replaces a different existing value and `--gitignore` adds the file to
  `.gitignore`. A run that stops after storing one key still applies that protection, and the
  printed next step carries `--url` for a non-default origin. The command never mints a key.
- `hue mcp install --client <claude-code|cursor|codex|vscode|windsurf|gemini>` writes, runs or
  prints Hue's canonical MCP client configuration for `https://mcp.hue.run/mcp` (`--url` selects
  another endpoint). The configuration references the `HUE_MCP_KEY` environment variable or a VS
  Code password input, never a key value; JSON files are merged so other servers are preserved,
  `--dry-run` previews the result and `--print` shows the snippet.
- `runExperiment()` runs file-based cases. Before an execution exists it downloads every pinned
  `inputFiles` entry of the frozen case, verifies its byte count and SHA-256, and passes the
  agent-visible roles (`source`, `attached_template`, `attached_reference`, `original`) as
  `context.files` with a private per-case `context.outputDirectory`. A download failure is an SDK
  failure that consumes no execution slot; evaluator-only `org_template` files reach scorers but not
  the target. **Wire**
- Targets return `withFiles(output, files)`, a `TargetResult`, to save generated documents. The
  runner stages each declared `path` or in-memory `bytes`, publishes them through artifact
  reservation, upload and verified completion with stable per-execution keys, and completes the
  execution with `artifactIds` and `primaryArtifactId`. Generated files are uploaded regardless of
  `persistResultContent`. A file that cannot be read, exceeds 25 MiB, repeats a filename or has an
  unsupported content type becomes the target's `TargetError` instead of an uncertain execution, and
  a crash after the target finished resumes from the staged files without invoking it again. **Wire**
- The `LocalFile`, `CaseFile`, `SubjectFile`, `OutputFile` and `TargetResult` types, the
  `targetFileRoles`, `outputContentTypes`, `outputFileLimits` and `safeFilename` helpers, and the
  `OutputFileError` raised for an unusable declared file.
- Local scorers receive `context.files`: every pinned input and every generated output with its
  verified local path, role, filename, content type, byte size, SHA-256 and artifact ID, using
  `role: "output"` for generated documents. A bound `local_code` callback runs when generated files
  exist even without a JSON output.
- `rescore()` downloads a subject's frozen `files` so code evaluators can grade saved documents
  without invoking an agent. It preserves terminal scores already recorded for an item and evaluator
  version, including built-in checks scheduled by Hue's **Grade again** flow, computes only the
  missing local scores, and accepts an exact matching item/version receipt when another executor
  finished the same score during upload; an unrelated conflict still fails. **Wire**
- `runLocalAgent()` accepts a `directTarget` callback for cases without a world. Supplying it
  registers the `direct:v1` capability and supplying `target` registers `environment:v1`, beside
  declared file capabilities such as `input:docx`, `input:pdf` and `output:docx`. New exports
  `localAgentCapabilities` and `registeredCapabilities`, which refuses a registration naming a
  capability without its callback.
- `runExperiment()` and `rescore()` accept `environmentEvidence: "when_pinned"` beside `"required"`,
  so direct cases skip the environment evidence read while cases pinned to a world still require
  sealed evidence; workers with `directTarget` use it. The new `filesDirectory` option relocates the
  verified input and generated output copies, which default to `<checkpointDirectory>/files`.
- `EvaluationClient` gains `getArtifact()`, `reserveArtifact()`, `requestArtifactUpload()`,
  `uploadArtifactBytes()`, `completeArtifact()` and `downloadArtifact()` for the artifact lifecycle
  the runner uses. **Wire**

**Requires** a Hue deployment that serves case input files on experiment items, subject files on
evaluation subjects, and the artifact reservation, upload, completion and download APIs. Python
remains at `0.2.3` and has no file-based cases.

#### Changed

- Documentation and examples now name the simulation `definition` / `SimulationDefinition` and
  use case terminology; the deprecated `scenario` option and `SimulationScenario` alias are
  unchanged. No API change.

No registry release is claimed until publication and registry acceptance complete.

### [0.4.2] - 2026-09-22

#### Added

- `runSimulation` accepts `definition` for the simulation definition, and `SimulationDefinition`
  is exported alongside the options type.

#### Deprecated

- The `runSimulation` `scenario` option and the `SimulationScenario` alias are deprecated in
  favour of `definition` and `SimulationDefinition`; they are removed no earlier than two
  subsequent `0.MINOR` releases per VERSIONING.md.

No registry release is claimed until publication and registry acceptance complete.

### [0.4.1] - 2026-09-21

#### Added

- `hue.tool(..., { mcp })` records the MCP `initialize` `serverInfo` as `mcp.server.name` and
  `mcp.server.version`, so a generic tool name can be attributed to the server that handled it.
  Pass `client.getServerVersion()` after connect; any MCP server works. Environment catalog
  entries may include the same `mcp` object, and `bindEnvironmentTools` stamps it automatically.
  **Wire**

No registry release is claimed until publication and registry acceptance complete.

### [0.4.0] - 2026-09-20

#### Breaking

- The unreleased setup-session placeholder is replaced by Setup HTTP protocol v1. The exported
  `SetupBackendAdapter` is now a concrete installation/status/credential/OTLP-receipt adapter rather
  than the historical `createTrial`/`verifyReceipt`/`getClaim` stub boundary. Migration: construct it
  with `{ projectRoot, origin? }` and pass it to `runSetup`, or use the `hue` executable. Existing
  `createHue`, exporter, evaluation and environment APIs are unchanged.
- Setup JSONL events now carry `contractVersion: 2` and schema identity
  `https://hue.run/schemas/setup-events-v2.json`. Version 1 shipped in `0.3.1` and `0.3.2` with a public
  claim URL and different step/action fields. Migration: consume the bundled v2 schema, handle the
  non-secret local-handoff actions and `privacy.notice`, use `verify-application-receipt`, and require
  `receipt.verified.source: "repository-http-boundary"`. Claim events no longer include a URL.
  Setup HTTP `protocolVersion: 1` is independent and remains an unreleased protocol candidate.

#### Added

- The `hue` executable implements the unreleased Setup HTTP protocol v1 candidate: per-project/per-origin
  installation proof is persisted before network writes, provisioning and credential recovery are
  idempotent, and account claim reconciles generation 1 while checking generation 0 revocation.
- The automatic matrix is Express with npm, Express with Bun, and Flask with uv in one package
  with an unambiguous existing entrypoint, literal GET route and environment-selected port. Setup
  installs exact runtime versions through that manager, adds bounded owned middleware blocks without
  rewriting business logic, makes one request to the existing route and verifies its exact trace/span
  receipt. That original evidence is preserved through account claim without replaying business work.
  Monorepos, mixed managers, custom runtime versions and unfamiliar shapes require an explicit action.
- Technical preflight reports availability and presents the published privacy and security notice
  before telemetry. The anonymous ingestion window is 24 hours with limits of 100 traces, 1,000 spans
  and 2 MiB; unclaimed data is purged seven days after expiry.
- Both credential generations use the isolated setup token namespace and sole
  `setup_telemetry_write` capability. Exact receipts use the dedicated setup route. Normal and unknown
  token substitutions are refused; content capture requires a separate account-managed key.
- Managed credentials stay in ignored atomic `0600` files; custom conflicts, symlinks, unsafe paths,
  insecure hosted origins, redirects and unexpected edits fail closed. Setup creates no Scenario,
  Hue Run, evaluation, source capture, worker or remote execution.
- Human terminal and noninteractive version-2 JSONL agent modes support interruption/resume, private
  one-time browser handoff, post-claim status reconciliation and bounded retries. Handoffs last at
  most ten minutes, browser sessions at most thirty minutes, and each installation permits at most
  32 handoff IDs. Only an explicit human restart replaces a handoff; public output contains no claim
  capability. Installed-tarball checks cover both modes and both project languages against a loopback
  protocol service; a separate
  staging/live runner records only secret-free evidence.
- The unpublished `hue-run` npm alias tracks `0.4.0`, pins `@hue-run/sdk@0.4.0`, mirrors setup exports
  and includes its own `hue` executable wrapper. Alias publication remains a separate release gate.

No registry release is claimed until publication and registry acceptance complete.

### [0.3.2] - 2026-09-20

#### Fixed

- `runSimulation()` and `runLocalAgent()` accept an authoritative `expired` world after a failed
  finish request, allowing execution and experiment finalization while preserving the target
  outcome and expired evidence. Unconfirmed seals still remain uncertain without replaying the agent.
- Availability documentation records TypeScript `0.3.1` as published, including scorer deferral
  and the local setup CLI core.

The [release artifacts](https://github.com/hue-run/hue-sdk/releases/tag/typescript-v0.3.2) are published and passed registry acceptance.

### [0.3.1] - 2026-09-20

#### Added

- The `ScorerDefinition` union and publication validator accept Hue-executed `world_outcome`
  pins with their fixed entry and metrics. They require no local scorer registration.
- A dependency-free `hue` setup-session CLI and `@hue-run/sdk/setup` installer contract provide
  deterministic local project detection, private resumable checkpoints, append-only human/plain
  renderers and versioned JSONL agent events. This first slice does not change project files, contact
  the Hue backend, or create a Scenario, evaluation, worker or Hue Run.
- The unpublished npm alias tracks the new package exports and version. Public installation still
  uses `@hue-run/sdk`; alias publication remains separate.

#### Fixed

- Local evaluation runners execute only known `builtin` entries and bound `local_code` scorers. Other kinds
  remain pending and appear in `deferredScorerVersionIds`, including kinds introduced by a newer
  server. Unknown built-in entries are deferred too. The SDK does not upload placeholder results
  for deferred scorers, including placeholders saved by an older SDK before an interrupted upload.
- Availability documentation now records the already-published worker correctly. The setup CLI core
  was merged after publication and first belongs to this new release, not the existing 0.3.0 archive.

The existing `runLocalAgent` API, V2 connection bundle, provider transport, environment lifecycle,
checkpoint formats, telemetry ownership and capture defaults are unchanged. Python remains at 0.2.2.
No registry release is claimed until publication and registry acceptance complete.

### [0.3.0](https://github.com/hue-run/hue-sdk/releases/tag/typescript-v0.3.0) - 2026-09-19

#### Breaking

- `runSimulation()` now gives candidate callbacks only case identity and cloned task inputs, excluding expected criteria, case metadata and environment pins. Migration: move candidate-visible metadata into task inputs or candidate configuration. Scorers retain their evaluation context; generic `runExperiment()` callbacks are unchanged.
- `EnvironmentVersion.definition`, `EnvironmentClient.publishVersion()` and repository-authored simulation definitions now use `PublishableEnvironmentDefinition`, whose discriminator is `schemaVersion: 1 | 2`, rather than assuming V1. Migration: consumers that access V1-only definition fields must first narrow `definition.schemaVersion === 1`, or annotate known V1 values as `EnvironmentDefinitionV1`; use `EnvironmentDefinitionV2` only when supplying `providerInstances`.

#### Added

- `runLocalAgent()` connects a fixed local TypeScript agent entry point to app-launched, versioned simulation jobs while preserving checkpoint recovery and the developer's existing process, debugger and provider orchestration.
- `runLocalAgent()` and `runSimulation()` share one provider-aware world lifecycle: V2 manifest preflight runs once before target code, ready bundles remain memory-only, incomplete environments skip targets and scorers, and uncertain preparation is never reacquired or replayed.
- Environment publication supports explicit V1 and V2 definitions, including immutable Gmail provider-instance bindings and canonical synthetic-principal UUID comparison.

### [0.2.2](https://github.com/hue-run/hue-sdk/releases/tag/typescript-v0.2.2) - 2026-09-18

#### Fixed

- Export-time byte accounting walks arrays by element, matching admission, so array-heavy records such as embeddings that fit `maxQueueBytes` are exported instead of failed as `invalid`.

### [0.2.1](https://github.com/hue-run/hue-sdk/releases/tag/typescript-v0.2.1) - 2026-09-18

#### Changed

- The package description no longer ends with `(hue.run, not Philips Hue)`.

### [0.2.0](https://github.com/hue-run/hue-sdk/releases/tag/typescript-v0.2.0) - 2026-09-18

#### Breaking

- `zod` is an optional peer required when importing `@hue-run/sdk/evals`; `ajv` remains a separate optional peer used only by `builtins.jsonSchema`, which reports `SchemaValidatorUnavailable` when it is absent. The tracing core now depends only on `@opentelemetry/*` packages. Migration: run `npm install zod` (4.6.5 or later) for evaluations or simulations, and add `ajv` (8.17 or later) when using JSON Schema scorers.
- Export requests use explicit configuration only: `OTEL_EXPORTER_OTLP_*` environment variables no longer reach Hue's endpoint, and requests carry a `hue-sdk-typescript/<version>` User-Agent. **Wire** Migration: none for documented configuration; headers or endpoints that reached Hue through those variables were unintended and have no replacement.
- `hue.tool()` spans are named `execute_tool {name}` (`gen_ai.tool.name` keeps the bare name), matching the Python SDK and the GenAI semantic conventions. **Wire** Migration: match tool spans on `gen_ai.tool.name` or the `execute_tool ` prefix instead of the bare span name.
- Failed helper spans carry `error.type` (the error's `name`), an ERROR status without a description and an `exception` event with only `exception.type`; exception messages and stack traces are no longer recorded even with `captureContent: true`, matching the Python SDK. **Wire** Migration: group error dashboards on `error.type` and keep stack traces in application logs.
- Metadata-only mode also strips OpenInference retrieval documents, embeddings, reranker query and documents, prompt-template text and variables, `llm.tools`, `llm.function_call`, `llm.choices`, input/output images, and AI SDK `ai.response.reasoning` and `ai.response.files`; `contentPrefixes` lists the full set. **Wire** Migration: applications that relied on those fields reaching Hue with `captureContent: false` must set `captureContent: true`.
- `HueTransport`'s exporter plumbing (`finish`, `acceptedRecords`, `issue`, `instrumentationFailure`) is `@internal` and no longer appears in the published declarations. Migration: none for documented usage; read `getReport()`, `getIssues()` and `getFailureSequence()` instead of calling these members.

#### Added

- TypeScript environment APIs and bounded local tools through the new `@hue-run/sdk/environment` export, plus evaluation-client support for execution-scoped hosted MCP capabilities.
- TypeScript `runSimulation()` for repository-authored or app-authored scenarios, with immutable definition pins, fresh isolated worlds, resumable uploads, evidence-aware scoring, and early run URLs.
- V2 attempt-profile preflight for `runSimulation()`, including explicit actual-manifest evidence, typed provider connection bundles, secret-free V1/V2 binding reads, stable refresh/revocation checks, and the backwards-compatible `context.mcp` projection.
- `./package.json` export, `sideEffects` metadata, `bugs` and `keywords` in the package manifest.
- `hue.model(model, callback, options)` creates a GenAI client span for a direct provider call, taking the callback before its options like `withSpan`; `options` carries `provider`, `operation` and `name` plus `sessionId`, `userId`, `input` (recorded as `gen_ai.input.messages`) and `parentContext`. `HueSpan.setUsage()` records validated token counts, matching the Python helpers.
- `hue.inject()` / `hue.extract()` carry W3C trace context between processes without baggage or credentials.
- `hueExperimentalTelemetry(hue)` from the core entry point for AI SDK 6 `experimental_telemetry`; `hueTelemetry` remains AI SDK 7 only.
- `contentPrefixes` exports the attribute keys removed in metadata-only mode.
- Bun 1.4.2 runs the installed-package behavioral suite and the reference chatbot in package verification, and `bun pm pack` must agree with `npm pack` on package contents.
- `require("@hue-run/sdk")` and the other entry points work from CommonJS on Node.js 22.12 or later: every `exports` entry carries a `default` condition and the build has no top-level `await`; package verification exercises the `require()` path.
- `resourceAttributes` on owned-client options adds resource attributes such as `deployment.environment.name` to the owned resource, with `serviceName` and `serviceVersion` taking precedence over same-named keys; attach mode ignores it with a warning issue.
- `allowInsecureHttp: true` permits `http://` to hosts other than loopback, such as a docker-compose or in-cluster collector, and records a one-time warning issue.
- `HueConnectionError.cause` carries the underlying network, timeout or parsing error from `checkConnection()`.
- `recordMessages` accepts `operation`, `provider` and `model` for the request attributes of the details record.
- `hue.tool(name, input, execute, { callId })` records `gen_ai.tool.call.id` on the tool span, matching the Python `call_id=` keyword; a blank id is omitted with an instrumentation failure.

#### Changed

- The instrumentation scope version and export User-Agent come from a literal generated from `package.json` at build time; nothing reads `package.json` at import time, so bundled deployments are unaffected.
- `engines.node` is `>=22.12`; Node 22 and 24 are tested and Node 26 runs in CI.
- npm releases carry provenance attestations; the release workflow refuses to publish from a private source repository.
- `createHue({ enabled: false })` no longer requires `captureContent`; a disabled client defaults it to `false`.
- Export requests are sized from each record's own encoding and encoded once when sent, instead of re-encoding the growing batch for every record; the 1 MiB request split and oversized-record reporting are unchanged.
- `hue.tool`, `setInput`, `setOutput`, `recordMessages` and `SpanOptions.input` accept `unknown`, so interface-typed values compile without casts; `JsonValue` remains the documented wire shape and values that are not JSON are still omitted at runtime with an instrumentation failure.
- `recordMessages` sets `gen_ai.operation.name`, `gen_ai.provider.name` and `gen_ai.request.model` (from the enclosing `model()` span or the caller) and `gen_ai.conversation.id` (from the active session) as attributes on the `gen_ai.client.inference.operation.details` log record, alongside the existing body. **Wire** The Python `log_inference` record does not carry these attributes yet (tracked in #37).
- `hueTelemetry` reads the installed `ai` major version once per process and rejects only versions below 7; the peer range enforces the `7.0.99` floor.
- Every exported type, option and member of the four entry points carries API documentation, and the TypeScript reference build fails on undocumented public API.
- The package description ends with `(hue.run, not Philips Hue)` so registry listings are not mistaken for smart-lighting libraries.

#### Fixed

- Repository simulations normalize every public scorer definition default before immutable digest lookup and reject unsupported server-only scorer kinds instead of publishing an incompatible identity.
- The managed-target README snippet passes `tracer: hue.tracer`; without it every invocation returned `uncertain`.
- `withSpan`, `tool`, `model` and `hue.tracer.startActiveSpan` make their span the active OpenTelemetry span while the callback runs, so spans from instrumentations that use the global API parent under Hue spans when the application has registered a context manager; Hue still registers none. A disabled client leaves the application's active span visible through `getContext()`, `HueSpan.context` and `inject()`.
- Owned providers export the OpenTelemetry default resource (`telemetry.sdk.language`, `telemetry.sdk.name`, `telemetry.sdk.version`) beside `service.name` and `service.version`. **Wire**
- `createHueSafe` keeps the caller's `onExportIssue` on the disabled fallback client and records the configuration error's message as the reported issue.
- `hue.inject()` propagates W3C trace context when the client is disabled or closed, matching the Python SDK.

### [0.1.5](https://github.com/hue-run/hue-sdk/releases/tag/typescript-v0.1.5) - 2026-09-17

#### Changed

- Pending telemetry is bounded by bytes as well as records, including in-flight exports; the default `maxQueueBytes` is 8 MiB across traces and logs. Omissions and drops are reported through cumulative health counters.
- The `ai` peer range accepts AI SDK 6 for core installation; `hueTelemetry` still requires AI SDK 7.

#### Added

- `createHueSafe`, `enabled: false`, `flushSafe` and `shutdownSafe` with a default one-second caller deadline. Strict diagnostic APIs remain.
- Installed-package regressions for outages, oversized data, redactor failures, queue saturation, cancellation, stuck providers and trickling responses.

#### Fixed

- Helper capture, redaction and provider failures are isolated from application results and errors; business callbacks never rerun.
- Transport work and acknowledgements are bounded, and rejected diagnostics are isolated from the application.

### [0.1.4](https://github.com/hue-run/hue-sdk/releases/tag/typescript-v0.1.4) - 2026-09-16

#### Added

- `@hue-run/sdk/managed`: managed-target adapters with scoped execution claims, verified file bytes, existing-provider trace context, idempotent outcomes and telemetry acknowledgements.

#### Fixed

- Saved outcomes are preserved when flush callbacks report failure or pending records; expired callback budgets and malformed trace or file identities are rejected before agent work starts.

### [0.1.3](https://github.com/hue-run/hue-sdk/releases/tag/typescript-v0.1.3) - 2026-09-16

#### Added

- `hue.verifyTrace()` verifies persisted application traces by OpenTelemetry trace ID, expected span IDs and required field presence using bounded, authenticated receipt requests. Export acknowledgement, stored evidence and content inspection stay distinct; incomplete receipts and safe authentication or transport failures are reported.

### [0.1.2](https://github.com/hue-run/hue-sdk/releases/tag/typescript-v0.1.2) - 2026-09-15

#### Added

- First public npm release under MIT with the core, AI SDK and evaluation entry points.
- Hosted-judge authentication and charge-reconciliation metadata in the TypeScript declarations.
- Documented runtime and integration matrix, including dependency-resolution and cross-language content and delivery boundaries; verified release archives and registry bytes.

## hue-run (Python)

### Unreleased

#### Fixed

- `run_experiment` no longer stops the whole run with `OutcomeSerializationError` when a target's
  output is over what Hue stores for one case (200,000 bytes of JSON, 20,000 values or 32 levels
  of nesting): that case completes as `error` with the type `OutputTooLarge` and, when result
  content is persisted, the TypeScript SDK's message naming the bound, and the other cases keep
  running. Output within the bounds that is not JSON still raises `OutcomeSerializationError`.
- A large inline file whose text has a lone surrogate is hashed with U+FFFD in its place, as the
  TypeScript SDK hashes it; before, encoding it raised and the message was exported unhashed. A
  `data:` URL's parameters are read after matching its header, as in the TypeScript SDK.

### [0.6.1] - 2026-09-25

#### Added

- Provider tool spans from `record_provider_tool_calls` carry `hue.tool.call.position`, the
  0-based position of the call's item in the provider response, in both capture modes. **Wire**
- A `tools/list` span from `record_provider_tool_calls` with `capture_content=False` carries
  `hue.tool.names` and `hue.tool.definitions.sha256`, the same metadata-only summary export gives
  any record's tool definitions. **Wire**
- With `capture_content=True`, a failed OpenAI MCP call's span has the provider's error text as
  its ERROR status description, credentials scrubbed and cut to 1,024 characters exactly as the
  TypeScript SDK does, after your `redactor` sees it as `status.message`. Without content capture
  the span keeps `error.type` only. **Wire**

#### Fixed

- **Wire.** A large inline file part in a recorded message is exported with the `sha256` and
  `size` of the file's own bytes whatever its media type. Base64 content is decoded for text,
  JSON and untyped parts too, and a `data:` URL without `;base64` is percent-decoded. Before,
  those were hashed as the UTF-8 of their base64 or URL text, so the digest did not match the
  file's bytes. Behavior change: content made only of base64 characters and padded to a
  multiple of four is now read as base64 even under a text media type, as Hue reads it, so such a
  text (`AAAA…`, for example) is hashed as the bytes it decodes to and stays inline while those
  fit in 64 KiB. A text file's own text is still hashed as UTF-8. This matches the TypeScript
  SDK, checked against a shared fixture.
- `server.address` keeps a host name with an underscore, such as a Docker Compose service
  (`http://mcp_server:8080`), as WHATWG URL parsing and the TypeScript SDK do; before, it was
  dropped.
- Provider-tool argument size checks stop in bounded UTF-8 chunks, and oversized MCP arguments are
  counted as skipped instrumentation rather than silently omitted.
- Provider-tool tail classification isolates broken item types, and strict hostname validation
  rejects ambiguous URL text before it can enter `server.address`.
- Model dumps disable Pydantic content warnings when supported.
- `EnvironmentClient.wait_for_seal` ends each status read by elapsed time. A socket timeout
  restarts with every byte, so a server that sent its handshake, headers or body a byte at a time
  could hold one read for many times its window; the read's sockets are now shut down when the
  window passes, and the wait ends on time with `EnvironmentSealTimeoutError`.
- The `wait_for_seal` docstring names `EnvironmentSealTimeoutError`, which keeps `status=None`
  like a connection failure, so callers check for it before `status`.
- A tool definition containing an integer longer than CPython's `int()` digit limit (about 4,300
  digits) failed to parse, so it was exported with its credentials unscrubbed and without a
  metadata-only summary. Such an integer is now read as JavaScript reads it, the definition is
  scrubbed, and a non-finite number is written as `null`, as `JSON.stringify` writes it.
- A scrubbed `url` or `server_url` with an `http`, `https`, `ws`, `wss` or `ftp` scheme is
  serialized as WHATWG `URL` does (lowercase scheme and host, IDN hosts in Punycode, default
  ports dropped, the path percent-encoded and its dot segments resolved, query names encoded as
  `URLSearchParams` encodes them), and a URL WHATWG refuses becomes `[redacted]`. For ordinary
  hosts the exported text and `hue.tool.definitions.sha256` now match the TypeScript SDK's; some
  internationalized hosts still differ, as the README describes, and an IDN host longer than
  1,024 characters is refused before any IDNA work.
- `EvaluationClient` sends a request again, up to four times, when Hue refused it before acting on
  it with a short `Retry-After` (HTTP 429 or 503 asking for at most 5 seconds), and waits at least
  that long first. Hue does this when its key check is busy, which parallel cases can trigger; such
  a request previously failed the run. A refusal that asks for longer or gives a date, a timeout and
  any other failure still fail at once, so a write whose outcome is uncertain is never sent twice.
- The inline-file digest tests skip, rather than fail to collect, when the TypeScript suite's
  shared fixtures are absent, as the other cross-language tests do. Every cross-language test now
  finds the TypeScript suite at the same relative place, and the release's installed-wheel check
  copies its fixtures and content-prefix list there, so the digest, tool-definition, URL and
  hosted-tool-call fixtures and the prefix list are checked against the installed wheel with none
  skipped. CI runs that check on every change. The published package is unchanged by this.

### [0.6.0] - 2026-09-24

#### Added

- `HueEnvironmentError.diagnostic` exposes a validated `X-Hue-Diagnostic` code from World API
  refusals. This is new after Python 0.5.1, which does not include it.
- **Wire.** `record_provider_tool_calls` records provider-executed OpenAI and Anthropic tool
  activity as child spans, with bounded diagnostics and content capture matching TypeScript.
- `EnvironmentClient.wait_for_seal` waits through a gateway world's completion grace with bounded,
  retry-aware status reads before returning the sealed run and raises
  `EnvironmentSealTimeoutError` when the bounded wait expires.

### [0.5.1] - 2026-09-24

#### Added

- Correction: `wait_for_seal` and `EnvironmentSealTimeoutError` shipped after Python 0.5.1; they are documented under 0.6.0.
- **Wire.** `span.record_file(role=..., media_type=..., sha256=..., data=..., byte_size=..., name=...)`
  adds a `hue.file` event with the same attributes as TypeScript `hue.recordFile`.
- **Wire.** `hue.model(..., system_instructions=..., tools=...)` and
  `span.log_inference(system_instructions=...)` record `gen_ai.system_instructions` and
  `gen_ai.tool.definitions` when content is captured.
- **Wire.** `hue.context(workspace_id=...)` records `hue.workspace.id` on nested helper spans.
- **Wire.** `hue.tool(..., mcp=)` accepts `provider` and `surface`, recorded as
  `hue.mcp.provider` and `hue.mcp.surface`.
- **Wire.** Metadata-only export that removes tool definitions leaves `hue.tool.names` and
  `hue.tool.definitions.sha256`, with the same digest as TypeScript.

#### Fixed

- **Wire.** Hosted-tool credentials in exported tool definitions and recorded raw requests are
  replaced with `"[redacted]"` at export, as in TypeScript.
- **Wire.** A `blob` or `file` part over 64 KiB in recorded messages is exported as its `sha256`
  and `size` instead of its payload, so a 2 MiB inline document no longer drops the record.

### [0.5.0] - 2026-09-24

#### Added

- **`hue_sdk.environment`.** `EnvironmentClient` for Hue's World API: `create_run` (with
  `execution_id`, `traceparent` and `agent_revision`), `get_run`, `finish_run`, `get_evidence`,
  `act`, `list_steps` and `record_coverage_gap`, retrying deduplicated mutations and waiting Hue's
  `Retry-After` on 429 and 503. `world_handoff`, `agent_environment`,
  `strip_hue_control_plane_credentials`, `legacy_mcp_capability` and `mcp_config_file` build an
  agent child's configuration from the world's token, mirror URLs, `env` and `mcpConfig` without
  the project key. No tool binding is included.

#### Changed

- `run_experiment` and `rescore` accept `concurrency` up to 64 (was 16). The default stays 1.

### [0.4.0] - 2026-09-23

#### Breaking

- Live spans are on by default: while a span from Hue's own helpers or a recognized AI
  instrumentation is still running, the exporter also exports a placeholder for it (see Added). A
  Hue deployment that accepts placeholders answers with `Hue-Pending-Spans: 1`; if a receiver
  without that header gets placeholders, their rejections are credited to them,
  `ExportStatus.live_spans_rejected` is set and live spans switch off for that client.
  Placeholders may use up to a quarter of the export queue. Migration: pass `live_spans=False`
  for the previous wire behavior. A processor wrapper that forwards `on_start` but scrubs,
  renames or drops spans in `on_end` does not change their placeholders; do not forward
  `on_start` for spans you filter, or pass `live_spans=False`. **Wire**
- A finished span no longer carries `hue.span_type` or `hue.pending_parent_id` attributes set by
  the application; Hue reserves them for placeholders. Migration: rename application attributes
  that use those keys. **Wire**

#### Added

- **Live spans.** A placeholder lets Hue show a trace, its request and its running model and tool
  calls before they finish. It is an ordinary OTLP span that names the running span as its
  parent, ends at 0 and carries `hue.span_type = "pending_span"` and `hue.pending_parent_id`;
  markers are added after the content policy and redaction. Queued placeholders are never counted
  as dropped, a placeholder whose span has ended by export time is not sent, and a request
  carrying only placeholders never fails the export status; rejections in a request that also
  carries finished spans fail it as before. **Wire**
- `live_spans` keyword (default `True`; always off for setup credentials) and
  `ExportStatus.live_spans_rejected`.

### [0.3.0] - 2026-09-23

#### Added

- Product-named eval set, evaluator, run and scoring methods on `EvaluationClient`, using the
  existing v1 paths. Responses retain both field names, and a run ID remains distinct from its
  scoring ID. Existing client methods and local runners remain callable.

#### Deprecated

- Older low-level evaluation client method names now have product replacements. They remain
  supported for at least two subsequent `0.MINOR` releases. The v1 response aliases remain
  available while the server compatibility window is open.

#### Changed

- The evaluation guide names Hue's consolidated **Read and write** access preset, which replaces
  **Tracing and evaluations**. Existing keys keep their access.

### [0.2.3] - 2026-09-21

#### Added

- `hue.tool(..., mcp={"name", "version"})` records the MCP `initialize` `serverInfo` as
  `mcp.server.name` and `mcp.server.version`, matching TypeScript `hue.tool(..., { mcp })`.
  **Wire**

No registry release is claimed until publication and registry acceptance complete.

### [0.2.2](https://github.com/hue-run/hue-sdk/releases/tag/python-v0.2.2) - 2026-09-18

#### Changed

- `log_inference` emits the `gen_ai.client.inference.operation.details` record with a structured body instead of JSON-string fields (an explicit `None` field keeps its key with an empty value, as in TypeScript), sets `gen_ai.operation.name`, `gen_ai.provider.name` and `gen_ai.request.model` as record attributes from the enclosing `model()` block or the new `operation=`, `provider=` and `model=` keywords, and `gen_ai.conversation.id` from the enclosing `context()`, matching TypeScript `recordMessages` (#37). With `capture_content=False` no record is emitted, and the Python-only `hue.capture_content` record attribute is gone. **Wire**

### [0.2.1](https://github.com/hue-run/hue-sdk/releases/tag/python-v0.2.1) - 2026-09-18

#### Changed

- The package summary no longer ends with `(hue.run, not Philips Hue)`.

### [0.2.0](https://github.com/hue-run/hue-sdk/releases/tag/python-v0.2.0) - 2026-09-18

#### Breaking

- `capture_content=False` now strips recognized GenAI, OpenInference, OpenLLMetry and Vercel AI SDK content attributes, legacy `gen_ai.*` message events, log bodies and status descriptions from every exported record, including spans from third-party instrumentors on the same provider, matching the TypeScript export path. **Wire** Migration: applications that expected third-party instrumentor content to reach Hue in metadata-only mode must set `capture_content=True` and rely on the instrumentor's own capture controls and the redactor.
- `jsonschema` and `referencing` move to the optional `hue-run[evals]` extra used only by `builtin_scorers.json_schema` (alias `builtins`); without it that helper raises `ImportError` and stored schema scorers report `SchemaValidatorUnavailable`. The tracing core now depends only on OpenTelemetry packages and `requests`. Migration: install `hue-run[evals]` where `builtin_scorers.json_schema` or stored schema scorers are used.
- The metadata-only content list also covers OpenInference retrieval documents, embeddings, reranker query and documents, prompt-template text and variables, `llm.tools`, `llm.function_call`, `llm.choices`, input/output images, and AI SDK `ai.response.reasoning` and `ai.response.files`, identical to TypeScript's `contentPrefixes`. **Wire** Migration: set `capture_content=True` where those fields must reach Hue.
- In attach mode the `LoggerProvider` Hue creates for correlated logs reuses the borrowed `tracer_provider`'s resource instead of a resource built from `service_name`, so logs and spans report one `service.name`. **Wire** Migration: none for applications expecting a single service; set `service.name` on the borrowed provider's resource, or pass `logger_provider=` to control the log resource explicitly.

#### Added

- Repository, changelog and issue URLs, classifiers and keywords in the package metadata.
- `logger_provider=` attaches Hue's log processor to an existing SDK `LoggerProvider`, mirroring the TypeScript existing-provider mode; borrowed providers are not shut down by the client.
- `hue_sdk.evals.builtin_scorers` names the built-in scorer bundle without shadowing the standard-library `builtins` module; `builtins` remains an alias.

#### Changed

- OTLP export requests are gzip-compressed and carry a `hue-sdk-python/<version>` User-Agent ahead of the OpenTelemetry exporter's token, matching TypeScript. **Wire**
- `Hue("<key>")` and `EvaluationClient("<key>")` raise `TypeError` naming `api_key=` instead of a `base_url` `ValueError`; existing positional `(base_url, api_key)` calls are unchanged.
- `Hue.base_url`, `Hue.tracer`, `Hue.tracer_provider`, `Hue.logger_provider`, `EvaluationClient.base_url` and the evaluation error attributes carry class-level annotations, and the mypy gate no longer ignores missing stubs (`types-protobuf` and `types-jsonschema` join the dev group).
- `opentelemetry-api`, `opentelemetry-sdk` and `opentelemetry-exporter-otlp-proto-http` are accepted as `>=1.40,<2` instead of exactly 1.44.0, so `hue-run` installs next to applications and instrumentation packages on another OpenTelemetry 1.x release. `uv.lock` keeps 1.44.0 as the certified combination, and a new CI job re-resolves every direct dependency at its declared floor (`uv lock --resolution lowest-direct`) and runs the full suite, including the installed wheel, on Python 3.10 and 3.12 with OpenTelemetry 1.40.0. The two OpenTelemetry internals the transport uses are guarded: a missing OTLP log encoder raises an `ImportError` naming the supported range, and a missing instrumentation-suppression key emits a one-time `RuntimeWarning` and exports without suppression.
- The package summary ends with `(hue.run, not Philips Hue)` so registry listings are not mistaken for smart-lighting libraries.

#### Fixed

- The managed-target README snippet passes `tracer=hue.tracer`; without it every invocation returned `uncertain`.

### [0.1.3](https://github.com/hue-run/hue-sdk/releases/tag/python-v0.1.3) - 2026-09-17

#### Changed

- Pending telemetry is bounded by bytes (8 MiB per signal by default) as well as records, including in-flight exports; omissions and drops are reported through cumulative counters.

#### Added

- `create_hue_safe`, `enabled=False`, `force_flush_safe` and `shutdown_safe` with a default one-second deadline; HTTP 429 and `Retry-After` handling; inherited clients are safe after fork.
- Installed-wheel regressions for outages, oversized data, redactor failures, queue saturation, cancellation and stuck providers.

#### Fixed

- Helper capture, redaction and provider failures are isolated from application results and exceptions; business callbacks never rerun.

### [0.1.2](https://github.com/hue-run/hue-sdk/releases/tag/python-v0.1.2) - 2026-09-16

#### Added

- `hue_sdk.managed`: managed-target adapters with the same contract as TypeScript 0.1.4.

#### Fixed

- Saved outcomes are preserved when flush callbacks report failure or pending records; expired budgets and malformed identities are rejected before agent work starts.

### [0.1.1](https://github.com/hue-run/hue-sdk/releases/tag/python-v0.1.1) - 2026-09-16

#### Added

- `Hue.verify_trace()` stored-trace receipts with the same contract as TypeScript 0.1.3.

### [0.1.0](https://github.com/hue-run/hue-sdk/releases/tag/python-v0.1.0) - 2026-09-15

#### Changed

- Clients default to Hue Cloud (`https://app.hue.run`); explicit origins and existing positional calls keep working.

#### Added

- First public PyPI release under MIT with unchanged `hue_sdk` imports and package-page-safe links.

## Coding-agent skill (skills/hue)

The skill is installed from the default branch (`npx skills add hue-run/hue-sdk --skill hue`), so an entry takes effect when it merges into `main`.

- 0.4.4 (2026-09-25): `@hue-run/sdk` 0.10.0 is published, so the evaluation section says what changed "since" it rather than "from" it: an evaluator that does not apply to a case shows `n/a`, and one-shot `hue eval` stores outputs by default. Also collects the unreleased metadata change merged since 0.4.3: recommend one **Read and write** project key for development instead of **Tracing only**. The invite-only check looks for a Hue project and a project key configured as `HUE_API_KEY`, names **Read and write** as the recommended preset and still admits a key of any preset. The one **Read and write** key sends traces, verifies delivery, runs evaluations and connects the Hue MCP server, where it is configured as `HUE_MCP_KEY` (a **Read** key suffices for inspect-only access). Before the application runs on a production server, the user creates a separate **Tracing only** key for that server's `HUE_API_KEY`. The fix for a rejected export is a **Read and write** key for development and evaluation, or **Tracing only** on a production server.
- 0.4.3 (2026-09-25): the evaluation section says that from `@hue-run/sdk` 0.10.0 one-shot `hue eval` stores case outputs, error messages and explanations by default, the command's stdout being its stored answer with the credentials it was handed redacted, and `--no-output` opts out (earlier versions store them only with `--content`); that files written to `output/` are uploaded and not fully redacted, so they must never hold credentials; and that an evaluator that does not apply to a case shows `n/a` and neither passes nor fails it.
- 0.4.2 (2026-09-24): recommend full traces. The capture section, now headed "Capture and instrument full traces", tells agents to recommend `captureContent: true` / `capture_content=True` in the plan shown to the user and to state what it sends (prompts/messages, responses and tool inputs/outputs alongside model, usage, timing and errors); the user's approval authorizes it. Metadata-only (`false`) remains the opt-out when the user declines or an existing application policy forbids sending that content. The value is still required, and redaction and credential filtering apply in both modes. Agents instrument every request path that calls a model or tool, not only one, verify at least one real request and report the instrumented paths they did not exercise. Also collects the unreleased metadata changes merged since 0.4.1: find published cases with the Hue MCP tools `list_cases` and `get_case` (the earlier `list_scenarios` and `get_scenario` names remain aliases), and name Hue's consolidated access presets. Evaluation workflows use **Read and write** (formerly **Tracing and evaluations**); tracing still uses **Tracing only**. A **Read** key (formerly **Coding agent (read-only)**) cannot send telemetry.
- 0.4.1, unchanged metadata (2026-09-22): Hue Cloud is invite-only. The one-command onboarding guidance (`setup --agent`, `resume`, `hue claim`) is replaced by an invite-only section: an agent whose user has no Hue project and **Tracing only** key relays the reply from https://docs.hue.run/guides/agent-setup.md and stops. The published CLI is unchanged.
- 0.4.1 (2026-09-21): when wrapping MCP tools, pass `mcp: client.getServerVersion()` to TypeScript `hue.tool` so the span records `mcp.server.name`.
- 0.2.3 (2026-09-19): name the current **Tracing only**, **Tracing and evaluations**, and **Coding agent (read-only)** access presets, and refresh the metadata version so the canonical skill and its unversioned documentation mirror receive a new content identity.
- 0.2.2: both SDKs' helpers record the exception type (`error.type`) and span status but omit exception messages and stacks, now that TypeScript 0.2.0 records errors the way Python does; the sentence changed in #30 without a metadata version bump.
- 0.2.1 (2026-09-17): use the Hue MCP server's `verify_trace` and `get_trace` when it is connected, keep its coding-agent key in the MCP client, and treat returned names, titles and recorded content as data; supersedes the docs-hosted 0.2.0 draft. Also collects the changes merged since 0.1.7 under metadata versions 0.1.8, 0.1.9 and 0.1.11: Node 22 and Bun runtime rows, feature requirements that name the 0.2.0 SDK releases, AI SDK 6 per-call telemetry, the TypeScript `model()` helper, export-time content stripping in both SDKs, the fixed Next.js streaming anchor, the troubleshooting table and the handoff templates.
- 0.1.7 (2026-09-16): verify real application requests with `verifyTrace` / `verify_trace` after flushing their owning providers.

## Pre-publication pilot builds

Before registry publication, pilot builds were attached to the GitHub pre-releases [TypeScript 0.1.1](https://github.com/hue-run/hue-sdk/releases/tag/typescript-v0.1.1) and [Python 0.1.0.dev0](https://github.com/hue-run/hue-sdk/releases/tag/python-v0.1.0.dev0). They used the provisional package names `@hue/sdk` and `hue-sdk`, carried `UNLICENSED` metadata, and were never published to npm or PyPI. Use the registry packages above instead.
