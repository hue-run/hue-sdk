# Python evaluation example

Install `hue-run` with its `evals` extra into a separate environment, then run this synthetic chatbot comparison against your Hue project. It creates a frozen three-case dataset, four versioned scorers, two experiments, and a historical scoring run through the public API. The two targets differ in capitalization; one case returns explicit JSON null and one raises a target error. Repeating each completed runner verifies that its target is not executed again.

```sh
python -m venv .venv && . .venv/bin/activate
pip install -r examples/python-evaluation/requirements.txt  # hue-run[evals]

# Set HUE_API_KEY (and HUE_BASE_URL for a deployment other than Hue Cloud) through your ignored environment or secret manager.
python examples/python-evaluation/main.py \
  --capture-content yes --persist-result-content yes \
  --checkpoint-directory .local/python-evaluation-checkpoints
```

Choose both content settings explicitly. `capture-content` controls telemetry helper content; `yes` records full traces, and `no` sends metadata only when a policy forbids sending that content. `persist-result-content` independently controls evaluation output and evidence storage, including checkpoint files. With result storage disabled, historical evaluators report unavailable output. Identifiers and typed metrics remain stored. The example prints only created IDs and counts and calls no model provider.

Checkpoint directories use private POSIX permissions. A crashed owner leaves `.lock`; confirm that it stopped before removing that lock. See the [runner contract](../../packages/sdk-python/EVALUATIONS.md) for retry and recovery semantics.
