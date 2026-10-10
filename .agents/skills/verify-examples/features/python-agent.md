# Python agent

`examples/python-agent/main.py` imports only the installed `hue_sdk`, validates the project, records a synthetic streamed model response, a tool call and a handled tool failure, flushes, and prints `mode=... trace_id=... exported=true`.

## Sub-features

- `agent-synthetic` runs without any provider (`--mode synthetic`, default).
- `agent-capture` with `--capture-content no` exports metadata only.
- `agent-openai` (`--mode openai`) calls a real provider and is not part of verification.

## How to get to it (user POV)

- `pip install -r examples/python-agent/requirements.txt`, set `HUE_API_KEY`, `python examples/python-agent/main.py --capture-content yes`.

## Driving it with an installed wheel

Preconditions:

- Skill Launch done (stub running, `HUE_BASE_URL` and `HUE_API_KEY` exported). Run from the repository root.

- **Install the branch's wheel** (a few seconds):

  ```sh
  (cd packages/sdk-python && uv build --wheel --out-dir "$V"/dist)
  uv venv -q "$V"/venv && uv pip install -q --python "$V"/venv/bin/python "$V"/dist/hue_run-*.whl
  ```

- **Run it.** `"$V"/venv/bin/python examples/python-agent/main.py --capture-content yes`. Expected: `mode=synthetic trace_id=<32 hex> exported=true`, and the stub log gains `GET /api/v1/projects/current`, `POST /api/v1/otlp/v1/traces` and `POST /api/v1/otlp/v1/logs`, all 200 with `"bearer": true`.
- **Print the export evidence.** `cat "$V"/stub.log`.
- **Metadata only.** Rerun with `--capture-content no`. Expected: the same success line and a new traces POST.

## Gotchas

- Run with the venv's Python, not `uv run` in `packages/sdk-python`, or you test the source tree instead of the installed wheel.
- The stub refuses blob uploads with 404, so large content goes inline; that is expected.
