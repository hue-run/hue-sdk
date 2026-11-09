import { randomUUID } from "node:crypto";
import { TargetCancelledError, TargetErrorWithOutput } from "../evals/runner.js";
import type { JsonValue } from "../types.js";

/**
 * Conversation cases for `hue eval --command`. A case whose inputs hold a conversation (a `turns`
 * or `messages` array of `{role, text|content}`, the shape Hue's case page edits) can script
 * several user messages after the last assistant reply. `hue eval` sends each scripted message as
 * its own agent call, in order and waiting for each reply, as conversation harnesses do: the
 * agent answers one message at a time, and the case's answer is every reply.
 *
 * - `hue` (the default): one call per scripted message. Each call's inputs take the documented
 *   single-turn shape, `{...other fields, task, conversation: {turns: [{input, reply}]}}`, whose
 *   history holds the recorded turns and the earlier scripted turns with this attempt's replies.
 * - `runner`: one call with the case's inputs unchanged, for a runner that drives the
 *   conversation itself.
 *
 * A case scripting one message or none, or whose conversation is not plain user and assistant
 * text, runs as one call with its inputs unchanged in either mode.
 */
export type TurnsMode = "hue" | "runner";

export const TURNS_MODES: readonly TurnsMode[] = ["hue", "runner"];

/** One earlier turn as a conversation case's inputs carry it. */
export interface ConversationTurn {
  input: string;
  reply: JsonValue;
}

/** A conversation case whose scripted user messages `hue eval` sends one at a time. */
export interface ScriptedConversation {
  /** The case's other input fields, which every turn's inputs keep. */
  fields: Record<string, JsonValue>;
  /** The recorded turns through the last assistant message. */
  history: ConversationTurn[];
  /** The user messages after the last assistant message, in order; two or more. */
  messages: string[];
}

const isRecord = (value: unknown): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One `{role, text|content|say}` entry, as Hue's case page reads it; undefined otherwise. */
function entryOf(value: JsonValue): { role: string; text: string } | undefined {
  if (!isRecord(value)) return undefined;
  const key = ["text", "content", "say"].find((name) => typeof value[name] === "string");
  if (!key) return undefined;
  const role = typeof value.role === "string" ? value.role : key === "say" ? "user" : undefined;
  return role === undefined ? undefined : { role, text: value[key] as string };
}

/**
 * The scripted conversation of a case's inputs, or undefined when `hue eval` runs the case as
 * one call: inputs without a conversation, a conversation with a role other than `user` and
 * `assistant` or an entry that is not text, fewer than two user messages after the last
 * assistant message, or an envelope that already holds `task` or `conversation`, which the
 * turns' inputs would replace.
 */
export function scriptedConversation(inputs: JsonValue): ScriptedConversation | undefined {
  const envelope = isRecord(inputs) ? inputs : undefined;
  const key = Array.isArray(inputs)
    ? undefined
    : Array.isArray(envelope?.turns)
      ? "turns"
      : "messages";
  const list = key === undefined ? inputs : envelope?.[key];
  if (!Array.isArray(list) || !list.length) return undefined;
  if (envelope && ("task" in envelope || "conversation" in envelope)) return undefined;
  const entries = list.map(entryOf);
  if (entries.some((entry) => !entry || (entry.role !== "user" && entry.role !== "assistant")))
    return undefined;
  const turns = entries as { role: "user" | "assistant"; text: string }[];
  const last = turns.findLastIndex((entry) => entry.role === "assistant");
  const messages = turns.slice(last + 1).map((entry) => entry.text);
  if (messages.length < 2) return undefined;
  // Consecutive user messages are one input and consecutive assistant messages one reply; an
  // assistant message before any user message is a reply to an empty input.
  const history: ConversationTurn[] = [];
  let pending: string[] = [];
  let previous: "user" | "assistant" | undefined;
  for (const entry of turns.slice(0, last + 1)) {
    const earlier = history.at(-1);
    if (entry.role === "user") pending.push(entry.text);
    else if (previous === "assistant" && earlier)
      earlier.reply = `${earlier.reply as string}\n\n${entry.text}`;
    else {
      history.push({ input: pending.join("\n\n"), reply: entry.text });
      pending = [];
    }
    previous = entry.role;
  }
  const fields =
    envelope && key
      ? Object.fromEntries(Object.entries(envelope).filter(([name]) => name !== key))
      : {};
  return { fields, history, messages };
}

/** What one turn's call receives besides its inputs. */
export interface TurnCall {
  /** The turn's inputs: the case's other fields, `task` and `conversation.turns`. */
  inputs: JsonValue;
  /** Zero-based position among the scripted messages. */
  index: number;
  count: number;
  /** `HUE_SESSION_ID`, `HUE_TURN_INDEX` and `HUE_TURN_COUNT` for the call. */
  env: Record<string, string>;
}

/** Variables a turn's call receives, removed from every other call's inherited environment. */
export const TURN_VARIABLES = ["HUE_SESSION_ID", "HUE_TURN_INDEX", "HUE_TURN_COUNT"] as const;

/**
 * Sends each scripted message through `send`, one at a time, and returns the replies in order.
 * Every turn shares one session id. A turn that fails ends the conversation: the error names the
 * turn and, when earlier turns were answered, carries their `{ replies }`. An interruption is
 * rethrown as it is, since the run stays open to be resumed.
 */
export async function driveTurns(
  conversation: ScriptedConversation,
  send: (call: TurnCall) => Promise<JsonValue | undefined>,
): Promise<JsonValue[]> {
  const session = randomUUID();
  const count = conversation.messages.length;
  const turns: ConversationTurn[] = structuredClone(conversation.history);
  const replies: JsonValue[] = [];
  for (const [index, message] of conversation.messages.entries()) {
    const inputs: JsonValue = {
      ...structuredClone(conversation.fields),
      task: message,
      conversation: { turns: structuredClone(turns) as unknown as JsonValue },
    };
    let reply: JsonValue | undefined;
    try {
      reply = await send({
        inputs,
        index,
        count,
        env: {
          HUE_SESSION_ID: session,
          HUE_TURN_INDEX: String(index),
          HUE_TURN_COUNT: String(count),
        },
      });
    } catch (error) {
      if (error instanceof TargetCancelledError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const failure = new Error(`Turn ${index + 1} of ${count}: ${message}`, { cause: error });
      // A conversation that failed on its first turn has no answer, as a one-call case has none.
      throw replies.length ? new TargetErrorWithOutput({ replies }, failure) : failure;
    }
    // An empty answer is an empty reply: the list keeps one entry per message sent.
    replies.push(reply ?? "");
    turns.push({ input: message, reply: reply ?? "" });
  }
  return replies;
}
