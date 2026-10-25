# Gmail summary tools

The TypeScript and Python consumers under `examples/gmail-summary-tool/` run
Gmail list/get reads and return `{count, ids}`. Default HTTP capture records the
API responses on six CLIENT children under one ordinary tool span. Each offline
runner starts its own synthetic Gmail and OTLP receivers, so the shared stub
from Launch is not needed for this feature.

## Drive from installed archives

Run from the repository root with Node 22 or 24, Bun 1.4.2, and uv 0.12.5. Use an
ignored per-run directory. No Hue or Gmail credentials are needed.

```sh
mkdir -p .context
V=$(mktemp -d "$PWD/.context/verify-gmail-XXXXXX")
(cd packages/sdk-typescript && bun install --frozen-lockfile && bun run build && npm pack --ignore-scripts --pack-destination "$V")
cp -R examples/gmail-summary-tool/typescript "$V/typescript"
cp -R examples/gmail-summary-tool/fixtures "$V/fixtures"
(cd "$V/typescript" && npm install --no-audit --no-fund "$V"/hue-run-sdk-*.tgz && npm run build && npm run offline) | tee "$V/typescript.log"
(cd packages/sdk-python && uv build --wheel --out-dir "$V/dist")
uv venv "$V/venv"
uv pip install --python "$V/venv/bin/python" "$V"/dist/hue_run-*.whl
"$V/venv/bin/python" examples/gmail-summary-tool/python/main.py | tee "$V/python.log"
HUE_CAPTURE_HTTP_BODIES=false "$V/venv/bin/python" examples/gmail-summary-tool/python/main.py
HUE_CAPTURE_HTTP=false "$V/venv/bin/python" examples/gmail-summary-tool/python/main.py
HUE_CAPTURE_CONTENT=false HUE_CAPTURE_HTTP_BODIES=true "$V/venv/bin/python" examples/gmail-summary-tool/python/main.py
```

Unset inherited `HUE_CAPTURE_*` variables before the default Python run. The
TypeScript runner supplies its four policies explicitly and ignores live
credentials. A terminal with `pipefail` preserves failure exit codes through
`tee`; inspect the exit status as well as the logs.

Expected default output includes a trace ID, five summary IDs, six HTTP spans,
and `exported: true`, plus real receiver POST acknowledgements. The assertions
check query inputs, HTTP status and raw JSON responses, unchanged summary, one tool
execution, no export recursion, and omitted authorization. Controls keep the
same summary and omit bodies or HTTP spans according to policy. A failed
assertion is failed verification even if the receiver acknowledged export.

For changes to model-body suppression or nested tools, run only the targeted
scope mode from the installed consumers:

```sh
(cd "$V/typescript" && npm run offline -- --model-scope)
"$V/venv/bin/python" examples/gmail-summary-tool/python/main.py --model-scope
```

Expected: two synthetic model HTTP spans keep identity without either body,
including the call after the ordinary tool returns. Six Gmail HTTP children
retain raw responses, including mail headers and pagination. Model metadata
stays intact. The requests and receiver acknowledgements are real loopback
traffic. This mode makes no paid model call. Reuse unchanged capture-control
evidence when the candidate changes only model or tool scope handling.

For the separate canonical source fixture and fresh downstream World proof:

```sh
(cd "$V/typescript" && npm run offline -- --canonical --export-dir="$V/canonical-capture")
"$V/venv/bin/python" examples/gmail-summary-tool/python/main.py --canonical
```

Canonical v2 really sends `maxResults=10` and returns five messages. The helper's
live/default limit remains five. Keep v1's full-page5/6 result unchanged.
The TypeScript manifest records the source fixture hash, trace ID and batch
hashes. The files contain the receiver's OTLP protobuf after decompression,
with attributes and payloads unchanged. Keep the original fixture's replay
mismatch evidence. Pass the new batches through the actual World pipeline;
report raw equality, mapping, reconstruction and strict replay separately.
Only explicit loopback identity rewriting is allowed for synthetic host
recognition. Do not change captured queries/results or tune a matcher.

Run Python lint on the new example too:

```sh
(cd packages/sdk-python && uv run --frozen --all-groups ruff check ../../examples/gmail-summary-tool/python && uv run --frozen --all-groups ruff format --check ../../examples/gmail-summary-tool/python)
```

Keep the logs in `.context/` and paste their output in the PR. Both runners stop
their loopback servers. These are local acknowledgement checks, not proof of
storage in Hue, a World build, or live mailbox behavior.
