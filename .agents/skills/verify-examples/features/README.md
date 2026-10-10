# Examples verification map

The maintained source for proving changes to `examples/`. Read this index, then use the matching feature file.

## Baseline preconditions

- Loopback stub running with `HUE_BASE_URL` and a synthetic `HUE_API_KEY` exported (skill Launch).
- Synthetic mode only. Never set `OPENAI_API_KEY`, `AI_GATEWAY_API_KEY` or a real Hue key for verification.

## Driving conventions

- Install the SDK from a locally built wheel or tarball, not from the registry, so the example runs your branch.
- Copies, venvs and logs go in `.context/verify-examples/`.

## Proof and skip reporting

- Proof is the example's output plus the stub's `POST /api/v1/otlp/v1/traces` line from the same run.
- Say so when an example needs a real Hue project (python-evaluation) and you only checked it statically.

## Features

- [reference-chatbot](./reference-chatbot.md): streaming chat, tool call, controlled error and telemetry acknowledgement.
- [python-agent](./python-agent.md): synthetic streamed model call, tool and handled tool failure.
- [python-evaluation](./python-evaluation.md): dataset, scorers, experiments and checkpoints through the evaluation API.
