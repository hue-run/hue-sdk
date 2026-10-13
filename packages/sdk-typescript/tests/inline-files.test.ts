import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import corpus from "./fixtures/media-parts/cases.json" with { type: "json" };
import digests from "./fixtures/inline-file-digests.json" with { type: "json" };
import {
  hashInlineFiles,
  hashNestedInlineFiles,
  INLINE_FILE_LIMIT,
  MAX_INLINE_FILE_TEXT,
  isMediaName,
  MediaDigestMemo,
} from "../src/inline-files.js";

test("nested legacy media preserves empty and boundary-size binary verbatim", () => {
  for (const size of [0, INLINE_FILE_LIMIT, INLINE_FILE_LIMIT + 1]) {
    const bytes = Buffer.alloc(size, 7);
    const value = JSON.stringify(
      [
        {
          role: "user",
          parts: [{ type: "blob", mime_type: "image/png", content: bytes.toString("base64") }],
        },
      ],
      null,
      2,
    );
    for (const key of ["gen_ai.input.messages", "gen_ai.output.messages", "ai.prompt.messages"]) {
      const result = hashNestedInlineFiles(key, value);
      if (size <= INLINE_FILE_LIMIT) expect(result).toBe(value);
      else
        expect(JSON.parse(result as string)).toEqual([
          {
            role: "user",
            parts: [
              {
                type: "blob",
                mime_type: "image/png",
                sha256: createHash("sha256").update(bytes).digest("hex"),
                size,
              },
            ],
          },
        ]);
    }
  }
  const value =
    '[ { "parts": [ { "type": "blob", "mime_type": "image/png", "content": "AQID" } ] } ]';
  expect(hashNestedInlineFiles("gen_ai.input.messages", value)).toBe(value);
  expect(hashInlineFiles("gen_ai.input.messages", value)).not.toBe(value);
});

test("nested legacy inspection uses the UTF-16 MAX guard", () => {
  const bytes = Buffer.alloc(INLINE_FILE_LIMIT + 1, 9);
  const messages = [
    {
      role: "user",
      parts: [{ type: "blob", mime_type: "image/png", content: bytes.toString("base64") }],
      padding: "",
    },
  ];
  messages[0]!.padding = "é".repeat(MAX_INLINE_FILE_TEXT - JSON.stringify(messages).length);
  const value = JSON.stringify(messages);
  expect(value.length).toBe(MAX_INLINE_FILE_TEXT);
  expect(Buffer.byteLength(value, "utf8")).toBeGreaterThan(MAX_INLINE_FILE_TEXT);
  const result = JSON.parse(hashNestedInlineFiles("gen_ai.input.messages", value) as string);
  expect(result[0].parts[0]).toEqual({
    type: "blob",
    mime_type: "image/png",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  });
  expect(hashNestedInlineFiles("gen_ai.input.messages", `${value} `)).toBe(`${value} `);
});

for (const item of corpus.fixtures as {
  id: string;
  attribute: string;
  messages?: unknown;
  value?: string;
  failure: { messages?: unknown; value?: string };
}[])
  test(`media digest fallback: ${item.id}`, () => {
    const placed = hashInlineFiles(item.attribute, item.value ?? JSON.stringify(item.messages));
    if (item.value === undefined)
      expect(JSON.parse(placed as string)).toEqual(item.failure.messages);
    else expect(placed).toBe(item.failure.value!);
  });

