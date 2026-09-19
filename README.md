<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/hue-ascii-dark.png">
  <source media="(prefers-color-scheme: light)" srcset=".github/assets/hue-ascii-light.png">
  <img alt="Hue" src=".github/assets/hue-ascii-neutral.png" width="720">
</picture>

# Hue SDK

OpenTelemetry tracing and local evaluation workflows for AI applications.

[![SDK checks](https://github.com/hue-run/hue-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/hue-run/hue-sdk/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/%40hue-run%2Fsdk?label=%40hue-run%2Fsdk)](https://www.npmjs.com/package/@hue-run/sdk) [![PyPI](https://img.shields.io/pypi/v/hue-run?label=hue-run)](https://pypi.org/project/hue-run/) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[Documentation](https://docs.hue.run) · [Sign in](https://app.hue.run) · [Examples](./examples) · [Compatibility](./COMPATIBILITY.md) · [Changelog](./CHANGELOG.md) · [Versioning](./VERSIONING.md) · [Contributing](./CONTRIBUTING.md) · [Security](./SECURITY.md)

Hue Cloud is currently invite-only; to request access, email [team@hue.run](mailto:team@hue.run). Tracing works without an account against any OTLP receiver; only the Hue-specific connection check, trace receipts and hosted evaluations need a project. See "Local development without a Hue account" in the [TypeScript](./packages/sdk-typescript/README.md#local-development-without-a-hue-account) and [Python](./packages/sdk-python/README.md#local-development-without-a-hue-account) guides.

</div>

## Why Hue

- **Standard OpenTelemetry, nothing proprietary.** Traces and correlated logs travel as OTLP/HTTP to documented endpoints. Any OpenTelemetry-emitting language or instrumentor works without a Hue package, and Hue never replaces your global providers.
- **Explicit content policy.** `captureContent` / `capture_content` is a required choice. Metadata-only mode strips recognized GenAI, OpenInference, OpenLLMetry and Vercel AI SDK content fields at export time in both SDKs, and a redaction hook runs over the rest.
- **Fail-open by contract.** Safe constructors, byte- and record-bounded queues, cumulative loss counters and bounded lifecycle deadlines are written down in [RELIABILITY.md](./RELIABILITY.md) and tested against the installed packages.
- **Provable delivery.** `verifyTrace()` / `verify_trace()` confirm that a real request's spans and fields were stored, without exposing content.
- **Small, auditable footprint.** The tracing core depends only on official OpenTelemetry packages (plus `requests` in Python), and the JSON Schema validator used by the evaluation scorers is an opt-in extra. Releases are built once, hash-verified, published through OIDC trusted publishing and re-verified from the registries.

## Choose your SDK

| Language | Package / imports | Runtime | Guide |
| --- | --- | --- | --- |
| TypeScript / JavaScript | `@hue-run/sdk`, `@hue-run/sdk/ai-sdk`, `@hue-run/sdk/evals`, `@hue-run/sdk/environment`, `@hue-run/sdk/managed` | Node.js 22 or 24 (26 in CI); Bun 1.4.2 | [Tracing](./packages/sdk-typescript/README.md) · [Evaluations](./packages/sdk-typescript/EVALUATIONS.md) · [Simulated environments](./packages/sdk-typescript/ENVIRONMENTS.md) |
| Python | `hue-run`; `hue_sdk`, `hue_sdk.evals`, `hue_sdk.managed` | Python 3.10+; tested on 3.10 and 3.14 | [Tracing](./packages/sdk-python/README.md) · [Evaluations](./packages/sdk-python/EVALUATIONS.md) |
| Any other language | The official OpenTelemetry SDK with an OTLP/HTTP exporter | Go, Java, .NET, Rust, Ruby and others | [Existing OpenTelemetry](https://docs.hue.run/integrations/opentelemetry) |

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

See [compatibility](https://docs.hue.run/sdks/compatibility) before adding Hue to an application with existing OpenTelemetry or AI SDK dependencies. Contributors can also [build and verify from a checkout](#build-and-verify-from-a-standalone-clone).

## What you can do

- Record requests, model calls, tools, errors and sessions using standard OTLP.
- Choose content capture or metadata only, and inspect export failures.
- Preserve an existing OpenTelemetry provider and its other exporters.
- Confirm stored traces, known child spans, and required field presence after export.
- Run local evaluation targets and scorers against frozen datasets.
- Resume result uploads and rescore stored outputs without rerunning the target.
- Run an existing local agent callback against a fresh hosted simulated world.

This source tree prepares the TypeScript `0.3.0` release candidate with the provider-aware
`runLocalAgent()` worker and V2 environment definitions. Until registry acceptance, test it only
from the exact reviewed `hue-run-sdk-0.3.0.tgz` archive; the registry-published TypeScript package
remains `0.2.2`.
Python remains at `0.2.2` and does not include a native local-worker API. Public package tests
exercise local control-plane fixtures and do not call an issued provider facade or official
provider data plane.

Your application runs the model or agent. Instrumentation must emit telemetry; the SDK cannot observe uninstrumented provider calls. Neither SDK estimates missing token usage or cost.

## Send a trace

After installing the TypeScript SDK above, set `HUE_API_KEY` to a project service key in your server environment. Save the following as `first-trace.mjs` and run `node first-trace.mjs`; the [quickstart](https://docs.hue.run/quickstart) walks through the same steps in more detail. Choose content capture explicitly:

```js
import { createHue } from "@hue-run/sdk";

const hue = createHue({
  apiKey: process.env.HUE_API_KEY,
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

The default destination is `https://app.hue.run`. Metadata-only mode omits the input/output text above. The [tracing guide](./packages/sdk-typescript/README.md) covers capture, redaction, borrowed providers, streaming and shutdown.

No Hue project yet? Request access at [team@hue.run](mailto:team@hue.run), or run the same script against a local OpenTelemetry Collector by setting `baseUrl` as described in [Local development without a Hue account](./packages/sdk-typescript/README.md#local-development-without-a-hue-account); `checkConnection()` is a Hue-only diagnostic, so remove that call when the receiver is a generic collector.

For Python, use the installation instructions above and follow the [complete Python example](./packages/sdk-python/README.md).

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

For production request handlers, follow [production safety](https://docs.hue.run/guides/production-safety). The strict setup example above intentionally exposes delivery failures.

The [tracing reliability contract](./RELIABILITY.md) maps failure isolation and resource limits to regression tests and application acceptance checks.

## Try the examples

| Example | What it verifies |
| --- | --- |
| [Reference chatbot](./examples/reference-chatbot) | Streaming, a real tool, controlled errors, session grouping and explicit content policies. Synthetic mode needs no model credits. |
| [Python agent](./examples/python-agent) | Public wheel imports, model/tool spans, correlated logs and optional instrumented OpenAI calls. |
| [Python evaluation](./examples/python-evaluation) | Frozen datasets, local targets/scorers, resumable uploads and historical rescoring. |

For applications that already use OpenTelemetry, follow the [existing-provider guide](https://docs.hue.run/integrations/opentelemetry), including its Next.js streaming recipe.

## Build and verify from a standalone clone

Use Node 24, Bun 1.4.2 and uv 0.12.5. No Hue account or API key is needed; every check runs against synthetic providers and loopback receivers.

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

## Scope and non-goals

Hue's SDKs are deliberately small. The following are design choices, not missing features:

- No bundled provider auto-instrumentation and no per-framework adapters beyond the AI SDK 7 helper. Use the provider's or framework's own OpenTelemetry export (OpenInference, OpenLLMetry, native OTel) and configure its content controls; Hue recognizes those conventions.
- No native SDKs beyond TypeScript and Python. Other languages use the official OpenTelemetry SDK pointed at Hue's OTLP endpoints.
- No proprietary event protocol, live token streaming, attachments or feature-flag API. Spans are exported when they complete; use standard attributes and span events.
- No browser or edge builds: the project service key is a server-side credential. There is no separate CommonJS build; Node.js 22.12 or later loads the ESM build from `require()`.
- Constructors never read Hue settings (key, endpoint, capture policy, budgets) from environment variables, and the TypeScript SDK does not read `OTEL_RESOURCE_ATTRIBUTES` either. No token-cost estimation, no prompt management, no built-in PII pattern presets and no local trace viewer. Redaction is a hook you supply; an OpenTelemetry Collector covers organization-wide redaction, buffering and local viewing.
- Project service keys are preset-scoped. **Tracing only** sends telemetry and reads delivery receipts; **Tracing and evaluations** also authorizes the evaluation, artifact and simulation APIs used by the optional clients. Neither preset grants general trace browsing: use the Hue app, or the [Hue MCP server](https://docs.hue.run/agents/mcp-server) with a separate **Coding agent (read-only)** key. These SDKs do not attach feedback or scores to stored traces. TypeScript's explicit `runSimulation()` helper orchestrates versioned simulation resources; it does not grant general read access or hide provider execution.

See [VERSIONING.md](./VERSIONING.md) for what may change between releases.

## Compatibility and limits

TypeScript uses compatible-major peers for AI SDK 7 and its OTel integration. The two patch pairs above are tested; other combinations are not individually certified. Core-only installation can coexist with AI SDK 6; the `hueTelemetry` adapter remains AI SDK 7 only. Existing OTel applications can use a standard OTLP exporter directly without this package. See [compatibility](./COMPATIBILITY.md) before changing application dependencies.

Python's optional OpenInference/OpenAI pair is pinned in its lockfile and tested separately. Python helper capture controls and TypeScript export filtering have different scopes; the package guides describe them explicitly.

Queues are bounded and in memory. Await flush and inspect its result; your application finishing normally does not prove that its telemetry was delivered. Hosted model-graded scoring, trace storage and rendering, and scheduled evaluation runs are features of the Hue platform, not of these SDKs.

After a real request and its exporter flush, `verifyTrace()` / `verify_trace()` can confirm stored evidence using that request's OpenTelemetry IDs. Require the fields and spans that request should emit; verification does not generate a replacement test trace or inspect content correctness. See the [TypeScript receipt guide](./packages/sdk-typescript/README.md#verify-a-stored-application-trace) or [Python guide](./packages/sdk-python/README.md).

## Repository history

The SDKs were extracted from Hue's application monorepo at TypeScript 0.1.1 / Python 0.1.0.dev0, the pre-publication pilot builds. This repository contains only the SDKs, standalone examples and the coding-agent skill, with no application source. The project currently has one maintainer; every change lands through a pull request whose CI runs the installed-package suites on Node 22, 24 and 26, Bun 1.4.2 and Python 3.10 and 3.14.

## License

This repository and the SDK packages are distributed under the [MIT license](./LICENSE). Contributions are accepted under the same license; see [Contributing](./CONTRIBUTING.md).

<details>
<summary>Hue ASCII wordmark (plain text)</summary>

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

</details>
