const assertions = `
import { context, createContextKey, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { setTimeout as wait } from "node:timers/promises";

function check(value, stage) {
  if (!value) throw new Error(stage);
}
const marker = createContextKey("hue.test.context-owner");
function markerIsActive() {
  return context.with(ROOT_CONTEXT.setValue(marker, true), () => context.active().getValue(marker) === true);
}
async function assertPropagation() {
  const expected = { traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1 };
  const span = trace.wrapSpanContext(expected);
  await context.with(trace.setSpan(ROOT_CONTEXT, span), async () => {
    const matches = () => {
      const actual = trace.getActiveSpan()?.spanContext();
      check(actual?.traceId === expected.traceId && actual?.spanId === expected.spanId, "active_span_mismatch");
    };
    matches();
    await Promise.resolve();
    matches();
    await wait(1);
    matches();
    await new Promise((resolve) => setImmediate(resolve));
    matches();
    async function* stream() {
      matches();
      await wait(1);
      matches();
      yield 1;
      await Promise.resolve();
      matches();
      yield 2;
    }
    let chunks = 0;
    for await (const chunk of stream()) { chunks += chunk; matches(); }
    check(chunks === 3, "stream_incomplete");
  });
  check(trace.getActiveSpan() === undefined, "context_escaped_request");
}
`;

const scenarios = {
  owned: `
check(!markerIsActive(), "manager_already_registered");
let setupDisables = 0;
const disable = AsyncLocalStorageContextManager.prototype.disable;
AsyncLocalStorageContextManager.prototype.disable = function() { setupDisables++; return disable.call(this); };
const { hue, installHueExpress } = await import("./hue.setup.mjs");
check(markerIsActive(), "setup_manager_missing");
await assertPropagation();
let registrations = 0;
const app = { use() { registrations++; } };
installHueExpress(app, "/");
let duplicateRefused = false;
try { installHueExpress(app, "/"); } catch { duplicateRefused = true; }
check(duplicateRefused && registrations === 1, "duplicate_middleware_accepted");
await hue.shutdownSafe();
check(setupDisables === 0, "core_shutdown_disabled_context");
process.emit("beforeExit", 0);
check(setupDisables === 1, "setup_manager_not_disposed_once");
process.emit("beforeExit", 0);
check(setupDisables === 1, "setup_manager_disposed_twice");
`,
  borrowed: `
const existing = new AsyncLocalStorageContextManager().enable();
let existingDisables = 0;
let existingWithCalls = 0;
let setupInstances = 0;
const disable = existing.disable;
const withContext = existing.with;
existing.disable = function() { existingDisables++; return disable.call(this); };
existing.with = function(...args) { existingWithCalls++; return withContext.apply(this, args); };
check(context.setGlobalContextManager(existing), "caller_registration_failed");
const enable = AsyncLocalStorageContextManager.prototype.enable;
AsyncLocalStorageContextManager.prototype.enable = function() { setupInstances++; return enable.call(this); };
const { hue } = await import("./hue.setup.mjs");
check(existingWithCalls > 0, "caller_manager_not_probed");
await assertPropagation();
check(setupInstances === 0, "competing_manager_created");
await hue.shutdownSafe();
process.emit("beforeExit", 0);
check(existingDisables === 0, "caller_manager_disabled");
await assertPropagation();
context.disable();
`,
  nonworking: `
let existingDisables = 0;
let existingWithCalls = 0;
let candidateDisables = 0;
const existing = {
  active() { return ROOT_CONTEXT; },
  with(_context, fn, thisArg, ...args) { existingWithCalls++; return fn.call(thisArg, ...args); },
  bind(_context, target) { return target; },
  enable() { return this; },
  disable() { existingDisables++; return this; },
};
check(context.setGlobalContextManager(existing), "caller_registration_failed");
const disable = AsyncLocalStorageContextManager.prototype.disable;
AsyncLocalStorageContextManager.prototype.disable = function() { candidateDisables++; return disable.call(this); };
let refused = false;
try { await import("./hue.setup.mjs"); }
catch (error) { refused = error.message === "Existing OpenTelemetry context ownership is unsupported; review the application bootstrap"; }
check(refused, "unsupported_manager_accepted");
check(existingWithCalls > 0, "caller_manager_not_probed");
check(existingDisables === 0, "caller_manager_disabled");
check(candidateDisables === 1, "rejected_candidate_not_disposed");
check(!markerIsActive(), "caller_manager_replaced");
process.emit("beforeExit", 0);
check(existingDisables === 0, "caller_manager_disabled_at_exit");
context.disable();
`,
};

export const setupContextScenarios = Object.keys(scenarios);

/** Test-only process program; no credentials, requests, or recording spans. */
export function setupContextCheckSource(scenario) {
  if (!Object.hasOwn(scenarios, scenario)) throw new Error("Unknown context test scenario");
  return `${assertions}\ntry {\n${scenarios[scenario]}\nprocess.stdout.write("passed\\n"); } catch { process.stderr.write("context_check_failed\\n"); process.exitCode = 1; }`;
}
