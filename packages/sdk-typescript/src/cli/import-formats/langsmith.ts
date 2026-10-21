import { ConversionError, isObject, type JsonValue } from "../traces-import-convert.js";
import type { ConvertContext, ImportAdapter } from "./adapter.js";
import { identityText } from "./identity.js";
import {
  count,
  first,
  isoNanos,
  object,
  objectField,
  SESSION_FIELDS,
  text,
  USER_FIELDS,
  type JsonObject,
} from "./row-platform-fields.js";
import { readRecords, type SpanKind, type SpanRow } from "./rows.js";

/**
 * LangSmith runs (`Run` in the LangSmith SDK's schemas, and the v2 runs API's `Run`): one run per
 * span, joined into traces by `trace_id` (the root run's id) with `parent_run_id`. Read from a
 * single run, a JSON array or JSON Lines of runs (an SDK `list_runs` dump), the runs query page
 * (`{"runs": […], "cursors": …}`), the v2 query page (`{"items": […], "next_cursor": …}`, with an
 * upper-case `run_type`, top-level `metadata`, `parent_run_ids` from the root down and
 * `thread_id`), a run with its `child_runs` nested, and bulk-export rows converted from Parquet to
 * JSON, whose `inputs`, `outputs` and `extra` columns are JSON text.
 *
 * - `start_time` and `end_time` without a zone are UTC, as LangSmith records them. A run without
 *   `start_time` starts at the instant its `dotted_order` records for it.
 * - `run_type` names the kind: `llm` a model call, `tool` a tool call, `embedding` and
 *   `retriever`; `chain`, `prompt` and `parser` record no operation.
 * - The user and conversation come from the run's metadata (`user_id`, `thread_id`, `session_id`,
 *   `conversation_id`, …) and the v2 `thread_id`; never from the run's own `session_id` (v2
 *   `project_id`), which names the tracing project, nor `ls_user_id`, the LangSmith account whose
 *   key traced it.
 * - Token counts are read from `llm` runs only: `list_runs` sums a chain's counts over its
 *   children.
 * - A run exported both before and after it ended keeps the ended copy; a run compared against a
 *   dataset example (`reference_example_id`) is evaluation traffic.
 */

type Run = JsonObject;

const RUN_TYPES = new Set(["chain", "llm", "embedding", "prompt", "tool", "retriever", "parser"]);
const KINDS: Record<string, SpanKind> = {
  llm: "llm",
  tool: "tool",
  embedding: "embedding",
  retriever: "retrieval",
};

const isRun = (value: unknown): value is Run =>
  isObject(value) &&
  typeof value.id === "string" &&
  typeof value.run_type === "string" &&
  RUN_TYPES.has(value.run_type.toLowerCase()) &&
  (typeof value.start_time === "string" || typeof value.dotted_order === "string");

/** The runs a query page (`runs` of v1, `items` of v2) holds, when it holds any. */
function envelopeRuns(value: unknown): unknown[] | undefined {
  if (!isObject(value)) return undefined;
  for (const key of ["runs", "items"])
    if (Array.isArray(value[key]) && (value[key] as unknown[]).some(isRun))
      return value[key] as unknown[];
  return undefined;
}

/** A run and every run nested in its `child_runs`, each kept without its children. */
function flatten(record: unknown, out: unknown[]): void {
  if (!isRun(record) || !Array.isArray(record.child_runs)) {
    out.push(record);
    return;
  }
  const { child_runs: children, ...run } = record;
  out.push(run);
  for (const child of children as JsonValue[]) flatten(child, out);
}

/** `dotted_order`'s segments, root first: each `<start>Z<run id>`, the start as
 * `YYYYMMDDTHHMMSSffffff`; undefined when it is not one. */
function dottedOrder(value: JsonValue | undefined): { start: bigint; id: string }[] | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const segments: { start: bigint; id: string }[] = [];
  for (const segment of value.split(".")) {
    const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{0,9})Z(.+)$/.exec(segment);
    if (!match) return undefined;
    const [, year, month, day, hour, minute, second, fraction] = match;
    try {
      const start = isoNanos(
        `${year}-${month}-${day}T${hour}:${minute}:${second}${fraction ? `.${fraction}` : ""}Z`,
      );
      segments.push({ start, id: match[8]! });
    } catch {
      return undefined;
    }
  }
  return segments;
}

