# Python evaluation

`examples/python-evaluation/main.py` uses `hue_sdk.evals` to create a frozen three-case dataset, four scorers, two experiments and a historical scoring run through the evaluation API, with checkpoints in a private directory. It calls no model provider.

## Sub-features

- `eval-dataset` creates the dataset and scorers.
- `eval-experiments` runs two local targets, including a JSON null and a target error, and checks that a completed runner does not rerun its target.
- `eval-checkpoints` writes and resumes checkpoint files.

## How to get to it (user POV)

- `pip install -r examples/python-evaluation/requirements.txt`, then `python examples/python-evaluation/main.py --capture-content yes --persist-result-content yes --checkpoint-directory <dir>`.

## Driving it with ruff and the evaluation tests

Preconditions:

- `uv sync --frozen --all-groups` done in `packages/sdk-python`.

- **Static** (about 1 s). `cd packages/sdk-python && uv run --frozen --all-groups ruff check ../../examples/python-evaluation && uv run --frozen --all-groups ruff format --check ../../examples/python-evaluation`. Expected: `All checks passed!` and `2 files already formatted`.
- **Arguments** (about 1 s). `uv run --frozen --all-groups python ../../examples/python-evaluation/main.py --help`. Expected: usage listing `--capture-content`, `--persist-result-content` and `--checkpoint-directory`.
- **Runner behavior.** The APIs the example calls are covered by `uv run --frozen --all-groups pytest tests/test_evaluations.py -q -k <name>` against loopback evaluation receivers (see [verify-sdk evaluations](../../verify-sdk/features/evaluations.md)).

## Gotchas

- The loopback stub does not implement evaluation routes, so a full run needs a real Hue project key. That is a maintainer step, not PR verification; say so in the PR when you change this example.
- The example writes to `--checkpoint-directory`; point it into `$V/`.
