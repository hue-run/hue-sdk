import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import * as zlib from "node:zlib";
import { runTracesCommand } from "../src/cli/traces-import.js";
import type { TraceImportManifest } from "../src/cli/traces-import-convert.js";
import { decodeContainer, parseValues, readZstd } from "../src/cli/import-formats/containers.js";
import { ImportReader } from "../src/cli/import-formats/reader.js";
import { RowTraceCollector, type SpanRow } from "../src/cli/import-formats/rows.js";

// Damaged, deep, huge and malformed inputs: each refuses only what it damages, never the run.
// Synthetic exports only; nothing leaves the machine.

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function scratch(files: Record<string, Uint8Array | string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hue-robustness-"));
  directories.push(root);
  for (const [name, bytes] of Object.entries(files)) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), bytes);
  }
  return root;
}

async function prepare(input: string, ...flags: string[]) {
  let stdout = "";
  let stderr = "";
  const sink = (append: (text: string) => void) =>
    new Writable({ write: (chunk, _encoding, done) => (append(String(chunk)), done()) });
  const code = await runTracesCommand(
    ["import", "prepare", input, "--json", "--out", join(input, "..", "out"), ...flags],
    { stdout: sink((text) => (stdout += text)), stderr: sink((text) => (stderr += text)) },
  );
  return { code, stderr, report: code === 0 ? (JSON.parse(stdout) as Record<string, any>) : {} };
}

interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: { key: string; value: Record<string, any> }[];
  events?: { name: string }[];
  links?: { traceId: string; spanId: string }[];
}

async function spans(report: Record<string, any>, traceId: string): Promise<Span[]> {
  const out = report.output_directory as string;
  const manifest = JSON.parse(
    await readFile(join(out, "manifest.json"), "utf8"),
  ) as TraceImportManifest;
  const trace = manifest.traces.find((item) => item.trace_id === traceId);
  if (!trace) throw new Error(`no trace ${traceId}`);
  const found: Span[] = [];
  for (const batch of trace.batches) {
    const body = await readFile(join(out, `${traceId}.${batch.sha256}.json.gz`));
    const decoded = JSON.parse(zlib.gunzipSync(body).toString("utf8")) as {
      resourceSpans: { scopeSpans: { spans: Span[] }[] }[];
    };
    for (const group of decoded.resourceSpans)
      for (const scope of group.scopeSpans) found.push(...scope.spans);
  }
  return found;
}

const str = (span: Span, key: string) =>
  span.attributes.find((item) => item.key === key)?.value.stringValue as string | undefined;
const hex = (value: number, length: number) => value.toString(16).padStart(length, "0");
/** A trace's emitted id when its source id is no OpenTelemetry id. */
const derived = (format: string, key: string) =>
  createHash("sha256").update(`${format}.trace:${key}`).digest("hex").slice(0, 32);
const T = (n: number) => hex(n, 32);
const S = (n: number) => hex(n, 16);

/** A Zipkin v2 span; `timestamp` in microseconds. */
const zipkin = (trace: number, id: number, parent?: number, fields: Record<string, unknown> = {}) =>
  JSON.stringify({
    traceId: T(trace),
    id: S(id),
    ...(parent !== undefined ? { parentId: S(parent) } : {}),
    name: `s${id}`,
    timestamp: 1_760_000_000_000_000 + id,
    duration: 5,
    ...fields,
  });

/** An OTLP/JSON document of the spans. */
const otlp = (spanList: Record<string, unknown>[]) =>
  JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: spanList }] }] });
const otlpSpan = (
  trace: number,
  id: number,
  fields: Record<string, unknown> = {},
): Record<string, unknown> => ({
  traceId: T(trace),
  spanId: S(id),
  name: `span ${id}`,
  startTimeUnixNano: "1760000000000000000",
  endTimeUnixNano: "1760000001000000000",
  ...fields,
});

