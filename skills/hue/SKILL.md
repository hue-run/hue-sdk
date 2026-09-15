---
name: hue
description: Add or troubleshoot Hue tracing in an existing application, preserving its provider, framework, and OpenTelemetry setup. Use when a developer asks to integrate Hue or verify that requests reach Hue.
metadata:
  author: hue-run
  version: "0.1.3"
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

Check [compatibility](https://docs.hue.run/sdks/compatibility) and the installed package's API before editing. This skill targets TypeScript `0.1.2` and Python `0.1.0`; check release notes when using a newer package. Read only the guide relevant to the application's stack. The [documentation index](https://docs.hue.run/llms.txt) helps find other supported integrations.

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

Use metadata-only capture (`false` / `False`) unless the user has chosen content capture. Explain what will be recorded. Python's setting covers Hue helpers, not third-party instrumentation; configure that instrumentor's own input/output capture controls. Direct OTLP also requires explicit instrumentor capture settings. Custom attributes, span names, and session/user identifiers can contain sensitive data even when helper content capture is disabled.

Initialize one client or exporter per server lifecycle. For TypeScript helpers use `withSpan()` and `tool()`; for Python use the `span()`, `model()`, and `tool()` context managers. Instrument one real request path with model/tool children, preserve propagated parent context, and reuse the application's session identifier when available. These helpers do not proxy or automatically observe uninstrumented model calls. Record provider-reported usage; leave unknown token counts and costs absent.

For AI SDK 7, `hueTelemetry()` from `@hue-run/sdk/ai-sdk` provides per-call integrations. Those replace the global integrations for that call. If existing telemetry must keep receiving the call, follow the existing-provider guide and attach Hue's transport to that provider instead. Direct OTLP users keep their framework instrumentation without adding Hue wrappers.

Keep spans open until streamed work completes or aborts. A returned streaming `Response` is not generation completion. Use the framework's completion/background-lifetime hooks; see the [Next.js streaming recipe](https://docs.hue.run/integrations/opentelemetry#flush-streamed-responses-in-nextjs). Preserve application errors and cancellations while recording their span status. Add short comments where initialization, capture, or delivery behavior needs explanation.

## Verify delivery

Run the application's relevant checks and exercise the changed request path, including a controlled error. Use its existing test setup and a synthetic provider or loopback collector for automated verification; do not replace its production provider. A live model request requires an already authorized, configured test.

- **TypeScript:** await `flush()` after work completes; handle `HueExportError` and its delivery report. For a standalone script, await `shutdown()` in `finally`. Stop shared clients when the server stops, not after each request.
- **Python:** inspect the booleans from `force_flush()` and `shutdown()` and `export_status` on failure. Context-manager exit alone does not prove successful delivery.
- **Standard OTLP exporter:** inspect export failures and partial-rejection responses and keep the process alive until its flush completes.

Keep ownership of borrowed providers with the application. A TypeScript borrowed-provider client flushes but does not shut down those providers; at application shutdown, stop the providers and then its Hue transport. Do not repeatedly attach new Hue processors to a long-lived provider.

Record the trace ID. Verify the request and child spans, error status, and capture policy under **Traces** in the project returned by the connection check. An exporter acknowledgement is not proof that the UI has the complete trace. The service key does not provide general trace browsing; if authorized UI access is unavailable, give the user the trace ID and specific checks to complete.

Summarize the installed version, changed files, configuration names, capture policy, checks run, and delivery evidence. Separate locally tested behavior, collector acknowledgement, and a trace inspected in Hue. State remaining access or verification steps without claiming success.
