import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import corpus from "./fixtures/media-parts/cases.json" with { type: "json" };
import {
  hashInlineFiles,
  INLINE_FILE_LIMIT,
  isMediaName,
  MediaDigestMemo,
} from "../src/inline-files.js";

for (const item of corpus.fixtures)
  test(`media digest fallback: ${item.id}`, () => {
    expect(
      JSON.parse(hashInlineFiles(item.attribute, JSON.stringify(item.messages)) as string),
    ).toEqual(item.failure.messages);
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
