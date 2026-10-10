# hue CLI

The `hue` executable ships in `@hue-run/sdk` (`dist/setup/cli.js`): `setup`, `resume`, `status`, `claim`, `login`, `eval`, `mcp` and `listen` (packages/sdk-typescript/CLI.md).

## Sub-features

- `cli-eval` runs a local agent against a case or eval set; `--check` is a no-create preflight.
- `cli-login` validates a key and stores it in `.env.hue` with mode 0600.
- `cli-mcp` writes MCP client configuration without key values.
- `cli-listen` delivers simulated events to a local bot.
- `cli-setup` is the resumable setup state machine.

## How to get to it (user POV)

- `npx -y @hue-run/sdk eval ...`, `hue login`, `hue mcp install --client <name>`.

## Driving it with node and bun test

Preconditions:

- `bun run build` done in `packages/sdk-typescript`.

- **Usage text.** `node packages/sdk-typescript/dist/setup/cli.js eval --help`. Expected: exit 0 and `Usage: hue eval [adapter-file] [options]`.
- **Behavior test.** `cd packages/sdk-typescript && bun test tests/cli-eval.test.ts -t "rejects conflicting content flags"`. Expected: `1 pass` in about 0.3 s. Matching files: `cli-login`, `cli-mcp`, `cli-listen`, `cli-eval-direct`, `cli-output-safety`, `setup*.test.ts`.

## Gotchas

- `hue login` and `hue eval` read `HUE_API_KEY` and `./.env.hue`. Run CLI drives with `env -u HUE_API_KEY` in a scratch directory so a shell key cannot reach a real origin.
- Installed-package setup behavior (`verify-installed-setup.mjs`) runs inside verify-package, not here.