describe("deep and large inputs", () => {
  test("converts parent chains tens of thousands deep without a stack overflow", async () => {
    // A Zipkin chain without durations (each end comes from the child), an untimed chain and an
    // OTLP chain whose children start before their parents each walked thousands of levels.
    const depth = 30_000;
    const untimedChain = Array.from({ length: depth }, (_, index) =>
      zipkin(2, index + 1, index ? index : undefined, { duration: undefined }),
    );
    const otlpChain = Array.from({ length: depth }, (_, index) =>
      otlpSpan(3, index + 1, {
        ...(index ? { parentSpanId: S(index) } : {}),
        startTimeUnixNano: String(1_760_000_000_000_000_000n - BigInt(index) * 1000n),
      }),
    );
    const root = await scratch({
      "chain.jsonl": untimedChain.join("\n"),
      "skew.json": otlp(otlpChain),
    });
    const { code, report } = await prepare(root);
    expect(code).toBe(0);
    expect(report.totals.traces).toBe(2);
    expect(report.traces.refused).toEqual([]);
    const chain = await spans(report, T(2));
    expect(chain).toHaveLength(depth);
    // The deepest span's end is its own start; every ancestor ends with it.
    const top = chain.find((span) => span.spanId === S(1))!;
    expect(top.endTimeUnixNano).toBe(String((1_760_000_000_000_000n + BigInt(depth)) * 1000n));
  });

  test("names a value nested too deep to read and reads the rest of the input", async () => {
    const deep = (levels: number) => "[".repeat(levels) + "]".repeat(levels);
    const deepContent = `${'{"x":'.repeat(3000)}1${"}".repeat(3000)}`;
    const langfusePage = {
      data: [
        {
          id: "obs-1",
          traceId: "lf-trace-1",
          projectId: "project-1",
          type: "SPAN",
          name: "chat",
          startTime: "2026-10-01T10:00:00.000Z",
          input: deep(5000),
          metadata: { note: deep(5000) },
        },
      ],
    };
    const root = await scratch({
      "lines.jsonl": [zipkin(1, 1), deep(5000)].join("\n"),
      "chat.json": `{"messages":[{"role":"user","content":${deepContent}}]}`,
      "langfuse.json": JSON.stringify(langfusePage),
    });
    const { code, report } = await prepare(root);
    expect(code).toBe(0);
    expect(report.formats).toEqual({ langfuse: 1, zipkin: 1 });
    expect(report.files.skipped).toEqual([
      { file: "lines.jsonl", line: 2, record: 1, reason: "JSON nested more than 512 levels deep" },
    ]);
    expect(report.files.unsupported).toEqual([
      { file: "chat.json", reason: "JSON nested more than 512 levels deep" },
    ]);
    // JSON text nested too deep to read is kept as the text it is.
    const [observation] = await spans(report, derived("langfuse", "lf-trace-1"));
    expect(str(observation!, "input.value")).toBe(deep(5000));
  });

  test("lists a JSON array no format reads without reading every record", async () => {
    const records = Array.from({ length: 5000 }, (_, index) => ({ n: index }));
    const row = { span_id: "s1", root_span_id: "s1", input: "Hello", metrics: { start: 1 } };
    const root = await scratch({
      "noise.json": JSON.stringify(records),
      "late.json": JSON.stringify([...records.slice(0, 1200), row]),
      "mixed.json": JSON.stringify([row, ...records.slice(0, 1500)]),
    });
    const { code, report } = await prepare(root);
    expect(code).toBe(0);
    // Past 1,000 records in a row from the start that no format reads, the array is not read on.
    expect(report.files.unsupported).toEqual([
      { file: "late.json", reason: "a JSON array of no recognized format" },
      { file: "noise.json", reason: "a JSON array of no recognized format" },
    ]);
    // Past 100 records reported in one file, the rest are counted.
    const mixed = report.files.skipped.filter(
      (item: { file: string }) => item.file === "mixed.json",
    );
    expect(mixed).toHaveLength(101);
    expect(mixed[0]).toEqual({
      file: "mixed.json",
      record: 2,
      reason: "a JSON document of no recognized format",
    });
    expect(mixed.at(-1)).toEqual({ file: "mixed.json", reason: "1400 more records were not read" });
  });
});

describe("the input bound", () => {
  test("refuses an input past 256 MiB decompressed, naming the bound and the remedy", async () => {
    // Five files that compress to almost nothing and decompress to 60 MiB each.
    const blank = zlib.gzipSync(Buffer.alloc(60 * 1024 * 1024, 0x20));
    const files = Object.fromEntries(
      ["a", "b", "c", "d", "e"].map((name) => [`${name}.json.gz`, blank]),
    );
    const { code, stderr } = await prepare(await scratch(files));
    expect(code).not.toBe(0);
    expect(stderr).toContain(
      "The input holds more than 268435456 bytes decompressed; prepare it in parts of at most that size",
    );
    // Decompressing 300 MiB takes about 5 s, past bun test's default deadline.
  }, 60_000);
});

