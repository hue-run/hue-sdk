```text
          _____                    _____                    _____          
         /\    \                  /\    \                  /\    \         
        /::\____\                /::\____\                /::\    \        
       /:::/    /               /:::/    /               /::::\    \       
      /:::/    /               /:::/    /               /::::::\    \      
     /:::/    /               /:::/    /               /:::/\:::\    \     
    /:::/____/               /:::/    /               /:::/__\:::\    \    
   /::::\    \              /:::/    /               /::::\   \:::\    \   
  /::::::\    \   _____    /:::/    /      _____    /::::::\   \:::\    \  
 /:::/\:::\    \ /\    \  /:::/____/      /\    \  /:::/\:::\   \:::\    \ 
/:::/  \:::\    /::\____\|:::|    /      /::\____\/:::/__\:::\   \:::\____\
\::/    \:::\  /:::/    /|:::|____\     /:::/    /\:::\   \:::\   \::/    /
 \/____/ \:::\/:::/    /  \:::\    \   /:::/    /  \:::\   \:::\   \/____/ 
          \::::::/    /    \:::\    \ /:::/    /    \:::\   \:::\    \     
           \::::/    /      \:::\    /:::/    /      \:::\   \:::\____\    
           /:::/    /        \:::\__/:::/    /        \:::\   \::/    /    
          /:::/    /          \::::::::/    /          \:::\   \/____/     
         /:::/    /            \::::::/    /            \:::\    \         
        /:::/    /              \::::/    /              \:::\____\        
        \::/    /                \::/____/                \::/    /        
         \/____/                  ~~                       \/____/          
```

# Hue SDK

OpenTelemetry tracing and local evaluation workflows for AI applications.

