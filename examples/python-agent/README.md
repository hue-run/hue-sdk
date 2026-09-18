# Python reference agent

This small application imports only the installed `hue_sdk` public package. It produces an explicitly synthetic streamed model response, a tool execution and a handled tool failure. It uses both OTLP traces and correlated inference logs. It does not import Hue application internals or access a database.

Build/install the wheel using [SDK instructions](../../packages/sdk-python/README.md), then set `HUE_BASE_URL` and `HUE_API_KEY` in your environment without committing their values:

```sh
.local/python-sdk-consumer/bin/python examples/python-agent/main.py --capture-content yes
```

Choose `--capture-content no` for metadata only. The application validates its project first and exits unsuccessfully if export fails. Its output labels the mode and trace ID; it never prints a key or model content. Synthetic mode reports no token usage because it has no provider-reported usage.

## Optional real-provider smoke

Install the official `openai==3.14.0` client into your consumer environment, set `OPENAI_API_KEY` and an explicitly selected `OPENAI_MODEL`, then run:

```sh
.local/python-sdk-consumer/bin/python examples/python-agent/main.py --mode openai --capture-content yes
```

This performs a real streaming request with a 64-token completion cap and records provider-reported usage if present. Missing configuration and provider errors fail the run; there is no synthetic fallback. It may incur provider charges. No real-provider request is part of the deterministic acceptance suite, and this path has not been validated against a live model in this change. The SDK itself does not depend on the OpenAI client.
