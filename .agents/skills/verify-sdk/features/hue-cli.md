# hue CLI

The `hue` executable ships in `@hue-run/sdk` (`dist/setup/cli.js`): `setup`, `resume`, `status`, `claim`, `login`, `eval`, `mcp`, `listen` and `import` (packages/sdk-typescript/CLI.md).

## Sub-features

- `cli-eval` runs a local agent against a case or eval set; `--check` is a no-create preflight.
- `cli-eval-judges` explicitly dispatches pinned hosted model judges with `--judges`, after outputs upload. No flag requests no judge jobs. Interrupted dispatch resumes the uploaded run with the same job keys.
- `cli-login` validates a key and stores it in `.env.hue` with mode 0600.
- `cli-mcp` writes MCP client configuration without key values.
- `cli-listen` delivers simulated events to a local bot.
- `cli-import` copies a Langfuse project's traces (and, with `--media`, its files) into Hue.
- `cli-setup` is the resumable setup state machine.

## How to get to it (user POV)

- `npx -y @hue-run/sdk eval ...`, `hue login`, `hue mcp install --client <name>`, `hue import langfuse --dry-run`.

## Driving it with node and bun test

Preconditions:

- `bun run build` done in `packages/sdk-typescript`.

- **Usage text.** `node packages/sdk-typescript/dist/setup/cli.js eval --help`. Expected: exit 0 and `Usage: hue eval [adapter-file] [options]`.
- **Behavior test.** `cd packages/sdk-typescript && bun test tests/cli-eval.test.ts -t "rejects conflicting content flags"`. Expected: `1 pass` in about 0.3 s. Matching files: `cli-login`, `cli-mcp`, `cli-listen`, `cli-import-langfuse`, `cli-eval-direct`, `cli-output-safety`, `setup*.test.ts`.
- **Hosted judge opt-in.** `cd packages/sdk-typescript && bun test tests/cli-eval-judges.test.ts tests/cli-eval-direct.test.ts tests/cli-eval.test.ts -t "hosted judge|CLI hosted judge|lost judge|simulation mode requests"`. Expected: loopback-only checks pass for no opt-in, mixed evaluator pins, missing output, budget refusal, paging, 100-pair batches, duplicate/replayed requests, direct and simulation execution, mixed command workers, and lost dispatch acknowledgements after the budget is disabled, and a failed first handoff write in direct, simulation and worker modes without another agent invocation. Worker checks also cover terminal claim cleanup, preserving transient handoffs and continuing after verdict-read failures without replaying jobs. Installed-package verification repeats the direct and worker cases through the packed Node CLI. No provider is called.
- **Import from Langfuse.** `cd packages/sdk-typescript && bun test tests/cli-import-langfuse.test.ts -t "converts every page"`. Expected: `1 pass`. The file's tests run loopback stand-ins for Langfuse's API (v2 and v1) and Hue's receiver and upload routes; the whole file (media, rate limits, resume, the installed binary) takes under a second.

## Gotchas

- `hue login`, `hue eval` and `hue import` read `HUE_API_KEY` and `./.env.hue`; `hue import` also reads `LANGFUSE_*`. Never point a drive at a real Langfuse project or Hue origin. Run CLI drives with `env -u HUE_API_KEY` in a scratch directory so a shell key cannot reach a real origin.
- Installed-package setup behavior (`verify-installed-setup.mjs`) runs inside verify-package, not here.