[Documentation](https://docs.hue.run) · [Open Hue](https://app.hue.run) · [Examples](./examples) · [Contributing](./CONTRIBUTING.md)

[![SDK checks](https://github.com/hue-run/hue-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/hue-run/hue-sdk/actions/workflows/ci.yml)

> npm and PyPI installs are coming soon. During the private pilot, use the release archives below.

## Choose your SDK

| Language | Package / imports | Runtime | Guide |
| --- | --- | --- | --- |
| TypeScript / JavaScript | `@hue/sdk`, `@hue/sdk/ai-sdk`, `@hue/sdk/evals` | Node.js 24; Bun 1.3.9 for development | [Tracing](./packages/sdk-typescript/README.md) · [Evaluations](./packages/sdk-typescript/EVALUATIONS.md) |
| Python | `hue-sdk`; `hue_sdk`, `hue_sdk.evals` | Python 3.10+; tested on 3.10 and 3.14 | [Tracing](./packages/sdk-python/README.md) · [Evaluations](./packages/sdk-python/EVALUATIONS.md) |

## For coding agents

The portable [Hue skill](./skills/hue/SKILL.md) helps Codex, Claude Code, Cursor, and other compatible agents inspect your app, integrate tracing, and verify delivery. It preserves your existing model provider and OpenTelemetry setup. It uses the [Agent Skills format](https://agentskills.io/specification), with its version recorded in the skill metadata.

Install it in your application directory with the [skills CLI](https://github.com/vercel-labs/skills):

```sh
npx skills add hue-run/hue-sdk --skill hue
```

The repository is private, so your Git or GitHub CLI authentication must have access. The CLI lets you choose your agent and installs into the current project; no Hue API key is needed to install the skill. The repository command uses the default branch. To try an unmerged skill change, install from that branch's local checkout instead:

```sh
npx skills add /path/to/hue-sdk --skill hue
```

Then ask your coding agent:

```text
Use the Hue skill to add tracing to this application. Preserve its behavior and
existing telemetry, start with metadata-only capture, and verify delivery.
Tell me what you changed, tested, and still need me to configure.
```

You configure your project service key through your application's secret workflow; do not paste it into the agent chat. The skill can prepare and locally test the integration before the key is available. See [For agents](https://docs.hue.run/guides/agent-setup) for the documentation handoff.

## Install

### Registry installs (coming soon)

Python:

```bash
pip install hue-sdk
```

TypeScript / JavaScript:

```bash
npm install @hue/sdk
```

### From a private GitHub release — available now

Use the GitHub CLI authenticated to an account with access to `hue-run/hue-sdk`. Run the matching commands in your application directory; Python users should activate their Python 3.10+ environment first.

Python:

```bash
gh release download python-v0.1.0.dev0 --repo hue-run/hue-sdk --pattern 'hue_sdk-0.1.0.dev0-py3-none-any.whl' --dir .hue-sdk/python
pip install ./.hue-sdk/python/hue_sdk-0.1.0.dev0-py3-none-any.whl
```

TypeScript / JavaScript:

```bash
gh release download typescript-v0.1.1 --repo hue-run/hue-sdk --pattern 'hue-sdk-0.1.1.tgz' --dir .hue-sdk/typescript
npm install ./.hue-sdk/typescript/hue-sdk-0.1.1.tgz @opentelemetry/api@1.9.1
```

These install the existing [Python](https://github.com/hue-run/hue-sdk/releases/tag/python-v0.1.0.dev0) and [TypeScript](https://github.com/hue-run/hue-sdk/releases/tag/typescript-v0.1.1) pilot assets without cloning the repository. You can also [build from a checkout](#build-and-verify-from-a-standalone-clone).

## What you can do

- Record requests, model calls, tools, errors and sessions using standard OTLP.
- Choose content capture or metadata only, and inspect export failures.
- Preserve an existing OpenTelemetry provider and its other exporters.
- Run local evaluation targets and scorers against frozen datasets.
- Resume result uploads and rescore stored outputs without rerunning the target.

Your application runs the model or agent. Instrumentation must emit telemetry; the SDK cannot observe uninstrumented provider calls. Neither SDK estimates missing token usage or cost.

## Send a trace

After installing the TypeScript SDK above, set `HUE_API_KEY` to a project service key in your server environment. Choose content capture explicitly:

```typescript
import { createHue } from "@hue/sdk";

const hue = createHue({
  apiKey: process.env.HUE_API_KEY!,
  serviceName: "my-agent",
  captureContent: false,
});

try {
  await hue.checkConnection();
  await hue.withSpan("chat", async (span) => {
    const output = await hue.tool("uppercase", "hello", () => "HELLO");
    span.setOutput(output);
    console.log({ output, traceId: span.traceId });
  }, { sessionId: "demo-session", input: "hello" });
  await hue.flush();
} finally {
  await hue.shutdown();
}
```

The default destination is `https://app.hue.run`. Metadata-only mode omits the input/output text above. The tracing guide covers capture, redaction, borrowed providers, streaming and shutdown.

For Python, use the installation instructions above and follow the [complete Python example](./packages/sdk-python/README.md).

## Try the examples

| Example | What it verifies |
| --- | --- |
| [Reference chatbot](./examples/reference-chatbot) | Streaming, a real tool, controlled errors, session grouping and explicit content policies. Synthetic mode needs no model credits. |
| [Python agent](./examples/python-agent) | Public wheel imports, model/tool spans, correlated logs and optional instrumented OpenAI calls. |
| [Python evaluation](./examples/python-evaluation) | Frozen datasets, local targets/scorers, resumable uploads and historical rescoring. |

For applications that already use OpenTelemetry, such as the separate [X Research Docs chatbot](https://github.com/hue-run/tester-agent-xdotcom-docs), follow the [existing-provider guide](https://docs.hue.run/integrations/opentelemetry), including its Next.js streaming recipe.

## Build and verify from a standalone clone

Use Node 24, Bun 1.3.9 and uv 0.12.5. No Fern checkout, app database or management credentials are needed.

```bash
node packages/sdk-typescript/scripts/verify-package.mjs
```

This builds a tarball, installs it into independent consumers, runs the exporter/evaluation tests with AI SDK / OTel pairs `7.0.99 / 1.0.99` and `7.0.100 / 1.0.100`, then builds and exercises the reference chatbot under Node. It prints the tested archive and consumer locations.

```bash
cd packages/sdk-python
uv sync --frozen --all-groups --python 3.14
uv run --frozen --all-groups --python 3.14 pytest
uv run --frozen --all-groups --python 3.14 ruff check src tests ../../examples/python-agent ../../examples/python-evaluation
uv run --frozen --all-groups --python 3.14 python -m build --no-isolation
```

CI also verifies Python 3.10. [Release instructions](./RELEASING.md) describe private archives and the separate public publication step.

## Compatibility and limits

TypeScript uses compatible-major peers for AI SDK 7 and its OTel integration. The two patch pairs above are tested; other combinations are not individually certified. Python's optional OpenInference/OpenAI pair is pinned in its lockfile and tested separately.

Queues are bounded and in memory. Await flush and inspect its result; successful application execution does not prove telemetry delivery. Hosted judges, storage/rendering and production scheduler activation belong to the Hue platform and have separate readiness requirements.

## Repository history

The initial SDK snapshot is recorded in [.source.json](./.source.json). This repository contains only SDKs and standalone examples, with no application source or inherited Fern Git history. Keep SDK changes reviewed here; updating any retained Fern copy is an explicit synchronization step.

Public registry publication, repository visibility and an open-source license are separate release decisions. The current packages remain private/unlicensed.
