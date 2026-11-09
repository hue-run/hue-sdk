import { describe, expect, test } from "bun:test";
import { driveTurns, scriptedConversation } from "../src/cli/eval-turns.js";
import { TargetCancelledError, TargetErrorWithOutput } from "../src/evals/runner.js";
import type { JsonValue } from "../src/types.js";

const user = (text: string) => ({ role: "user", text });
const assistant = (text: string) => ({ role: "assistant", text });

describe("scriptedConversation", () => {
  test("user messages after the last assistant message are scripted; earlier turns are history", () => {
    expect(
      scriptedConversation({
        turns: [user("a"), assistant("b"), user("c"), user("d")],
        context: { locale: "en" },
      }),
    ).toEqual({
      fields: { context: { locale: "en" } },
      history: [{ input: "a", reply: "b" }],
      messages: ["c", "d"],
    });
  });

  test("messages, content, say and a top-level list are read as Hue's case page reads them", () => {
    expect(
      scriptedConversation({
        messages: [{ role: "user", content: "a" }, { say: "b" }, { say: "c" }],
      }),
    ).toEqual({ fields: {}, history: [], messages: ["a", "b", "c"] });
    expect(scriptedConversation([user("a"), user("b")])).toEqual({
      fields: {},
      history: [],
      messages: ["a", "b"],
    });
    // `turns` wins over `messages`, which then stays an ordinary field.
    expect(
      scriptedConversation({ turns: [user("a"), user("b")], messages: ["kept"] })?.fields,
    ).toEqual({ messages: ["kept"] });
  });

  test("consecutive messages of one role join; an opening assistant message answers an empty input", () => {
    expect(
      scriptedConversation({
        turns: [
          assistant("hello"),
          user("a"),
          user("b"),
          assistant("c"),
          assistant("d"),
          user("e"),
          user("f"),
        ],
      })?.history,
    ).toEqual([
      { input: "", reply: "hello" },
      { input: "a\n\nb", reply: "c\n\nd" },
    ]);
  });

  test("a case with fewer than two scripted messages or another shape runs as one call", () => {
    for (const inputs of [
      { task: "refund charge ch_2" },
      "plain text",
      { turns: [user("a")] },
      { turns: [user("a"), assistant("b"), user("c")] },
      { turns: [user("a"), user("b"), assistant("c")] },
      { turns: [] },
      // A role other than user and assistant, or an entry that is not text.
      { messages: [{ role: "system", content: "s" }, user("a"), user("b")] },
      { messages: [user("a"), { role: "user", content: [{ type: "text", text: "b" }] }] },
      { turns: [user("a"), user("b"), "c"] },
      // The turns' inputs would replace these fields.
      { task: "t", turns: [user("a"), user("b")] },
      { conversation: {}, turns: [user("a"), user("b")] },
    ] as JsonValue[])
      expect(scriptedConversation(inputs)).toBeUndefined();
  });
});

describe("driveTurns", () => {
  const conversation = {
    fields: { context: "x" },
    history: [{ input: "a", reply: "b" }],
    messages: ["c", "d", "e"],
  };

  test("each call waits for the previous reply and sees it in its history", async () => {
    const calls: { inputs: JsonValue; env: Record<string, string> }[] = [];
    const replies = await driveTurns(conversation, async ({ inputs, env }) => {
      calls.push({ inputs, env });
      const task = (inputs as { task: string }).task;
      // An empty answer is recorded as an empty reply.
      return task === "d" ? undefined : { said: task };
    });
    expect(replies).toEqual([{ said: "c" }, "", { said: "e" }]);
    expect(calls.map((call) => call.inputs)).toEqual([
      { context: "x", task: "c", conversation: { turns: [{ input: "a", reply: "b" }] } },
      {
        context: "x",
        task: "d",
        conversation: {
          turns: [
            { input: "a", reply: "b" },
            { input: "c", reply: { said: "c" } },
          ],
        },
      },
      {
        context: "x",
        task: "e",
        conversation: {
          turns: [
            { input: "a", reply: "b" },
            { input: "c", reply: { said: "c" } },
            { input: "d", reply: "" },
          ],
        },
      },
    ]);
    const sessions = new Set(calls.map((call) => call.env.HUE_SESSION_ID));
    expect(sessions.size).toBe(1);
    expect(calls.map((call) => [call.env.HUE_TURN_INDEX, call.env.HUE_TURN_COUNT])).toEqual([
      ["0", "3"],
      ["1", "3"],
      ["2", "3"],
    ]);
    // The case's own history is never changed.
    expect(conversation.history).toEqual([{ input: "a", reply: "b" }]);
  });

  test("a failing turn stops the conversation and keeps the replies before it", async () => {
    let sent = 0;
    const failure = await driveTurns(conversation, async ({ index }) => {
      sent++;
      if (index === 1) throw new Error("The agent command exited with code 3");
      return "ok";
    }).catch((error: unknown) => error);
    expect(sent).toBe(2);
    expect(failure).toBeInstanceOf(TargetErrorWithOutput);
    const error = failure as TargetErrorWithOutput;
    expect(error.output).toEqual({ replies: ["ok"] });
    expect(error.cause.message).toBe("Turn 2 of 3: The agent command exited with code 3");
  });

  test("an interruption is rethrown as it is", async () => {
    const failure = await driveTurns(conversation, async () => {
      throw new TargetCancelledError();
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TargetCancelledError);
  });
});