describe("malformed records", () => {
  test("refuses an OTLP span with a malformed attribute value, and only its trace", async () => {
    const values = [
      { arrayValue: [] },
      { arrayValue: { values: [null] } },
      { kvlistValue: [] },
      { kvlistValue: { values: [null] } },
    ];
    const root = await scratch({
      "bad.json": otlp(
        values.map((value, index) => otlpSpan(index + 1, 1, { attributes: [{ key: "x", value }] })),
      ),
      "resource.json": JSON.stringify({
        resourceSpans: [
          {
            resource: { attributes: [{ key: "r", value: { kvlistValue: { values: [7] } } }] },
            scopeSpans: [{ spans: [otlpSpan(5, 1)] }],
          },
        ],
      }),
      "good.jsonl": zipkin(9, 1),
    });
    const { code, report } = await prepare(root);
    expect(code).toBe(0);
    expect(report.formats).toEqual({ zipkin: 1 });
    expect(report.traces.refused.map((item: { trace_id: string }) => item.trace_id).sort()).toEqual(
      [T(1), T(2), T(3), T(4), T(5)],
    );
  });

  test("refuses an OTLP trace whose parents close on themselves, with or without --user-key", async () => {
    const user = [{ key: "app.user", value: { stringValue: "customer-1" } }];
    const root = await scratch({
      "spans.json": otlp([
        otlpSpan(1, 1, { parentSpanId: S(2), attributes: user }),
        otlpSpan(1, 2, { parentSpanId: S(1) }),
        otlpSpan(2, 1, { parentSpanId: S(1), attributes: user }),
        otlpSpan(3, 1, { attributes: user }),
      ]),
    });
    for (const flags of [[], ["--user-key", "app.user"]]) {
      const { code, report } = await prepare(root, ...flags);
      expect(code).toBe(0);
      expect(report.traces.refused).toEqual([
        { trace_id: T(1), reason: "The source hierarchy contains a cycle" },
        { trace_id: T(2), reason: "The source hierarchy contains a cycle" },
      ]);
      expect(report.totals.traces).toBe(1);
      await rm(report.output_directory, { recursive: true, force: true });
    }
  });

  test("--user-key adds its span under the agent's root, never under a tool span", async () => {
    // A tool span whose parent is outside the export starts first; the agent's own root later.
    const root = await scratch({
      "spans.json": otlp([
        otlpSpan(1, 1, {
          parentSpanId: S(99),
          attributes: [{ key: "gen_ai.operation.name", value: { stringValue: "execute_tool" } }],
        }),
        otlpSpan(1, 2, {
          startTimeUnixNano: "1760000000500000000",
          attributes: [
            { key: "gen_ai.operation.name", value: { stringValue: "invoke_agent" } },
            { key: "app.user", value: { stringValue: "customer-1" } },
          ],
        }),
      ]),
    });
    const { code, report } = await prepare(root, "--user-key", "app.user");
    expect(code).toBe(0);
    expect(report.traces.without_identity).toBe(0);
    const added = (await spans(report, T(1))).find((span) => span.name === "hue.import.user")!;
    expect(added.parentSpanId).toBe(S(2));
    expect(str(added, "user.id")).toBe("customer-1");
  });

  test("reads a line of NaN as null, names it, and names a line that is not UTF-8", async () => {
    // Python's json.dumps writes a float it cannot represent as a bare NaN or Infinity.
    const withNan = zipkin(2, 1).replace('"duration":5', '"duration":NaN');
    const root = await scratch({
      "nan.jsonl": [zipkin(1, 1), withNan].join("\n"),
      "nan-doc.json": `[${zipkin(3, 1).replace('"duration":5', '"duration":-Infinity')}]`,
      "latin1.jsonl": Buffer.concat([
        Buffer.from(`${zipkin(4, 1)}\n`),
        Buffer.from(zipkin(5, 1, undefined, { name: "caf?" }).replace("?", "\u00e9"), "latin1"),
        Buffer.from(`\n${zipkin(6, 1)}`),
      ]),
      "utf16.json": Buffer.from(`\uFEFF${zipkin(7, 1)}`, "utf16le"),
    });
    const { code, report } = await prepare(root);
    expect(code).toBe(0);
    expect(report.totals.traces).toBe(6);
    expect(report.files.notes).toEqual([
      { file: "nan-doc.json", reason: "NaN or Infinity, which JSON cannot hold, read as null" },
      {
        file: "nan.jsonl",
        line: 2,
        reason: "NaN or Infinity, which JSON cannot hold, read as null",
      },
    ]);
    expect(report.files.skipped).toEqual([
      { file: "latin1.jsonl", line: 2, reason: "not UTF-8 text" },
    ]);
  });

  test("notes records that collapse into one trace", async () => {
    const line = JSON.stringify({ messages: [{ role: "user", content: "Hello" }] });
    const root = await scratch({ "chat.jsonl": [line, line, line].join("\n") });
    const { code, report } = await prepare(root);
    expect(code).toBe(0);
    expect(report.totals.traces).toBe(1);
    expect(report.files.notes).toEqual([
      { file: "chat.jsonl", line: 2, reason: "the same record as line 1, read once" },
      { file: "chat.jsonl", line: 3, reason: "the same record as line 1, read once" },
    ]);
  });
});

