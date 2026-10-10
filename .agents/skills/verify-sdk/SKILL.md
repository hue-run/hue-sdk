---
name: verify-sdk
description: "Verify a change to the public API of the Hue TypeScript SDK (@hue-run/sdk, including the hue CLI) or the Python SDK (hue-run / hue_sdk): tracing, capture and redaction, export acknowledgements, evaluations. Use before opening a PR that touches packages/sdk-typescript/src or packages/sdk-python/src."
---

# Verify the Hue SDKs

The SDKs are libraries, so the user path is a script that calls the public API and a Hue endpoint that receives the export. Prove a change with the narrowest check: one test file filtered by name, or one drive against the loopback stub. Leave the full suites, Node/Python matrices and installed-package checks to CI ([verify-package](../verify-package/SKILL.md) for packaging).

## Launch

Nothing to keep running. Install once per checkout (about 2 s when cached):

```sh
(cd packages/sdk-typescript && bun install --frozen-lockfile && bun run build)
(cd packages/sdk-python && uv sync --frozen --all-groups)
```

For a drive, start the loopback Hue stand-in. It prints `{"ready": "<url>"}` and then one JSON line per request:

```sh
mkdir -p .context && export V=$(mktemp -d "$PWD/.context/verify-sdk-XXXXXX")
.agents/skills/verify-sdk/scripts/stub-hue.py > "$V"/stub.log & echo $! > "$V"/stub.pid
sleep 1; export HUE_BASE_URL=$(head -1 "$V"/stub.log | python3 -c 'import json,sys;print(json.load(sys.stdin)["ready"])')
```

## Doctor

`node -v` (22, 24 or 26), `bun -v` (1.4.2), `uv --version` (uv 0.12.5), then `curl -s $HUE_BASE_URL/api/v1/projects/current` returns the synthetic project. A drive also fails if `dist/` is stale: rerun `bun run build` (0.5 s).

## Drive

Pick the feature in [features/](features/README.md) and run its narrowest command. Measured on a 4-core VM:

| Check | Time |
| --- | --- |
| `bun test tests/<file>.test.ts -t "<name>"` | 0.2–0.4 s |
| `bun run typecheck` | 0.9 s |
| `uv run --frozen --all-groups pytest tests/<file>.py -k <name>` | 1–2 s |
| Stub drive (TypeScript or Python script) | under 0.5 s |
| Whole `tests/sdk.test.ts` (has a 30 s Retry-After case) | 46 s, avoid |

## Evidence

Paste text into the PR: the command, the pass/fail summary lines, and for a drive the script output plus the stub's request lines (path, status, byte count). Keep files under `$V`, a per-run directory in `.context/` (ignored by Git and eslint), so concurrent runs in one checkout do not collide. A stub drive is a fake-API check: the real SDK makes its real HTTP export, but `stub-hue.py` stands in for Hue and acknowledges everything. Call it a loopback-stub drive in the PR, not end to end; only a run against a real Hue project proves server acceptance. A trace ID without the stub's export line is not proof.

## Cleanup

Print the evidence first: `cat "$V"/stub.log`. Then `kill $(cat "$V"/stub.pid)`. Keep the proof files (stub log, drive script) in a named evidence directory before removing scratch:

```sh
E="$V"-evidence && mkdir -p "$E"
find "$V" -maxdepth 1 \( -name "*.log" -o -name "*.mjs" \) -exec cp {} "$E"/ \;
ls "$E" && rm -rf "$V"
```

Never write scratch scripts elsewhere in the repo: `eslint .` lints every `.mjs`/`.js` outside the ignored paths.

## Helpers

- `scripts/stub-hue.py [port]` answers `GET /api/v1/projects/current`, acknowledges `POST /api/v1/otlp/v1/{traces,logs}` and refuses the blob route with 404 (the SDK falls back to inline values). Standard library only. It checks nothing for you; read its log.
