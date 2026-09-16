---
name: hue
description: Add or troubleshoot Hue tracing in an existing application, preserving its provider, framework, and OpenTelemetry setup. Use when a developer asks to integrate Hue or verify that requests reach Hue.
metadata:
  author: hue-run
  version: "0.1.5"
---

# Hue tracing

Help the developer get an application request into Hue with useful parent/child spans and a verified capture policy. Keep the integration within their request: tracing does not imply permission to add evaluations, create credentials, deploy, or replace the application's model provider.

## Choose the integration

Read the application's repository instructions and inspect its runtime, dependency versions, request/stream lifecycle, and existing OpenTelemetry initialization. Keep the application's prompts, provider, outputs, and dependency versions unless the user requested a change. Use its package manager and existing secret workflow.

| Application | Path |
| --- | --- |
| Node.js 24, without existing OTel setup | [TypeScript SDK](https://docs.hue.run/sdks/typescript) |
| Python 3.10+ | [Python SDK](https://docs.hue.run/sdks/python) |
| Existing OTel provider or framework instrumentation | [OpenTelemetry integration](https://docs.hue.run/integrations/opentelemetry); retain the provider and other exporters |

Check [compatibility](https://docs.hue.run/sdks/compatibility) and the installed package's API before editing. Receipt helpers require TypeScript `0.1.3` or Python `0.1.1`; check package availability and release notes before using them. Read only the guide relevant to the application's stack. The [documentation index](https://docs.hue.run/llms.txt) helps find other supported integrations.

**Existing AI SDK 6:** the current Hue TypeScript package's optional AI SDK 7 peers conflict even with core-only imports. Preserve AI SDK 6 and use its standard OTLP exporter path; do not force dependency resolution or upgrade the app merely to install Hue. Direct OTLP does not need the Hue package or Hue helper methods.

## Install and configure

Use the current [installation guide](https://docs.hue.run/installation) and verify that the intended package version is published before installing it:

```sh
# TypeScript: run in the application directory.
npm install @hue-run/sdk
```

```sh
# Python: use the application's existing Python environment.
python -m pip install hue-run
```

Adapt the install command to the app's package manager, for example `uv add hue-run` for a uv project. For direct OTLP, use compatible standard exporters and the existing instrumentor instead. If a package is unavailable or credentials are missing, finish independently verifiable code changes and report the specific remaining requirement; do not invent a successful install or registry release.

The user creates their project service key in Hue under **Settings → Integrations & API keys** and configures `HUE_API_KEY` on the server. Read that setting from the application; never request the key in chat or put it in browser code, fixtures, committed files, or logs.

- **TypeScript:** pass `apiKey`, a stable `serviceName`, and explicit `captureContent` to `createHue`. Hue Cloud is the default; omit `baseUrl` for ordinary cloud use. `checkConnection()` verifies the key's project.
- **Python:** pass `api_key`, a stable `service_name`, and explicit `capture_content` to `Hue`. Hue Cloud is the default; omit `base_url` for ordinary cloud use. `validate_project()` verifies the key's project. Older Python `0.1.0.dev0` installations still require an explicit origin.
- **Direct OTLP:** configure `https://app.hue.run/api/v1/otlp/v1/traces` and, when needed, `/api/v1/otlp/v1/logs` with `Authorization: Bearer <project-service-key>`. These are full signal URLs for an OTLP HTTP exporter. `GET /api/v1/projects/current` with the same header optionally verifies the project without sending telemetry. Configure `service.name` on the existing provider resource.

SDK constructors do not automatically read environment variables. For another Hue deployment, use its configured origin. A custom SDK origin excludes API paths; the standard OTLP exporter needs its full signal endpoint. Never change the model provider's API base URL to Hue.

## Capture and instrumentation

Default to full-fidelity capture of the supported, available telemetry: explicitly set `captureContent: true` in TypeScript or `capture_content=True` in Python. Capture prompts/messages, responses, and tool arguments/results, plus available model/provider identifiers, provider-reported token usage, timing, errors, and existing session/user correlation. Honor a user's metadata-only choice and explicit application capture restrictions. Preserve configured redaction and credential filtering, and explain what content will be sent.

Python's setting covers Hue helpers, not third-party instrumentation; enable the chosen instrumentor's own input/output capture controls as well. Direct OTLP also requires explicit instrumentor capture settings. Python helpers record exception type and status but omit exception messages and stacks even with content capture enabled. Report unsupported or unavailable fields rather than bypassing SDK limits or inventing data.

Initialize one client or exporter per server lifecycle. For TypeScript helpers use `withSpan()` and `tool()`; for Python use the `span()`, `model()`, and `tool()` context managers. Instrument one real request path with model/tool children, preserve propagated parent context, and reuse the application's session identifier when available. These helpers do not proxy or automatically observe uninstrumented model calls. Record provider-reported usage; leave unknown token counts and costs absent.

For AI SDK 7, `hueTelemetry()` from `@hue-run/sdk/ai-sdk` provides per-call integrations. Those replace the global integrations for that call. If existing telemetry must keep receiving the call, follow the existing-provider guide and attach Hue's transport to that provider instead. Direct OTLP users keep their framework instrumentation without adding Hue wrappers.

Keep spans open until streamed work completes or aborts. A returned streaming `Response` is not generation completion. Use the framework's completion/background-lifetime hooks; see the [Next.js streaming recipe](https://docs.hue.run/integrations/opentelemetry#flush-streamed-responses-in-nextjs). Preserve application errors and cancellations while recording their span status. Add short comments where initialization, capture, or delivery behavior needs explanation.

## Verify delivery

Run the application's relevant checks and exercise the changed request path, including a controlled error. Use its existing test setup and a synthetic provider or loopback collector for automated verification; do not replace its production provider. A live model request requires an already authorized, configured test.

- **TypeScript:** await `flush()` after work completes; handle `HueExportError` and its delivery report. For a standalone script, await `shutdown()` in `finally`. Stop shared clients when the server stops, not after each request.
- **Python:** inspect the booleans from `force_flush()` and `shutdown()` and `export_status` on failure. Context-manager exit alone does not prove successful delivery.
- **Standard OTLP exporter:** inspect export failures and partial-rejection responses and keep the process alive until its flush completes.

Keep ownership of borrowed providers with the application. A TypeScript borrowed-provider client flushes but does not shut down those providers; at application shutdown, stop the providers and then its Hue transport. Do not repeatedly attach new Hue processors to a long-lived provider.

Record the actual application's OpenTelemetry trace ID and known request/model/tool span IDs. After their owning providers flush, use `hue.verifyTrace(traceId, { expectedSpanIds, requiredFields })` or Python `hue.verify_trace(trace_id, expected_span_ids=..., required_fields=...)` when available. Require only fields this request should emit; do not require usage the provider omits or content an explicit policy disables. The helper polls for stored evidence within 10 seconds by default (maximum 60 seconds), without implicitly flushing or generating substitute telemetry. A false result is incomplete verification; report missing spans/fields. Authentication, unavailable endpoint, and transport errors require fixing their cause, not claiming arrival. Existing direct-OTLP apps can use the same project-authenticated `GET /api/v1/traces/{otelTraceId}/receipt` with repeated `expectedSpanId` query parameters; do not install conflicting SDK dependencies for this check.

A receipt confirms stored field presence and the requested span IDs, not payload correctness or universal trace completeness. Inspect captured prompts/responses, tool inputs/outputs, redaction, timing and errors under **Traces** using the receipt's `traceUrl` when authorized. The service key does not provide general trace browsing; if UI access is unavailable, report the receipt evidence and leave content inspection to the user. Older SDKs or deployments require explicit UI verification; do not invent unsupported helper methods or call a connection check proof of ingestion.

Summarize the installed version, changed files, configuration names, capture policy, checks run, and delivery evidence. Separate locally tested behavior, collector acknowledgement, stored receipt evidence, and content inspected in Hue. State remaining access or verification steps without claiming success.