describe("damaged containers", () => {
  const lines = (from: number, count: number) =>
    Array.from({ length: count }, (_, index) => zipkin(from + index, 1)).join("\n") + "\n";

  test("reads the complete lines of a truncated gzip file and names the break", async () => {
    const whole = zlib.gzipSync(Buffer.from(lines(1, 10)));
    const decoded = decodeContainer(whole.subarray(0, whole.byteLength - 30), 1 << 20);
    expect(decoded).toMatchObject({
      note: "the gzip file breaks off; what follows the last complete line was not read",
    });
    // The complete lines before the break are read; the broken last one is named.
    const parsed = parseValues((decoded as { bytes: Uint8Array }).bytes);
    if (!("values" in parsed)) throw new Error(parsed.unsupported);
    expect(parsed.values.length).toBeGreaterThanOrEqual(3);
    expect(parsed.problems).toEqual([{ line: parsed.values.length + 1, reason: "truncated JSON" }]);
    const trailing = decodeContainer(Buffer.concat([whole, Buffer.from("garbage")]), 1 << 20);
    expect(trailing).toMatchObject({
      note: "7 bytes after the last gzip member are not gzip and were not read",
    });
    expect(Buffer.from((trailing as { bytes: Uint8Array }).bytes).toString()).toBe(lines(1, 10));
    // A file that reads whole but fails its checksum is not trusted; what its member decompressed
    // to still counts against the input's bound.
    const corrupt = Buffer.from(whole);
    corrupt[corrupt.byteLength - 6]! ^= 0xff;
    const size = Buffer.byteLength(lines(1, 10));
    expect(decodeContainer(corrupt, 1 << 20)).toEqual({
      unsupported: "a damaged gzip file",
      held: size,
      counted: size,
    });
  });

  test("reads no member of a gzip file read up to a break when a member fails its checksum", () => {
    const first = zlib.gzipSync(Buffer.from(lines(1, 3)));
    const second = zlib.gzipSync(Buffer.from(lines(4, 7)));
    // The CRC-32, then the size, of the first member's data.
    const size = Buffer.byteLength(lines(1, 3));
    for (const at of [first.byteLength - 8, first.byteLength - 4]) {
      const corrupt = Buffer.from(first);
      corrupt[at]! ^= 0xff;
      for (const rest of [Buffer.from("garbage"), second.subarray(0, 20)])
        expect(decodeContainer(Buffer.concat([corrupt, second, rest]), 1 << 20)).toEqual({
          unsupported: "a damaged gzip file",
          held: size,
          counted: size,
        });
    }
    // The members that match their trailers are read up to the break.
    expect(
      decodeContainer(Buffer.concat([first, second, Buffer.from("garbage")]), 1 << 20),
    ).toEqual({
      bytes: Buffer.from(lines(1, 3) + lines(4, 7)),
      note: "7 bytes after the last gzip member are not gzip and were not read",
    });
  });

  test("checks the CRC-32 of a gzip member whose file breaks off inside its size", () => {
    const first = zlib.gzipSync(Buffer.from(lines(1, 3)));
    const second = zlib.gzipSync(Buffer.from(lines(4, 7)));
    const wrong = Buffer.from(second);
    wrong[wrong.byteLength - 8]! ^= 0xff;
    // The file holds the last member's whole CRC-32 and none or part of its size.
    const sizes = [lines(1, 3), lines(4, 7)].map((text) => Buffer.byteLength(text));
    for (const cut of [4, 2])
      for (const members of [[wrong], [first, wrong]]) {
        const held = members.length === 1 ? sizes[1]! : sizes[0]! + sizes[1]!;
        expect(decodeContainer(Buffer.concat(members).subarray(0, -cut), 1 << 20)).toEqual({
          unsupported: "a damaged gzip file",
          held,
          counted: held,
        });
      }
    // A matching CRC-32 is read up to the break.
    expect(decodeContainer(Buffer.concat([first, second]).subarray(0, -4), 1 << 20)).toEqual({
      bytes: Buffer.from(lines(1, 3) + lines(4, 7)),
      note: "the gzip file breaks off; what follows the last complete line was not read",
    });
  });

  test.skipIf(typeof zlib.zstdCompressSync !== "function")(
    "reads every frame of a zstd file, passes skippable frames and names a break or trailing bytes",
    async () => {
      const first = zlib.zstdCompressSync(Buffer.from(lines(1, 3)));
      const second = zlib.zstdCompressSync(Buffer.from(lines(4, 7)));
      // pzstd opens with a skippable frame naming the frame sizes.
      const skippable = Buffer.from([0x50, 0x2a, 0x4d, 0x18, 4, 0, 0, 0, 1, 2, 3, 4]);
      const text = (bytes: Uint8Array) => {
        const decoded = decodeContainer(bytes, 1 << 20);
        if ("unsupported" in decoded) return decoded;
        return { text: Buffer.from(decoded.bytes).toString(), note: decoded.note };
      };
      expect(text(Buffer.concat([first, second]))).toEqual({
        text: lines(1, 3) + lines(4, 7),
        note: undefined,
      });
      expect(text(Buffer.concat([skippable, first, second]))).toEqual({
        text: lines(1, 3) + lines(4, 7),
        note: undefined,
      });
      expect(text(Buffer.concat([first, Buffer.from("tail")]))).toEqual({
        text: lines(1, 3),
        note: "4 bytes after the last zstd frame are not zstd and were not read",
      });
      expect(text(Buffer.concat([first, second.subarray(0, 10)]))).toEqual({
        text: lines(1, 3),
        note: "the zstd file breaks off; what follows the last complete frame was not read",
      });
      expect(text(first.subarray(0, first.byteLength - 3))).toEqual({
        unsupported: "a truncated zstd file",
      });
      const root = await scratch({ "two-frames.jsonl.zst": Buffer.concat([first, second]) });
      const { code, report } = await prepare(root);
      expect(code).toBe(0);
      expect(report.totals.traces).toBe(10);
    },
  );

  test.skipIf(typeof zlib.zstdCompressSync !== "function")(
    "reads no frame of a zstd file when a later frame fails its checksum or declared size",
    () => {
      const checksummed = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
      const first = zlib.zstdCompressSync(Buffer.from(lines(1, 3)), checksummed);
      const second = zlib.zstdCompressSync(Buffer.from(lines(4, 7)), checksummed);
      const corrupt = Buffer.from(second);
      corrupt[corrupt.byteLength - 1]! ^= 0xff;
      // A frame counts what it holds, at least 128 bytes, and a damaged one at least 1 MiB; what
      // the frames decompressed to is held.
      const [size, secondSize] = [lines(1, 3), lines(4, 7)].map((text) => Buffer.byteLength(text));
      const damage = size! + 1024 * 1024;
      const refused = (held: number) => ({
        unsupported: "a damaged zstd file",
        held: size! + held,
        counted: damage,
      });
      expect(decodeContainer(Buffer.concat([first, corrupt]), 1 << 20)).toEqual(
        refused(secondSize!),
      );
      // A frame whose content is one byte longer or shorter than its header declares, with a
      // checksum or without one, as gzip's size field: the low byte of the declared size.
      for (const frame of [second, zlib.zstdCompressSync(Buffer.from(lines(4, 7)))])
        for (const flip of [1, 2]) {
          const resized = Buffer.from(frame);
          const descriptor = resized[4]!;
          resized[5 + ((descriptor >> 5) & 1 ? 0 : 1) + [0, 1, 2, 4][descriptor & 3]!]! ^= flip;
          expect(decodeContainer(Buffer.concat([first, resized]), 1 << 20)).toEqual(
            refused(secondSize!),
          );
        }
      // A frame that declares far less than it holds fails as a wrong source size, or as too
      // small a destination, not as corruption: it is refused the same.
      const content = Buffer.from(lines(10, 400));
      const shrunk = zlib.zstdCompressSync(content);
      const descriptor = shrunk[4]!;
      expect(descriptor >> 6).toBe(1);
      shrunk.writeUInt16LE(300 - 256, 5 + ((descriptor >> 5) & 1 ? 0 : 1));
      // Two 128 KiB runs and a raw block, in a frame that declares 300 bytes.
      const block = (last: boolean, type: number, size: number) => {
        const header = (size << 3) | (type << 1) | (last ? 1 : 0);
        return Buffer.from([header & 0xff, (header >> 8) & 0xff, header >> 16]);
      };
      const runs = Buffer.concat([
        Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x40, (17 - 10) << 3, 300 - 256, 0]),
        block(false, 1, 131_072),
        Buffer.from("A"),
        block(false, 1, 131_072),
        Buffer.from("A"),
        block(true, 0, 4),
        Buffer.from("tail"),
      ]);
      expect(decodeContainer(Buffer.concat([first, shrunk]), 1 << 20)).toEqual(
        refused(content.byteLength),
      );
      expect(decodeContainer(Buffer.concat([first, runs]), 1 << 20)).toEqual(refused(262_148));
      // A frame whose blocks do not decompress (literals that name a table the frame never
      // set) is damage the read stops at, as gzip's is.
      const damaged = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0, 0x25, 0, 0, 0x03, 0, 0, 0]);
      expect(decodeContainer(Buffer.concat([first, damaged, second]), 1 << 20)).toEqual({
        bytes: Buffer.from(lines(1, 3)),
        note: "the zstd file is damaged; what follows the damage was not read",
        counted: damage,
      });
      // A frame that breaks off is still read up to the break.
      expect(decodeContainer(Buffer.concat([first, second.subarray(0, -2)]), 1 << 20)).toEqual({
        bytes: Buffer.from(lines(1, 3)),
        note: "the zstd file breaks off; what follows the last complete frame was not read",
      });
    },
  );

  test.skipIf(typeof zlib.zstdCompressSync !== "function")(
    "reads more than 65,536 zstd frames when what they hold is within the bound",
    () => {
      // A JSON Lines file written one frame per record: 70,000 frames of 300 bytes hold 21 MB.
      const line = Buffer.from(`${JSON.stringify({ text: "x".repeat(288) })}\n`);
      const frame = zlib.zstdCompressSync(line);
      const decoded = decodeContainer(
        Buffer.concat(Array.from({ length: 70_000 }, () => frame)),
        64 * 1024 * 1024,
      );
      if ("unsupported" in decoded) throw new Error(decoded.unsupported);
      expect(line.byteLength).toBe(300);
      expect(decoded.bytes.byteLength).toBe(70_000 * 300);
      expect(decoded.counted).toBeUndefined();
    },
  );

  test.skipIf(typeof zlib.zstdCompressSync !== "function")(
    "counts each zstd frame at least 128 bytes and holds a tiny one at its size",
    () => {
      const tiny = (count: number) =>
        Buffer.concat(
          Array.from({ length: count }, () => zlib.zstdCompressSync(Buffer.from("\n"))),
        );
      const read = readZstd(tiny(500), 1 << 20);
      if (read.kind !== "read") throw new Error(`read as ${read.kind}`);
      expect(read.frames).toBe(500);
      expect(read.size).toBe(500 * 128);
      // zlib decompresses each frame into a 16 KiB chunk; only the byte it holds is kept.
      expect(read.bytes.toString()).toBe("\n".repeat(500));
      expect(read.bytes.buffer.byteLength).toBeLessThan(65_536);
      // The bound limits how many frames a file holds. Past it, the file is refused for its
      // frames, with the advice to decompress it first, and counts past the bound against the
      // input's. 8,192 tiny frames fill 1 MiB.
      expect(decodeContainer(tiny(8_193), 1 << 20)).toEqual({
        unsupported:
          "a zstd file whose frames count for more than 1048576 bytes, each at least 128; decompress it first",
        held: 8_192,
        counted: (1 << 20) + 1,
      });
      // Content past the bound is named as such.
      expect(
        decodeContainer(zlib.zstdCompressSync(Buffer.alloc((1 << 20) + 1, 0x20)), 1 << 20),
      ).toEqual({
        unsupported: "a zstd file that decompresses to more than 1048576 bytes",
        held: (1 << 20) + 1,
        counted: (1 << 20) + 1,
      });
    },
  );

  test.skipIf(typeof zlib.zstdCompressSync !== "function")(
    "copies each zstd frame's output before decompressing the next, holding no frame's chunk",
    () => {
      // An output the read still needed after the next frame's would be overwritten here: each
      // is overwritten two frames later.
      const decompress = zlib.zstdDecompressSync;
      const outputs: Buffer[] = [];
      const spy = spyOn(zlib, "zstdDecompressSync").mockImplementation(((
        frame: Uint8Array,
        options?: zlib.ZstdOptions,
      ) => {
        outputs.at(-2)?.fill(0);
        const output = decompress(frame, options);
        outputs.push(output);
        return output;
      }) as typeof zlib.zstdDecompressSync);
      try {
        const records = Array.from({ length: 100 }, (_, index) => `${index}\n`);
        const read = readZstd(
          Buffer.concat(records.map((record) => zlib.zstdCompressSync(Buffer.from(record)))),
          1 << 20,
        );
        if (read.kind !== "read") throw new Error(`read as ${read.kind}`);
        expect(outputs).toHaveLength(100);
        expect(read.bytes.toString()).toBe(records.join(""));
      } finally {
        spy.mockRestore();
      }
    },
  );

  test("reads a damaged gzip file member by member, each counted at least 128 bytes", () => {
    const records = (count: number) => Array.from({ length: count }, (_, index) => `${index}\n`);
    // Bytes after the last member send the file through the member-by-member read.
    const members = (count: number) =>
      Buffer.concat([
        ...records(count).map((record) => zlib.gzipSync(Buffer.from(record))),
        Buffer.from("garbage"),
      ]);
    // Each member's output is copied before the next is inflated, as each zstd frame's is.
    const inflate = zlib.inflateRawSync;
    const outputs: Buffer[] = [];
    const spy = spyOn(zlib, "inflateRawSync").mockImplementation(((
      data: zlib.InputType,
      options?: zlib.ZlibOptions,
    ) => {
      outputs.at(-2)?.fill(0);
      const inflated = inflate(data, options) as unknown as { buffer: Buffer };
      outputs.push(inflated.buffer);
      return inflated;
    }) as unknown as typeof zlib.inflateRawSync);
    try {
      expect(decodeContainer(members(100), 1 << 20)).toEqual({
        bytes: Buffer.from(records(100).join("")),
        note: "7 bytes after the last gzip member are not gzip and were not read",
        counted: 100 * 128,
      });
      expect(outputs).toHaveLength(100);
    } finally {
      spy.mockRestore();
    }
    // 8,192 tiny members fill 1 MiB, as tiny zstd frames do.
    expect(decodeContainer(members(8_193), 1 << 20)).toEqual({
      unsupported:
        "a gzip file whose members count for more than 1048576 bytes, each at least 128; decompress it first",
      held: Buffer.byteLength(records(8_192).join("")),
      counted: (1 << 20) + 1,
    });
  });

  test.skipIf(typeof zlib.zstdCompressSync !== "function")(
    "reads a zstd frame again without its checks only when they could be its damage",
    () => {
      const checksummed = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
      const mismatched = zlib.zstdCompressSync(Buffer.from(lines(1, 3)), checksummed);
      mismatched[mismatched.byteLength - 1]! ^= 0xff;
      // Blocks that do not decompress, in a frame that declares no size, no single segment and
      // no checksum, and in one with a checksum, which the damage comes before.
      const blocks = [0x25, 0, 0, 0x03, 0, 0, 0];
      const bare = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0, ...blocks]);
      const checked = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 4, 0, ...blocks, 0, 0, 0, 0]);
      const decompress = spyOn(zlib, "zstdDecompressSync");
      try {
        const reads = (frame: Buffer) => {
          decompress.mockClear();
          const read = readZstd(frame, 1 << 22);
          return [read.kind, decompress.mock.calls.length];
        };
        expect(reads(mismatched)).toEqual(["mismatched", 2]);
        expect(reads(bare)).toEqual(["read", 1]);
        expect(reads(checked)).toEqual(["read", 1]);
      } finally {
        decompress.mockRestore();
      }
      // A file that does not decompress counts at least 1 MiB against the input's bound, so
      // many of them stop the run instead of each costing a decompression.
      const reader = new ImportReader({ maxFileBytes: 64 * 1024 * 1024 });
      expect(reader.read("damaged.jsonl.zst", bare)).toEqual({
        held: bare.byteLength,
        counted: 1024 * 1024,
      });
    },
  );

  test.skipIf(typeof zlib.zstdCompressSync !== "function")(
    "counts a file over its bound past the bound against the input's",
    () => {
      // Each is decompressed up to the bound before it is refused, so the input bound limits how
      // many are.
      const reader = new ImportReader({ maxFileBytes: 1 << 20 });
      const over = Buffer.alloc((1 << 20) + 1, 0x20);
      const past = { held: (1 << 20) + 1, counted: (1 << 20) + 1 };
      expect(reader.read("big.json.gz", zlib.gzipSync(over))).toEqual(past);
      expect(reader.read("big.json.zst", zlib.zstdCompressSync(over))).toEqual(past);
      const tiny = zlib.zstdCompressSync(Buffer.from("\n"));
      expect(
        reader.read("frames.jsonl.zst", Buffer.concat(Array.from({ length: 8_193 }, () => tiny))),
      ).toEqual({ held: 8_193 * tiny.byteLength, counted: (1 << 20) + 1 });
    },
  );
});

