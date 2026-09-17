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

_Hue (hue.run) is a tracing and evaluation platform for AI agents. It is not affiliated with Philips Hue / Signify smart lighting or Cloudera Hue._

[Documentation](https://docs.hue.run) · [Open Hue](https://app.hue.run) · [Examples](./examples) · [Compatibility](./COMPATIBILITY.md) · [Changelog](./CHANGELOG.md) · [Versioning](./VERSIONING.md) · [Contributing](./CONTRIBUTING.md) · [Security](./SECURITY.md)

[![SDK checks](https://github.com/hue-run/hue-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/hue-run/hue-sdk/actions/workflows/ci.yml)

## Choose your SDK

| Language | Package / imports | Runtime | Guide |
| --- | --- | --- | --- |
| TypeScript / JavaScript | `@hue-run/sdk`, `@hue-run/sdk/ai-sdk`, `@hue-run/sdk/evals` | Node.js 24; Bun 1.3.9 for development | [Tracing](./packages/sdk-typescript/README.md) · [Evaluations](./packages/sdk-typescript/EVALUATIONS.md) |
| Python | `hue-run`; `hue_sdk`, `hue_sdk.evals` | Python 3.10+; tested on 3.10 and 3.14 | [Tracing](./packages/sdk-python/README.md) · [Evaluations](./packages/sdk-python/EVALUATIONS.md) |

## For coding agents

The portable [Hue skill](./skills/hue/SKILL.md) helps Codex, Claude Code, Cursor, and other compatible agents inspect your app, integrate tracing, and verify delivery. It preserves your existing model provider and OpenTelemetry setup. It uses the [Agent Skills format](https://agentskills.io/specification), with its version recorded in the skill metadata.

Install it in your application directory with the [skills CLI](https://github.com/vercel-labs/skills):

```sh
npx skills add hue-run/hue-sdk --skill hue
```

The CLI lets you choose your agent and installs into the current project; no Hue API key is needed to install the skill. The repository command uses the default branch. To try an unmerged skill change, install from that branch's local checkout instead:

```sh
npx skills add /path/to/hue-sdk --skill hue
```

Then ask your coding agent:

```text
Use the Hue skill to add tracing to this application. Preserve its behavior and
existing telemetry. Start with metadata-only capture unless our team has approved
content capture. Preserve redaction and use safe initialization, bounded lifecycle
methods and a kill switch. Test collector outages and verify a real trace in Hue. Tell me what you changed and still need me to configure.
```

You configure your project service key through your application's secret workflow; do not paste it into the agent chat. The skill can prepare and locally test the integration before the key is available. See [For agents](https://docs.hue.run/guides/agent-setup) for the documentation handoff.

For production request handlers, follow [production safety](https://docs.hue.run/guides/production-safety). The strict setup examples below intentionally expose delivery failures.

The [tracing reliability contract](./RELIABILITY.md) maps failure isolation and resource limits to regression tests and application acceptance checks.

## Install

Python:

```bash
pip install hue-run
# Or, in a uv project:
uv add hue-run
```

TypeScript / JavaScript:

```bash
npm install @hue-run/sdk
# Or, with Bun:
bun add @hue-run/sdk
```

See [compatibility](https://docs.hue.run/sdks/compatibility) before adding Hue to an application with existing OpenTelemetry or AI SDK dependencies. Package installation does not require access to the source repository. Contributors can also [build and verify from a checkout](#build-and-verify-from-a-standalone-clone).

## What you can do

- Record requests, model calls, tools, errors and sessions using standard OTLP.
- Choose content capture or metadata only, and inspect export failures.
- Preserve an existing OpenTelemetry provider and its other exporters.
- Confirm stored traces, known child spans, and required field presence after export.
- Run local evaluation targets and scorers against frozen datasets.
- Resume result uploads and rescore stored outputs without rerunning the target.

Your application runs the model or agent. Instrumentation must emit telemetry; the SDK cannot observe uninstrumented provider calls. Neither SDK estimates missing token usage or cost.

## Send a trace

After installing the TypeScript SDK above, set `HUE_API_KEY` to a project service key in your server environment. Choose content capture explicitly:

```typescript
import { createHue } from "@hue-run/sdk";

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
  await hue.shutdownSafe();
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

For applications that already use OpenTelemetry, follow the [existing-provider guide](https://docs.hue.run/integrations/opentelemetry), including its Next.js streaming recipe.

## Build and verify from a standalone clone

Use Node 24, Bun 1.3.9 and uv 0.12.5. No Hue application checkout, database or management credentials are needed.

```bash
node packages/sdk-typescript/scripts/verify-package.mjs
```

This builds a tarball, installs it into independent consumers, runs the exporter/evaluation tests with AI SDK / OTel pairs `7.0.99 / 1.0.99` and `7.0.100 / 1.0.100`, then builds and exercises the reference chatbot under Node. It prints the tested archive and consumer locations.

```bash
cd packages/sdk-python
uv sync --frozen --all-groups --python 3.14
uv run --frozen --all-groups --python 3.14 pytest
uv run --frozen --all-groups --python 3.14 ruff check src tests ../../examples/python-agent ../../examples/python-evaluation
uv run --frozen --all-groups --python 3.14 ruff format --check src tests ../../examples/python-agent ../../examples/python-evaluation
uv run --frozen --all-groups --python 3.14 mypy
uv run --frozen --all-groups --python 3.14 python -m build --no-isolation
```

Lint and formatting for the TypeScript sources run from the repository root with the pinned tooling in `package.json`:

```bash
bun install --frozen-lockfile
bun run lint
bun run format:check
```

CI also verifies Python 3.10. [Release instructions](./RELEASING.md) describe verified archives, registry publishing and release checks.

## Compatibility and limits

TypeScript uses compatible-major peers for AI SDK 7 and its OTel integration. The two patch pairs above are tested; other combinations are not individually certified. Core-only installation can coexist with AI SDK 6; the `hueTelemetry` adapter remains AI SDK 7 only. Existing OTel applications can use a standard OTLP exporter directly without this package. See [compatibility](./COMPATIBILITY.md) before changing application dependencies.

Python's optional OpenInference/OpenAI pair is pinned in its lockfile and tested separately. Python helper capture controls and TypeScript export filtering have different scopes; the package guides describe them explicitly.

Queues are bounded and in memory. Await flush and inspect its result; successful application execution does not prove telemetry delivery. Hosted judges, storage/rendering and production scheduler activation belong to the Hue platform and have separate readiness requirements.

After a real request and its exporter flush, `verifyTrace()` / `verify_trace()` can confirm stored evidence using that request's OpenTelemetry IDs. Require the fields and spans that request should emit; verification does not generate a replacement test trace or inspect content correctness. See the [TypeScript receipt guide](./packages/sdk-typescript/README.md#verify-a-stored-application-trace) or [Python guide](./packages/sdk-python/README.md).

## Repository history

The SDKs were extracted from Hue's application monorepo at TypeScript 0.1.1 / Python 0.1.0.dev0, the pre-publication pilot builds. This repository contains only the SDKs, standalone examples and the coding-agent skill, with no application source. All SDK changes are reviewed here.

## License

This repository and the SDK packages are distributed under the [MIT license](./LICENSE). Contributions are accepted under the same license; see [Contributing](./CONTRIBUTING.md).
