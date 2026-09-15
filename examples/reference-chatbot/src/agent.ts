import { ToolLoopAgent, isStepCount, tool, type LanguageModel, type ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { hueTelemetry } from "@hue-run/sdk/ai-sdk";
import type { HueClient } from "@hue-run/sdk";

export function textStatistics(text: string) {
  return {
    characters: Array.from(text).length,
    words: text.trim() ? text.trim().split(/\s+/u).length : 0,
    utf8Bytes: Buffer.byteLength(text),
  };
}

// This provider is deliberately synthetic. It exercises the AI SDK's actual tool loop and
// stream events without pretending that a lab model generated or billed this response.
function syntheticModel(messages: ModelMessage[]): LanguageModel {
  const latest = [...messages].reverse().find((message) => message.role === "user");
  const input = typeof latest?.content === "string" ? latest.content : "";
  let step = 0;
  return new MockLanguageModelV4({
    provider: "hue.synthetic-test",
    modelId: "synthetic-tool-loop",
    doStream: async ({ prompt }) => {
      const toolStep = step++ === 0;
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            if (toolStep) {
              controller.enqueue({
                type: "tool-call",
                toolCallId: "synthetic-text-statistics",
                toolName: "textStatistics",
                input: JSON.stringify({ text: input }),
              });
            } else {
              const toolMessage = [...prompt].reverse().find((message) => message.role === "tool");
              const result = toolMessage?.content.find(
                (part) => part.type === "tool-result" && part.toolName === "textStatistics",
              );
              if (!result || result.type !== "tool-result" || result.output.type !== "json")
                throw new Error("Synthetic provider did not receive its tool result");
              const stats = z
                .object({ characters: z.number(), words: z.number(), utf8Bytes: z.number() })
                .parse(result.output.value);
              const text = `[Synthetic provider] The text-analysis tool counted ${stats.characters} characters, ${stats.words} words, and ${stats.utf8Bytes} UTF-8 bytes.`;
              controller.enqueue({ type: "text-start", id: "synthetic-text" });
              for (const delta of text.match(/.{1,12}/gu) ?? [])
                controller.enqueue({ type: "text-delta", id: "synthetic-text", delta });
              controller.enqueue({ type: "text-end", id: "synthetic-text" });
            }
            controller.enqueue({
              type: "finish",
              finishReason: {
                unified: toolStep ? "tool-calls" : "stop",
                raw: toolStep ? "tool_calls" : "stop",
              },
              usage: {
                inputTokens: {
                  total: undefined,
                  noCache: undefined,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: { total: undefined, text: undefined, reasoning: undefined },
              },
            });
            controller.close();
          },
        }),
      };
    },
  });
}

export function createChatAgent(
  hue: HueClient,
  messages: ModelMessage[],
  mode: "synthetic" | "live",
  modelId?: string,
) {
  if (mode === "live" && !modelId) throw new Error("Live mode requires HUE_CHAT_MODEL");
  return new ToolLoopAgent({
    model: mode === "synthetic" ? syntheticModel(messages) : modelId!,
    instructions:
      "Help the user. When asked about text length or word counts, use the textStatistics tool and report its result accurately.",
    tools: {
      textStatistics: tool({
        description:
          "Count Unicode characters, words separated by whitespace, and UTF-8 bytes in text.",
        inputSchema: z.object({ text: z.string().max(8000) }),
        execute: async ({ text }) => textStatistics(text),
      }),
    },
    telemetry: hueTelemetry(hue),
    stopWhen: isStepCount(5),
    maxRetries: 0,
  });
}
