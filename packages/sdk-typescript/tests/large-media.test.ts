import { describe, expect, test } from "bun:test";
import corpus from "./fixtures/media-parts/cases.json" with { type: "json" };
import {
  BLOBS_KEY,
  digestOf,
  newTally,
  offloadRecord,
  type BlobUploader,
  type OffloadCollector,
} from "../src/blobs.js";
import { readLargeMediaText, type ByteSource } from "../src/large-media.js";

/**
 * Media read in place (`readLargeMediaText`) is placed exactly as media parsed out of the value:
 * the same text, entries, uploads and fallbacks, for every shape of the shared corpus and for the
 * corpus with its files lengthened past the long-string threshold, which this suite lowers so
 * every such file is read in place. Each upload hashes the bytes it is given, so a file decoded a
 * slice at a time must give the bytes decoded whole.
 */

type Upload = { key: string; sha256: string; size: number; contentType: string };

/** An uploader that hashes what it is given and stores it, or refuses every value. */
function uploader(ok: boolean, uploads: Upload[]): BlobUploader {
  return {
    limit: <R>(work: () => Promise<R>) => work(),
    unsupported: () => false,
    async store(
      _traceId: string,
      key: string,
      value: string | Uint8Array | ByteSource,
      contentType: string,
      digest: { sha256: string; size: number },
    ) {
      const bytes = await digestOf(value);
      expect(bytes).toEqual(digest);
      uploads.push({ key, ...digest, contentType });
      return ok ? { ok: true, contentType } : { ok: false, reason: "failed" };
    },
  } as unknown as BlobUploader;
}

async function place(
  key: string,
  text: string,
  large: boolean,
  ok: boolean,
  valueBytes = 1_000_000_000,
) {
  const uploads: Upload[] = [];
  const tally = newTally();
  const collector: OffloadCollector = {
    candidates: [{ key, value: text }],
    cut: [],
    inspected: new Set(large ? [] : [key]),
    large: new Set(large ? [key] : []),
  };
  const attributes = await offloadRecord({ [key]: text }, collector, {
    uploader: uploader(ok, uploads),
    traceId: "0123456789abcdef0123456789abcdef",
    valueBytes,
    upload: { deadline: Date.now() + 60_000, wait: async () => false },
    tally,
    longUnits: 300,
  });
  return {
    value: attributes.attributes[key],
    entries: attributes.attributes[BLOBS_KEY],
    truncated: attributes.attributes["hue.truncated"],
    uploads,
    uploaded: tally.uploaded,
    fallbacks: [...tally.fallbacks].map(([reason, { count }]) => [reason, count]),
  };
}

const base64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** A value with each file it holds as base64 or a `data:` URL lengthened past the lowered
 * threshold: base64 decoded and its bytes repeated, percent-escaped data repeated whole. */
function lengthened(value: unknown): unknown {
  if (typeof value === "string") {
    const comma = value.indexOf(",");
    if (value.startsWith("data:") && comma !== -1) {
      const header = value.slice(5, comma);
      const data = value.slice(comma + 1);
      if (header.includes(";base64") && data.length % 4 === 0 && base64.test(data)) {
        const bytes = Buffer.from(data, "base64");
        if (!bytes.byteLength) return value;
        return `data:${header},${Buffer.concat(Array(Math.ceil(3000 / bytes.byteLength)).fill(bytes)).toString("base64")}`;
      }
      return data ? `data:${header},${data.repeat(Math.ceil(2000 / data.length))}` : value;
    }
    if (value.length >= 16 && value.length % 4 === 0 && base64.test(value)) {
      const bytes = Buffer.from(value, "base64");
      return Buffer.concat(Array(Math.ceil(3000 / bytes.byteLength)).fill(bytes)).toString(
        "base64",
      );
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(lengthened);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, lengthened(item)]));
  return value;
}

type CorpusCase = { id: string; attribute: string; messages?: unknown; value?: string };
const cases: [string, string, string][] = [];
for (const item of corpus.fixtures as CorpusCase[]) {
  cases.push([item.id, item.attribute, item.value ?? JSON.stringify(item.messages)]);
  cases.push([
    `${item.id} (lengthened)`,
    item.attribute,
    item.value !== undefined
      ? (lengthened(item.value) as string)
      : JSON.stringify(lengthened(item.messages)),
  ]);
}