describe("the input bound, counted", () => {
  test.skipIf(typeof zlib.zstdCompressSync !== "function")(
    "names what the input counts for when its damage, not its content, passes the bound",
    async () => {
      // 257 zstd files that do not decompress, each counted as 1 MiB, hold a few kilobytes.
      const bare = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0, 0x25, 0, 0, 0x03, 0, 0, 0]);
      const files = Object.fromEntries(
        Array.from({ length: 257 }, (_, index) => [`damaged-${index}.jsonl.zst`, bare]),
      );
      const { code, stderr } = await prepare(await scratch(files));
      expect(code).not.toBe(0);
      expect(stderr).toContain(
        "The input counts for more than 268435456 bytes, each zstd frame or gzip member read on its own at least 128 and a damaged zstd frame at least 1048576; prepare it in parts, each to its own --out",
      );
    },
  );
});

describe("Node.js without zstd", () => {
  test("the package check loads where node:zlib has no zstd", async () => {
    // Node.js 22.12 to 22.14 have no zstd in node:zlib; these hooks serve node:zlib without it.
    const root = await scratch({
      "hooks.mjs": `
        export async function resolve(specifier, context, next) {
          if (specifier === "node:zlib" || specifier === "zlib")
            return { url: "hue-test:zlib-without-zstd", shortCircuit: true };
          return next(specifier, context);
        }
        export async function load(url, context, next) {
          if (url !== "hue-test:zlib-without-zstd") return next(url, context);
          const names = Object.keys(process.getBuiltinModule("node:zlib")).filter(
            (name) => !/zstd/i.test(name),
          );
          const source = [
            'const zlib = process.getBuiltinModule("node:zlib");',
            ...names.map((name) => \`export const \${name} = zlib.\${name};\`),
          ].join("\\n");
          return { format: "module", source, shortCircuit: true };
        }`,
      "register.mjs":
        'import { register } from "node:module"; register("./hooks.mjs", import.meta.url);',
    });
    // Conflicting options stop the check as soon as its imports have loaded.
    const run = spawnSync(
      "node",
      [
        "--import",
        join(root, "register.mjs"),
        join(import.meta.dir, "..", "scripts", "verify-package.mjs"),
        "--archive",
        "sdk.tgz",
        "--registry-version",
        "0.0.0",
      ],
      { encoding: "utf8" },
    );
    expect(run.stderr).not.toContain("does not provide an export named");
    expect(run.stderr).toContain("Choose an archive or registry version");
    expect(run.status).not.toBe(0);
  });
});