/** The run's trace and parent: `trace_id`, `parent_run_id` (or the last of v2's
 * `parent_run_ids`), else what `dotted_order` records; a run with no parent is its trace's root. */
function placement(run: Run): { traceKey?: string; parentKey?: string } {
  const ancestors = Array.isArray(run.parent_run_ids) ? run.parent_run_ids : undefined;
  const order =
    text(run.trace_id) === undefined || (run.parent_run_id === undefined && ancestors === undefined)
      ? dottedOrder(run.dotted_order)
      : undefined;
  const parentKey =
    text(run.parent_run_id) ??
    (ancestors ? text(ancestors.at(-1)) : undefined) ??
    (order && order.length > 1 ? order.at(-2)!.id : undefined);
  const traceKey =
    text(run.trace_id) ??
    order?.[0]?.id ??
    (parentKey === undefined ? (run.id as string) : undefined);
  return {
    ...(traceKey !== undefined ? { traceKey } : {}),
    ...(parentKey !== undefined && parentKey !== run.id ? { parentKey } : {}),
  };
}

/** A LangChain `ToolMessage` (serialized or as a dict) as its content and call id. */
function toolMessage(
  value: JsonValue | undefined,
): { content: JsonValue; callId?: string } | undefined {
  const message = object(value);
  if (!message) return undefined;
  const constructor =
    message.lc === 1 && Array.isArray(message.id) && message.id.at(-1) === "ToolMessage"
      ? object(message.kwargs)
      : undefined;
  const fields = constructor ?? (message.type === "tool" ? message : undefined);
  if (!fields || !("content" in fields)) return undefined;
  const callId = text(fields.tool_call_id);
  return { content: fields.content!, ...(callId ? { callId } : {}) };
}

/** A tool run's result: LangChain records it as `{"output": …}`, a `ToolMessage` when the tool
 * answered one. */
function toolResult(outputs: JsonObject | undefined): { result?: JsonValue; callId?: string } {
  if (outputs === undefined) return {};
  const keys = Object.keys(outputs);
  if (keys.length !== 1 || keys[0] !== "output") return { result: outputs };
  const message = toolMessage(outputs.output);
  return message
    ? { result: message.content, callId: message.callId }
    : { result: outputs.output! };
}

/** The exception class LangChain's error text opens with (`repr(error)`, as in
 * `ValueError('…')`), when it does. */
