# Tracing reliability contract

Optional tracing must preserve the application's result, original exception or cancellation, and number of business operations when Hue is unavailable. Losing telemetry is preferable to blocking an agent or repeating a tool. This contract covers Hue's supported tracing helpers, owned processors and transports; evaluation and managed-target APIs perform requested business operations and have their own failure contracts.

## Design and regression evidence

| Requirement | Implementation and verification |
| --- | --- |
| No network dependency in the serving path | Helpers enqueue completed telemetry; export runs in the background. Use `createHueSafe` / `create_hue_safe`. Keep strict connection, receipt and delivery checks in a separate diagnostic command. |
| Preserve application behavior | Capture, redactor, span setup/end and diagnostic failures are contained. Tests assert callback count, object/result identity and original exceptions. Python cancellation and process-control exceptions follow Python semantics. |
| Bound retained work | Both signals have record and byte budgets that include in-flight telemetry. Overflow is observable loss. Snapshots detach supported values and bound traversal before encoding; later mutations cannot grow queued payloads. JavaScript Proxies are rejected before invoking their traps; typed-byte sizes use intrinsic accessors and a fixed-size copy prevents concurrent shared-buffer growth bypassing the budget. |
| Prevent self-instrumentation | Export work suppresses OpenTelemetry instrumentation. Python explicitly propagates suppression into its HTTP worker; regressions exercise a self-instrumenting export and recovery. Existing global providers and application context remain owned by the application. |
| Bound outage behavior | Export deadlines, bounded acknowledgements and bounded network workers prevent unbounded retry/response accumulation. Retry only telemetry. Python retains later queued records while its single HTTP worker per signal is occupied, and does not replay an ambiguously timed-out batch. |
| Bound lifecycle waits | Safe flush/shutdown return a failure result within the configured caller wait budget. Python signals share the remaining deadline and release drain coordination when it expires. Repeated shutdown calls report current failures and late-record drops. A timeout does not cancel a borrowed provider or prove delivery. Initialize Python after fork. |
| Make loss visible without leaking content | Failure/drop counters are cumulative; pending counters are gauges. Diagnostics omit rejected content and credentials, are rate-limited and contain callback failures. Send health counters through an independent monitoring channel. |
| Keep capture deliberate | Capture is an explicit choice: content capture is recommended, and metadata-only is the opt-out when a policy forbids sending content. Detached Python redactor inputs cannot mutate business arguments. External instrumentors, custom attributes and other exporters need their own capture policy. |

Behavioral evidence lives in [`sdk.test.ts`](packages/sdk-typescript/tests/sdk.test.ts), the installed-Node [`verify-safety.mjs`](packages/sdk-typescript/scripts/verify-safety.mjs), and Python's [`test_isolation.py`](packages/sdk-python/tests/test_isolation.py). Package verification runs the behavioral suite and the reference chatbot under both Node and Bun 1.4.2; the resource-bound checks in `verify-safety.mjs` (V8 heap flags, worker memory limits, export-deadline socket close) run on Node only. Bun does not enforce worker `resourceLimits`, so the JSON Schema worker's memory bound relies on the wall-clock timeout there; Bun 1.4 closes a trickling response on the export deadline like Node, while Bun 1.3 left the socket open although `flush()` still failed on time and counters held. Compatibility tests also exercise parentage, streaming, provider ownership, acknowledgements and actual encoded OTLP payloads. CI tests the installed tarball and independently installed wheels, including minimum/current supported Python versions; source-only tests do not establish package behavior.

## Required application acceptance

Use one client per serving process and a local kill switch. Exercise the actual application entry point with a synthetic provider and loopback collector, comparing with tracing disabled:

1. Successful export, invalid key, refused connection, retryable 429/503, delayed/trickling response and recovery on the same client.
2. Capture/redactor failure, unsupported or oversized values, and queue saturation while export is blocked.
3. Original application errors/cancellation, stream completion/abort, and shutdown during an outage.

Assert unchanged results/errors and exactly one invocation of each business operation. Confirm bounded queue/worker counts, observed loss, and your lifecycle deadline. Measure latency and resource overhead under the application's expected payload and concurrency; the SDK's telemetry-byte budget is not a bound on total process memory or active application spans. Verify dependency resolution and startup from the production lockfile. Start with a canary and keep Hue out of application readiness checks.

## Guarantee boundaries

This is a best-effort in-process integration, not a claim that arbitrary code cannot crash. A synchronous user redactor, Proxy outside the supported snapshot boundary, third-party instrumentation, dependency import failure, process kill or out-of-memory condition is not sandboxed by `try/catch`. Safe constructors cannot catch an import that failed before invocation. Customers requiring optional package loading should guard that import in their application and fall back to the original handler. Custom callbacks must remain bounded and free of network or business side effects.

Queues are volatile. Loss counters, flush acknowledgement and a stored trace receipt establish different facts; none promises complete distributed traces or durable local delivery. If longer outage buffering is required, evaluate a separately operated OpenTelemetry Collector with resource limits and an explicitly sized durable queue. That adds its own operational responsibilities and does not remove in-process instrumentation overhead.

The design follows OpenTelemetry's [error-handling principles](https://opentelemetry.io/docs/specs/otel/error-handling/), [nonblocking and bounded-resource guidance](https://opentelemetry.io/docs/specs/otel/performance/), and [processor/lifecycle requirements](https://opentelemetry.io/docs/specs/otel/trace/sdk/). See the Collector's [resilience guidance](https://opentelemetry.io/docs/collector/resiliency/) for the tradeoffs of buffering and durable storage. This document maps those principles to Hue behavior and tests; it is not certification of every OpenTelemetry requirement or a production capacity SLA.