// The Python suite reads the same file; each digest is of the bytes the case was built from.
// Content that reads as base64 is the file's base64 whatever the part's media type, as Hue's
// reader reads it: a text file's bytes, not the base64 text.
for (const item of digests.cases as {
  name: string;
  part: Record<string, unknown>;
  key: string;
  content: { prefix: string; unit: string; times: number; suffix: string };
  expected: { sha256: string; size: number } | null;
}[])
  test(`inline file digest: ${item.name}`, () => {
    const { prefix, unit, times, suffix } = item.content;
    const part = { ...item.part, [item.key]: `${prefix}${unit.repeat(times)}${suffix}` };
    const file = item.part.type === "file";
    const value = JSON.stringify([
      file ? { role: "user", content: [part] } : { role: "user", parts: [part] },
    ]);
    const result = hashInlineFiles(file ? "ai.prompt.messages" : "gen_ai.input.messages", value);
    let expected = item.expected;
    // Binary media takes its digest at every size in a recorded message since 0.17.0.
    if (expected === null && prefix.startsWith("data:application/octet-stream")) {
      const bytes = Buffer.from(suffix.slice(";base64,".length), "base64");
      expected = { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
    }
    if (expected === null) {
      expect(result).toBe(value);
      return;
    }
    const [exported] = JSON.parse(result as string) as Record<string, unknown[]>[];
    expect((file ? exported!.content : exported!.parts)![0]).toEqual({ ...item.part, ...expected });
  });

test("the shared digest fixture uses the SDK's inline file limit", () => {
  expect(digests.limit).toBe(INLINE_FILE_LIMIT);
});

test("media names use UTF-16 limits and reject invalid labels", () => {
  expect(INLINE_FILE_LIMIT).toBe(65536);
  expect(isMediaName("🎧".repeat(128))).toBe(true);
  expect(isMediaName("🎧".repeat(129))).toBe(false);
  expect(isMediaName("a\u009fb")).toBe(true);
  for (const name of [
    "",
    "  ",
    "a\u0000b",
    "a\u001fb",
    "a\u007fb",
    "a\tb",
    "a\nb",
    "\ud800",
    "\udc00",
  ])
    expect(isMediaName(name)).toBe(false);
});

test("the digest memo shares byte identity within a trace and evicts bounded entries", () => {
  const memo = new MediaDigestMemo();
  const bytes = Buffer.from("same bytes");
  const first = memo.bytes(bytes, "trace-a");
  expect(memo.bytes(Uint8Array.from(bytes), "trace-a")).toBe(first);
  expect(memo.bytes(bytes, "trace-b")).not.toBe(first);
  for (let index = 0; index < 4096; index++) memo.bytes(Buffer.from(String(index)), "trace-a");
  expect(memo.bytes(bytes, "trace-a")).not.toBe(first);
  expect(memo.bytes(bytes, "trace-a")).toEqual(first);
  memo.clear();
  expect(memo.bytes(bytes, "trace-a")).not.toBe(first);
});

test("escaped media type names pass the shared cheap JSON prefilter", () => {
  const bytes = Buffer.from([1, 2, 3]);
  const value = JSON.stringify([
    { parts: [{ type: "blob", mime_type: "image/png", content: bytes.toString("base64") }] },
  ]).replace('"blob"', '"\\u0062lob"');
  expect(JSON.parse(hashInlineFiles("gen_ai.input.messages", value) as string)).toEqual([
    {
      parts: [
        {
          type: "blob",
          mime_type: "image/png",
          sha256: createHash("sha256").update(bytes).digest("hex"),
          size: 3,
        },
      ],
    },
  ]);
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

test("JSON edits to many members are rendered in time linear in them", async () => {
  const { applyJsonEdits } = await import("../src/json-edits.js");
  const count = 20_000;
  const text = JSON.stringify(
    Array.from({ length: count }, (_, index) => ({ type: "blob", content: `c${index}`, keep: 1 })),
  );
  const edits = Array.from({ length: count }, (_, index) => ({
    pointer: `/${index}`,
    remove: "content",
    set: [["size", String(index)]] as [string, string][],
  }));
  const started = performance.now();
  const placed = applyJsonEdits(text, edits);
  // 20,000 edited parts render in well under a second; visiting every piece for every member
  // took tens of seconds.
  expect(performance.now() - started).toBeLessThan(2000);
  expect(JSON.parse(placed)).toEqual(
    Array.from({ length: count }, (_, index) => ({ type: "blob", keep: 1, size: index })),
  );
});
