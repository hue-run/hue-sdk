import { AsyncLocalStorage } from "node:async_hooks";
import { SnapshotMissError } from "./portable.js";
import type { Binding, MissReason } from "./types.js";
export interface SceneRuntime {
  readonly mode: "capture" | "playback";
  readonly bindings: Binding[];
  invoke<T>(
    bindingId: string,
    operation: string,
    args: unknown,
    execute: () => T,
  ): T;
  selected(bindingId: string): boolean;
  reject?(
    bindingId: string,
    operation: string,
    args: unknown,
    reason: MissReason,
  ): never;
}
export const sceneContext = new AsyncLocalStorage<{
  runtime: SceneRuntime;
  parentCallId?: string;
  suppressed?: boolean;
}>();
export interface ToolOptions {
  contractVersion?: string;
  resultMode?: "sync" | "promise" | "asyncIterable";
}
export function wrapTool<A extends unknown[], R>(
  bindingId: string,
  operation: string,
  execute: (...args: A) => R,
  argsOf?: (...args: A) => unknown,
  options: ToolOptions = {},
): (...args: A) => R {
  const promise =
    options.resultMode === "promise" ||
    (!options.resultMode && execute.constructor.name === "AsyncFunction");
  return function (this: unknown, ...args: A): R {
    const active = sceneContext.getStore();
    if (!active || active.suppressed || !active.runtime.selected(bindingId))
      return execute.apply(this, args);
    const invoke = () => {
      let requestArguments: unknown;
      try {
        requestArguments = argsOf
          ? argsOf(...args)
          : args.length === 1
            ? args[0]
            : args;
      } catch {
        requestArguments = Symbol("unsupported arguments");
      }
      const binding = active.runtime.bindings.find((b) => b.id === bindingId);
      if (binding?.contractVersion !== (options.contractVersion ?? "1")) {
        if (active.runtime.mode === "playback") {
          if (active.runtime.reject)
            active.runtime.reject(
              bindingId,
              operation,
              requestArguments,
              "incompatible",
            );
          throw new SnapshotMissError("incompatible", bindingId, operation);
        }
        requestArguments = Symbol("incompatible contract");
      }
      return active.runtime.invoke(bindingId, operation, requestArguments, () =>
        execute.apply(this, args),
      );
    };
    if (promise) {
      try {
        return Promise.resolve(invoke()) as R;
      } catch (e) {
        return Promise.reject(e) as R;
      }
    }
    return invoke();
  };
}
export function isAsyncIterable(
  value: unknown,
): value is AsyncIterable<unknown> {
  try {
    return (
      value !== null &&
      typeof value === "object" &&
      typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] ===
        "function"
    );
  } catch {
    return false;
  }
}
export function isPromise(value: unknown): value is PromiseLike<unknown> {
  try {
    return (
      value !== null &&
      (typeof value === "object" || typeof value === "function") &&
      typeof (value as PromiseLike<unknown>).then === "function"
    );
  } catch {
    return false;
  }
}
