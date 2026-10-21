# hue CLI

The `hue` executable ships in `@hue-run/sdk` (`dist/setup/cli.js`): `setup`, `resume`, `status`, `claim`, `login`, `eval`, `mcp`, `listen`, `import` and `traces` (packages/sdk-typescript/CLI.md).

## Sub-features

- `cli-eval` runs a local agent against a case or eval set; `--check` is a no-create preflight. A set mixing World and answer-only cases runs as one `mixed` run (each case through its own kind's path, one experiment, its own checkpoint identity); `--mode simulation` over it is refused.
- `cli-eval` defaults to four cases in flight in one-shot and worker modes. Explicit concurrency values override the default. Case files, environments and checkpoints remain isolated; existing serial checkpoints resume under the same agent revision.
- `cli-eval-judges` dispatches pinned hosted model judges by default after outputs upload. `--no-judges` skips them; `--judges` remains accepted. `--no-output` skips automatic dispatch. Preflight and runs without pinned model judges request no model jobs. Interrupted dispatch resumes the uploaded run with the same job keys. Opting out with a pending dispatch stops before another agent execution.
- `cli-login` validates a key and stores it in `.env.hue` with mode 0600.
- `cli-mcp` writes MCP client configuration without key values.
- `cli-listen` delivers simulated events to a local bot.
- `cli-import` copies a Langfuse project's traces (and, with `--media`, its files) into Hue, stamping each span with Langfuse's environment as recorded in `hue.import.source_environment` (absent stays absent).
- `cli-traces-import` prepares a bundle of OTLP/JSON, Langfuse observation or ATIF exports (`prepare`) and delivers it to the import routes with the `hue_it_` authorization `prepare_trace_import` answers (`upload`); no project key. The authorization is read only from `--authorization-file` and redacted from every line.
- `cli-setup` is the resumable setup state machine.

## How to get to it (user POV)

- `npx -y @hue-run/sdk eval ...`, `hue login`, `hue mcp install --client <name>`, `hue import langfuse --dry-run`, `hue traces import prepare <path> --out <directory> --json` then `hue traces import upload <directory> --authorization-file <file> --json`.

## Driving it with node and bun test

Preconditions:

- `bun run build` done in `packages/sdk-typescript`.

- **Usage text.** `node packages/sdk-typescript/dist/setup/cli.js eval --help`. Expected: exit 0 and `Usage: hue eval [adapter-file] [options]`.
- **Mixed eval set.** `cd packages/sdk-typescript && bun test tests/cli-eval-direct.test.ts tests/cli-eval.test.ts -t "mixed eval set|mixing world and answer-only"`. Expected: `2 pass` in about 3 s: one experiment, one World, both cases completed under the `mixed` checkpoint identity, and `--mode simulation` refused.
- **Behavior test.** `cd packages/sdk-typescript && bun test tests/cli-eval.test.ts -t "rejects conflicting content flags"`. Expected: `1 pass` in about 0.3 s. Matching files: `cli-login`, `cli-mcp`, `cli-listen`, `cli-import-langfuse`, `cli-eval-direct`, `cli-output-safety`, `setup*.test.ts`.
- **Concurrency and hosted judges.** `cd packages/sdk-typescript && bun test tests/cli-eval-judges.test.ts tests/cli-eval-direct.test.ts tests/cli-eval.test.ts -t "CLI concurrency|hosted judge|CLI hosted judge|lost judge|simulation mode requests|interrupted serial run"`. Expected: loopback-only checks prove default overlap of four and explicit serial or two-case limits in one-shot and worker modes, isolated case directories and credentials, serial checkpoint adoption, automatic dispatch, opt-out, conflicting flags, preflight, mixed evaluator pins, missing output, budget refusal, paging, 100-pair batches, duplicate/replayed requests, direct and simulation execution, mixed command workers, and lost dispatch acknowledgements after the budget is disabled, and a failed first handoff write in direct, simulation and worker modes without another agent invocation. Worker checks also cover terminal claim cleanup, preserving transient handoffs and continuing after verdict-read failures without replaying jobs. Installed-package verification repeats the direct and worker cases through the packed Node CLI. No provider is called.
- **Import from Langfuse.** `cd packages/sdk-typescript && bun test tests/cli-import-langfuse.test.ts -t "converts every page|environment as recorded"`. Expected: `2 pass`; the second pins `hue.import.source_environment` on a production trace, Langfuse's `default` copied as recorded, and neither attribute on a trace without an environment. The file's tests run loopback stand-ins for Langfuse's API (v2 and v1) and Hue's receiver and upload routes; the whole file (media, rate limits, resume, the installed binary) takes under a second.
- **Import a bundle of traces.** `cd packages/sdk-typescript && bun test tests/cli-traces-import.test.ts -t "registers the manifest"`. Expected: `1 pass`. The file runs `prepare` on synthetic OTLP/JSON, Langfuse observation and ATIF fixtures (a directory and a ZIP; unreadable files and mapped vendor ids reported) and `upload` against a loopback stand-in for the import routes written from their contract: manifest registration, ordered batches with `Hue-Import-Batch`, value reserve/PUT/complete, receipts, reconcile, complete, `409 incomplete`, every fixed refusal code, resume from `progress.json`, conflicts, and redaction of an echoed authorization. The whole file takes under two seconds. Usage text: `node packages/sdk-typescript/dist/setup/cli.js traces --help` prints `Usage: hue traces import prepare …`.
- **Import formats.** `cd packages/sdk-typescript && bun test tests/traces-import-formats.test.ts`. Expected: `12 pass` in about half a second. It covers the format registry (`src/cli/import-formats/`): gzip and zstd input, JSON Lines and arrays read record by record with bad lines named, exactly one format claiming each fixture, identity read as Hue reads it (child span, metadata maps, the Claude Code rule, tool spans ignored, `--user-key` adding `hue.import.user` without changing recorded spans), GenAI message conversion, the emitter's timing rules, and Braintrust rows (UI download, fetch and query answers, JSON Lines; Mastra, OpenAI Agents and experiment rows).
- **Agent runtime, event and transcript imports.** `cd packages/sdk-typescript && bun test tests/traces-import-agent-events.test.ts`. Expected: `12 pass` in under a second. It runs `prepare` on the synthetic fixtures in `tests/fixtures/import-agent-events/` and checks that exactly one format claims each record, then how OpenAI Agents SDK records (processor lines and the ingest body), Raindrop events (track payloads and Query API answers), Helicone request exports and OpenAI chat, OpenAI Responses and Anthropic Messages transcripts convert: model calls with messages and usage, tool calls paired with their results, the end user and conversation on the root, the untimed rule for transcripts, `--user-key`, and a malformed record refusing only its own trace.

## Gotchas

- `hue login`, `hue eval` and `hue import` read `HUE_API_KEY` and `./.env.hue`; `hue import` also reads `LANGFUSE_*`. Never point a drive at a real Langfuse project or Hue origin. Run CLI drives with `env -u HUE_API_KEY` in a scratch directory so a shell key cannot reach a real origin.
- `hue traces import upload` reads no key at all: only `--authorization-file`. Drive it against the test file's loopback stand-in (or a `hue()` server copied from it), never a real origin; the import routes arrive with a forthcoming Hue release.
- Installed-package setup behavior (`verify-installed-setup.mjs`) runs inside verify-package, not here.