const MiB = 1024 * 1024;
const long = Buffer.alloc(4000, 3).toString("base64");
const text = `data:text/plain;charset=utf-8,${"caf%C3%A9 é 🎧 %20%0A".repeat(200)}`;
cases.push(
  ["percent data: URL", "input.value", JSON.stringify({ doc: text })],
  ["raw percent data: URL with a line break", "metadata", `${text}\nline two%21`],
  [
    "padded base64",
    "gen_ai.input.messages",
    JSON.stringify([
      {
        parts: [
          {
            type: "blob",
            mime_type: "audio/wav",
            content: Buffer.alloc(4001, 5).toString("base64"),
          },
        ],
      },
    ]),
  ],
  ["a long base64 key", "input.value", JSON.stringify({ [long]: { type: "blob", content: long } })],
  [
    "duplicate members",
    "input.value",
    `{"type":"blob","mime_type":"image/png","content":"${long}","content":"${Buffer.alloc(3000, 9).toString("base64")}"}`,
  ],
  ["a JSON string at the root", "input.value", JSON.stringify(`data:image/png;base64,${long}`)],
  [
    "assistant audio named by its signature",
    "gen_ai.output.messages",
    JSON.stringify([
      {
        role: "assistant",
        audio: {
          id: "a",
          data: Buffer.concat([Buffer.from("RIFF\0\0\0\0WAVE"), Buffer.alloc(4000)]).toString(
            "base64",
          ),
        },
      },
    ]),
  ],
  [
    "a text file declared base64",
    "gen_ai.input.messages",
    JSON.stringify([
      {
        parts: [
          {
            inlineData: {
              mimeType: "text/plain",
              data: Buffer.from("notes\n".repeat(20_000)).toString("base64"),
            },
          },
        ],
      },
    ]),
  ],
  [
    "an escaped slash",
    "input.value",
    `{"type":"blob","mime_type":"image/png","content":"${long.slice(0, 400)}\\/${long.slice(400)}"}`,
  ],
  ["unterminated JSON", "input.value", `{"type":"blob","mime_type":"image/png","content":"${long}`],
  [
    "a control character in a data: URL",
    "input.value",
    `{"image":"data:text/plain,${"a".repeat(400)}\u0001"}`,
  ],
  [
    "a tool call's encoded arguments",
    "gen_ai.input.messages",
    JSON.stringify([
      {
        role: "assistant",
        tool_calls: [
          {
            type: "function",
            function: {
              name: "f",
              arguments: JSON.stringify({ image: `data:image/png;base64,${long}` }),
            },
          },
        ],
      },
    ]),
  ],
  // Data ending in whitespace trims to a label Hue's reader matches (a file id), so it is parsed.
  [
    "a file id that trims to a label",
    "input.value",
    JSON.stringify({
      type: "file",
      file_id: `data:,a${" ".repeat(400)}`,
      name: "data:image/png;base64,iVBORw0KGgo=",
    }),
  ],
  [
    "a file id that trims to a label (ideographic space)",
    "input.value",
    JSON.stringify({
      type: "file",
      file: {
        file_id: `data:,a${"\u3000".repeat(400)}`,
        filename: "data:image/png;base64,iVBORw0KGgo=",
      },
    }),
  ],
  // A value that is no JSON is the file whatever it ends in, and a JSON string whose trim is no
  // label is read in place.
  [
    "a raw data: URL ending in a line break",
    "metadata",
    `data:application/octet-stream,${"hello%20world ".repeat(40)}\n`,
  ],
  [
    "a data: URL ending in spaces",
    "input.value",
    JSON.stringify({
      image: `data:application/octet-stream,${"x".repeat(400)}${" ".repeat(400)}`,
    }),
  ],
  // Percent-escaped data read a 1 Mi slice at a time: never split inside a surrogate pair or an
  // escape, and a run of lone high surrogates still moves on.
  ["a surrogate pair across slices", "metadata", `data:text/plain,${"a".repeat(MiB - 1)}😀b`],
  ["an escape across slices", "metadata", `data:text/plain,${"a".repeat(MiB - 1)}%41%42`],
  ["an escape two units before a slice", "metadata", `data:text/plain,${"a".repeat(MiB - 2)}%41`],
  ["lone high surrogates past a slice", "metadata", `data:text/plain,${"\uD800".repeat(MiB + 8)}`],
);

describe("media read in place is placed as media parsed out of the value", () => {
  for (const [name, key, value] of cases)
    for (const ok of [true, false])
      test(`${ok ? "uploaded" : "refused"}: ${name}`, async () => {
        const parsed = await place(key, value, false, ok);
        const inPlace = await place(key, value, true, ok);
        expect(inPlace).toEqual(parsed);
      });

  test("long strings are read in place, and the JSON around them is bounded", async () => {
    const value = JSON.stringify([
      { parts: [{ type: "blob", mime_type: "audio/wav", content: long }] },
    ]);
    const read = (await readLargeMediaText("gen_ai.input.messages", value, 300))!;
    expect(read.long.size).toBe(1);
    expect(read.files[0]!.content).not.toBe(long);
    // Past 8 Mi code units of JSON around its long strings, a value is not read at all.
    const padded = JSON.stringify([
      {
        parts: [
          { type: "text", content: "a\n".repeat(4.5 * 1024 * 1024) },
          { type: "blob", content: long },
        ],
      },
    ]);
    expect(await readLargeMediaText("gen_ai.input.messages", padded, 300)).toBeUndefined();
    // The scan stops at the bound: 64 Mi code units of escaped text before a file are not read
    // to their end.
    const escapedFirst = `[{"parts":[{"type":"text","content":"${"a\\n".repeat(32 * MiB)}"},{"type":"blob","content":"${long}"}]}]`;
    const started = performance.now();
    expect(await readLargeMediaText("gen_ai.input.messages", escapedFirst, 300)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

type Placement = {
  id: string;
  attribute: string;
  valueBytes: number;
  value: string;
  success: Record<string, unknown>;
  failure: Record<string, unknown>;
};

describe("shared placements", () => {
  for (const item of (corpus as unknown as { placements: Placement[] }).placements)
    for (const ok of [true, false])
      test(`${ok ? "uploaded" : "refused"}: ${item.id}`, async () => {
        const expected = item[ok ? "success" : "failure"];
        for (const large of [false, true]) {
          const placed = await place(item.attribute, item.value, large, ok, item.valueBytes);
          expect({
            value: placed.value,
            entries: placed.entries ?? [],
            truncated: placed.truncated ?? [],
            uploaded: placed.uploaded,
            fallbacks: Object.fromEntries(placed.fallbacks),
          }).toEqual(expected as never);
        }
      });
});
