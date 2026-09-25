import { expect, test } from "bun:test";
import fixture from "./fixtures/inline-file-digests.json" with { type: "json" };
import { hashInlineFiles, INLINE_FILE_LIMIT } from "../src/inline-files.js";

test("the shared digest fixture uses the SDK's inline file limit", () => {
  expect(fixture.limit).toBe(INLINE_FILE_LIMIT);
});

// The Python suite reads the same file; each digest is of the bytes the case was built from.
for (const item of fixture.cases)
  test(`inline file digest: ${item.name}`, () => {
    const { prefix, unit, times, suffix } = item.content;
    const part = { ...item.part, [item.key]: `${prefix}${unit.repeat(times)}${suffix}` };
    const file = item.part.type === "file";
    const value = JSON.stringify([
      file ? { role: "user", content: [part] } : { role: "user", parts: [part] },
    ]);
    const result = hashInlineFiles(file ? "ai.prompt.messages" : "gen_ai.input.messages", value);
    if (item.expected === null) {
      expect(result).toBe(value);
      return;
    }
    const [message] = JSON.parse(result as string) as {
      content?: unknown[];
      parts?: unknown[];
    }[];
    expect((file ? message!.content : message!.parts)![0]).toEqual({
      ...item.part,
      ...item.expected,
    });
  });
