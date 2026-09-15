# Python evaluation example

Install a built `hue-sdk` wheel into a separate environment, then run this synthetic chatbot comparison against your Hue project. It creates a frozen three-case dataset, four versioned scorers, two experiments, and a historical scoring run through the public API. The two targets differ in capitalization; one case returns explicit JSON null and one raises a target error. Repeating each completed runner verifies that its target is not executed again.

```sh
uv build packages/sdk-python --out-dir .local/python-eval-dist
uv venv .local/python-eval-consumer --python 3.14
uv pip install --python .local/python-eval-consumer/bin/python .local/python-eval-dist/hue_sdk-0.1.0-py3-none-any.whl

# Set HUE_BASE_URL and HUE_API_KEY through your ignored environment or secret manager.
.local/python-eval-consumer/bin/python examples/python-evaluation/main.py \
  --capture-content no --persist-result-content yes \
  --checkpoint-directory .local/python-evaluation-checkpoints
```

Choose both content settings explicitly. `capture-content` controls telemetry helper content; `persist-result-content` independently controls evaluation output and evidence storage, including checkpoint files. With result storage disabled, historical evaluators report unavailable output. Identifiers and typed metrics remain stored. The example prints only created IDs and counts and calls no model provider.

Checkpoint directories use private POSIX permissions. A crashed owner leaves `.lock`; confirm that it stopped before removing that lock. See the [runner contract](../../packages/sdk-python/EVALUATIONS.md) for retry and recovery semantics.
