---
name: verify-examples
description: "Verify a change to the runnable examples under examples/: the reference-chatbot (Node/Bun HTTP chat app on @hue-run/sdk), python-agent and python-evaluation. Use before opening a PR that touches examples/ or SDK behavior those examples show to users."
---

# Verify the examples

Examples are what users copy, so prove them the way a user runs them: install the SDK package, start the example in synthetic mode and send its export to a Hue endpoint. Here that endpoint is the loopback stub from [verify-sdk](../verify-sdk/SKILL.md), a fake Hue API that acknowledges everything, so no real key or model provider is involved. These are loopback-stub runs: they prove the example and the SDK's HTTP export, not acceptance by a real Hue backend. Say so in the PR.

## Launch

```sh
mkdir -p .context && export V=$(mktemp -d "$PWD/.context/verify-examples-XXXXXX")
.agents/skills/verify-sdk/scripts/stub-hue.py > "$V"/stub.log & echo $! > "$V"/stub.pid
sleep 1; export HUE_BASE_URL=$(head -1 "$V"/stub.log | python3 -c 'import json,sys;print(json.load(sys.stdin)["ready"])')
export HUE_API_KEY=synthetic-verify-key
```

Then follow the feature file for the example you changed.

## Doctor

`curl -s $HUE_BASE_URL/api/v1/projects/current` returns the synthetic project. `node -v` is 22.12+ for the chatbot; `uv --version` reports uv 0.12.5 for the Python examples.

## Drive

| Example | Narrowest proof | Time |
| --- | --- | --- |
| [python-agent](features/python-agent.md) | run `main.py` from an installed wheel against the stub | about 5 s |
| [reference-chatbot](features/reference-chatbot.md) | install the packed SDK, start the server, `curl` `/chat` | about 10 s |
| [python-evaluation](features/python-evaluation.md) | ruff + `--help` (needs a Hue project to run fully) | 2 s |
| Python examples lint | `ruff check` / `ruff format --check` on `examples/python-*` | 1 s |

## Evidence

Paste the example's own output (mode, trace ID, `exported=true` or the SSE events) and the stub's request lines for the same run. Text only; the chatbot page is not needed to prove a server change.

## Cleanup

Print the evidence first: `cat "$V"/stub.log` (and `cat "$V"/server.log` if you started the chatbot). Then `kill $(cat "$V"/stub.pid)`, `kill $(cat "$V"/server.pid)` if you started the chatbot, then keep the logs before removing the copies and venvs: `E="$V"-evidence && mkdir -p "$E" && cp "$V"/*.log "$E"/ && rm -rf "$V"`. All paths are absolute, so this works from any directory.
