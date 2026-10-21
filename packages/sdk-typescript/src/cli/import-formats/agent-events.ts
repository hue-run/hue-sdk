import type { ImportAdapter } from "./adapter.js";
import { helicone } from "./helicone.js";
import { openaiAgents } from "./openai-agents.js";
import { raindrop, raindropSpans } from "./raindrop.js";
import { anthropicMessages, openaiChat, openaiResponses } from "./transcripts.js";

/** Agent runtimes, event logs and plain chat transcripts: OpenAI Agents SDK traces, Raindrop
 * events and span rows, Helicone request logs, and OpenAI chat, OpenAI Responses and Anthropic Messages
 * transcripts. No two claim the same value, so their order here is free. */
export const agentEventAdapters: readonly ImportAdapter[] = [
  openaiAgents,
  raindrop,
  raindropSpans,
  helicone,
  openaiChat,
  openaiResponses,
  anthropicMessages,
];