describe("the row emitter at scale", () => {
  const row = (spanKey: string, fields: Partial<SpanRow> = {}): SpanRow => ({
    traceKey: "trace-1",
    spanKey,
    name: spanKey,
    record: { id: spanKey },
    ...fields,
  });

  test("keeps identical events of different spans, and of one span, each once per source", () => {
    const collector = new RowTraceCollector("synthetic");
    collector.add(row("a", { start: 1_000n }), "d".repeat(64));
    collector.add(row("b", { start: 2_000n, parentKey: "a" }), "d".repeat(64));
    const retry = { name: "retry", record: { name: "retry", attempt: 1 } };
    // One value repeats the event on span a and gives it once to span b; reading the same value
    // again (a copy of the file) adds nothing.
    for (let read = 0; read < 2; read++) {
      const repeats = new Map<string, number>();
      for (const spanKey of ["a", "a", "b"])
        collector.addEvent({ traceKey: "trace-1", spanKey, ...retry }, "d".repeat(64), repeats);
    }
    const [trace] = collector.finish().traces;
    const counts = trace!.entries.map(
      (entry) => ((entry.scopeSpans[0]!.spans[0]!.events as unknown[] | undefined) ?? []).length,
    );
    expect(counts).toEqual([2, 1]);
  });

  test("checks the hierarchy and fills instants in time proportional to the spans", () => {
    const collector = new RowTraceCollector("synthetic");
    const count = 40_000;
    for (let index = 0; index < count; index++)
      collector.add(
        row(`s${index}`, {
          ...(index ? { parentKey: `s${index - 1}` } : {}),
          start: BigInt(1_000 + index),
        }),
        "d".repeat(64),
      );
    const started = performance.now();
    const { traces, refused } = collector.finish();
    expect(refused).toEqual([]);
    expect(traces[0]!.entries).toHaveLength(count);
    // A quadratic pass over 40,000 spans takes minutes; a linear one, about a second.
    expect(performance.now() - started).toBeLessThan(20_000);
  });
});
