import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
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

test("a data: URL with millions of parameters is still decoded by its own encoding", () => {
  // Past where a pattern repeated per parameter overflows Node's stack or stops matching in Bun.
  const bytes = Buffer.alloc(70_000, 7);
  const content = `data:application/octet-stream${";".repeat(3_400_000)};base64,${bytes.toString("base64")}`;
  const value = JSON.stringify([
    { role: "user", parts: [{ type: "blob", modality: "document", content }] },
  ]);
  const [message] = JSON.parse(hashInlineFiles("gen_ai.input.messages", value) as string) as {
    parts: unknown[];
  }[];
  expect(message!.parts[0]).toEqual({
    type: "blob",
    modality: "document",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: 70_000,
  });
});