const errorType = (message: string | undefined): string | undefined =>
  message ? /^([A-Za-z_][\w.]*)\(/.exec(message)?.[1] : undefined;

/** A token count from a `*_token_details` map (v2 wraps it in `raw`) or LangChain's
 * `usage_metadata` details. */
const detail = (details: JsonValue | undefined, name: string) =>
  count(object(details)?.[name]) ?? count(object(object(details)?.raw)?.[name]);

function readRun(run: Run, context: ConvertContext): void {
  const { traceKey, parentKey } = placement(run);
  if (traceKey === undefined) throw new ConversionError("a run without a trace_id");
  const runType = (run.run_type as string).toLowerCase();
  const ancestors = run.parent_run_ids;
  if (
    ancestors != null &&
    (!Array.isArray(ancestors) || !ancestors.every((id) => typeof id === "string" && id))
  )
    throw new ConversionError("parent_run_ids is not a list of run ids");
  let start = run.start_time == null ? undefined : isoNanos(run.start_time);
  const end = run.end_time == null ? undefined : isoNanos(run.end_time);
  let timing: string | undefined;
  if (start === undefined) {
    const own = dottedOrder(run.dotted_order)?.at(-1);
    if (own?.id === run.id) {
      start = own.start;
      timing = "start_from_dotted_order";
    }
  }
  const extra = objectField(run.extra, "extra");
  const metadata = object(run.metadata) ?? object(extra?.metadata);
  const inputs = objectField(run.inputs, "inputs");
  const outputs = objectField(run.outputs, "outputs");
  const tags =
    Array.isArray(run.tags) && run.tags.every((tag) => typeof tag === "string")
      ? (run.tags as string[])
      : undefined;
  const kind = Object.hasOwn(KINDS, runType) ? KINDS[runType] : undefined;
  // A completion model records its prompt as `{"prompts": [text]}`.
  const prompts = inputs?.prompts;
  const input =
    kind === "llm" &&
    Array.isArray(prompts) &&
    prompts.length === 1 &&
    typeof prompts[0] === "string"
      ? prompts[0]
      : inputs;
  const row: SpanRow = {
    traceKey,
    spanKey: run.id as string,
    ...(parentKey !== undefined ? { parentKey } : {}),
    name: text(run.name) ?? runType,
    ...(kind ? { kind } : {}),
    ...(start !== undefined ? { start } : {}),
    ...(end !== undefined ? { end } : {}),
    ...(timing ? { timing } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(outputs !== undefined ? { output: outputs } : {}),
    record: run,
    ...(metadata ? { metadata } : {}),
    revision: end !== undefined ? "1" : "0",
    attributes: {
      "langsmith.span.kind": runType,
      ...(metadata && Object.keys(metadata).length
        ? { "langsmith.metadata": JSON.stringify(metadata) }
        : {}),
      ...(tags?.length ? { "langsmith.span.tags": tags } : {}),
    },
  };
  const error = text(run.error);
  if (error !== undefined || text(run.status)?.toLowerCase() === "error") {
    const type = errorType(error);
    row.error = { ...(error !== undefined ? { message: error } : {}), ...(type ? { type } : {}) };
  }
  if (kind === "llm" || kind === "embedding") {
    const params = object(extra?.invocation_params);
    const model =
      text(metadata?.ls_model_name) ??
      text(params?.model) ??
      text(params?.model_name) ??
      text(inputs?.model);
    const provider = text(metadata?.ls_provider);
    if (model) row.model = model;
    if (provider) row.provider = provider;
  }
  if (kind === "llm") {
    const usage = object(metadata?.usage_metadata) ?? object(outputs?.usage_metadata);
    row.usage = {
      input: count(run.prompt_tokens) ?? count(usage?.input_tokens),
      output: count(run.completion_tokens) ?? count(usage?.output_tokens),
      cacheRead:
        detail(run.prompt_token_details, "cache_read") ??
        detail(usage?.input_token_details, "cache_read"),
      cacheWrite:
        detail(run.prompt_token_details, "cache_creation") ??
        detail(usage?.input_token_details, "cache_creation"),
      reasoning:
        detail(run.completion_token_details, "reasoning") ??
        detail(usage?.output_token_details, "reasoning"),
    };
  }
  if (kind === "tool") {
    const returned = toolResult(outputs);
    row.tool = {
      name: text(run.name) ?? "tool",
      ...(inputs !== undefined ? { arguments: inputs } : {}),
      ...(returned.result !== undefined ? { result: returned.result } : {}),
    };
    // LangChain passes the call id a tool answers to the tracer, which keeps it in `extra`.
    const callId = text(extra?.tool_call_id) ?? returned.callId;
    if (callId) row.tool.callId = callId;
  } else {
    const user = first(metadata, USER_FIELDS);
    const session = first(metadata, SESSION_FIELDS) ?? identityText(run.thread_id);
    if (user !== undefined) row.user = user;
    if (session !== undefined) row.session = session;
  }
  if (text(run.reference_example_id)) row.origin = "evaluation";
  context.row(row);
}

export const langsmithRuns: ImportAdapter = {
  id: "langsmith_runs",
  manifestFormat: "otlp_json",
  detect: (value) => isRun(value) || envelopeRuns(value) !== undefined,
  convert(value, context) {
    const records: unknown[] = [];
    for (const record of isRun(value) ? [value] : (envelopeRuns(value) ?? []))
      flatten(record, records);
    readRecords(
      context,
      records,
      (record) => (isRun(record) ? placement(record).traceKey : undefined),
      (record) => {
        if (!isRun(record)) throw new ConversionError("a record that is not a LangSmith run");
        readRun(record, context);
      },
    );
  },
};
