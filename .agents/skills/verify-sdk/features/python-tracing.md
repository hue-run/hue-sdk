# Python tracing

An application opens `Hue(base_url, api_key, ...)`, records spans, model calls and tools, and `force_flush()` returns whether the export was acknowledged.

## Sub-features

- `py-span` records `span`, `model`, `tool` and `context` with input and output.
- `py-capture` honors `capture_content` and redaction before export.
- `py-ack` returns `force_flush()` and receipt results that match the receiver.

## How to get to it (user POV)

- `from hue_sdk import Hue` after `pip install hue-run` (packages/sdk-python/README.md).

## Driving it with uv and the loopback stub (fake Hue API)

Preconditions:

- `uv sync --frozen --all-groups` done in `packages/sdk-python`; stub running; `HUE_BASE_URL` exported.

- **Drive.** From `packages/sdk-python`:

  ```sh
  uv run --frozen --all-groups python -c '
  import os
  from hue_sdk import Hue
  with Hue(os.environ["HUE_BASE_URL"], "synthetic-verify-key", capture_content=True, service_name="verify-sdk") as hue:
      hue.validate_project()
      with hue.span("agent.run") as run:
          run.set_input({"q": "hello"}); run.set_output({"a": "HELLO"}); trace = run.trace_id
      print("trace_id", trace, "flushed", hue.force_flush())
  '
  cat $V/stub.log
  ```

  Expected: `trace_id <32 hex> flushed True`, and the stub logs `GET /api/v1/projects/current` and `POST /api/v1/otlp/v1/traces` with status 200.
- **Behavior test.** `uv run --frozen --all-groups pytest tests/test_sdk.py -q -k redact`. Expected: all selected tests pass in about 2 s.
- **Static checks** (3.5 s): `uv run --frozen --all-groups ruff check src tests && uv run --frozen --all-groups mypy`.

## Gotchas

- The Python version is independent of the TypeScript version (see `pyproject.toml`).
- `RUST_LOG=info` in the shell makes uv print resolver noise; ignore it or run `RUST_LOG= uv ...`.
- CI also runs Python 3.10. Mention it if your change touches syntax or typing that 3.10 lacks.
