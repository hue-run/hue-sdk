import { expect, test } from "bun:test";
import { json, valueBounds } from "../src/evals/json.js";

/** The error `json` throws for a value, and how long it took to throw it. */
function refusal(value: unknown): { error: unknown; elapsed: number } {
  const started = performance.now();
  try {
    json(value);
  } catch (error) {
    return { error, elapsed: performance.now() - started };
  }
  throw new Error("Expected the value to be refused");
}

test("the byte bound is the JSON text's exact UTF-8 length, escapes and multibyte text included", () => {
  // A quote or backslash escapes to two bytes, a control character to six; é, € and 😀 take two,
  // three and four bytes.
  const sample = { 'k"\\': ['"\\\n\u0001é€😀', 1.5, -0, true, false, null, [], {}] };
  const exact = Buffer.byteLength(JSON.stringify(sample));
  expect(() => json(sample, { ...valueBounds, bytes: exact })).not.toThrow();
  expect(() => json(sample, { ...valueBounds, bytes: exact - 1 })).toThrow(
    new RangeError("JSON exceeds byte limit"),
  );
});

test("a value too long to serialize is refused by its count, before it is serialized", () => {
  // On Node, serializing either throws `Invalid string length`, which is not the byte limit.
  const big = "x".repeat(50_000_000);
  for (const value of [Array(11).fill(big), "\u0001".repeat(40_000_000)]) {
    const { error, elapsed } = refusal(value);
    expect(error).toEqual(new RangeError("JSON exceeds byte limit"));
    expect(elapsed).toBeLessThan(100);
  }
});

test("an array with more elements than values allowed is refused before its keys are listed", () => {
  const { error, elapsed } = refusal(Array.from({ length: 5_000_000 }, () => 0));
  expect(error).toEqual(new RangeError("JSON exceeds depth/node limits"));
  // Listing five million keys first took seconds and hundreds of megabytes.
  expect(elapsed).toBeLessThan(100);
});

test("an object with more members than values allowed is refused before its keys are sorted", () => {
  const members = Object.fromEntries(
    Array.from({ length: 30_000 }, (_, index) => [`k${index}`, 0]),
  );
  const sort = Array.prototype.sort;
  let longestSorted = 0;
  Array.prototype.sort = function (this: unknown[], ...args) {
    longestSorted = Math.max(longestSorted, this.length);
    return sort.apply(this, args as [((a: unknown, b: unknown) => number)?]);
  } as typeof sort;
  try {
    expect(() => json(members)).toThrow(new RangeError("JSON exceeds depth/node limits"));
  } finally {
    Array.prototype.sort = sort;
  }
  expect(longestSorted).toBe(0);
});

test("an object whose keys need more bytes than are left is refused before they are sorted", () => {
  // Long keys that share a prefix, as the Python suite's: sorting them by UTF-16 code unit there
  // took seconds.
  const members = Object.fromEntries(
    Array.from({ length: 300 }, (_, index) => [
      `${"a".repeat(65_000)}${String(index).padStart(5, "0")}${index % 2 ? "😀" : "！"}`,
      0,
    ]).reverse(),
  );
  const sort = Array.prototype.sort;
  let longestSorted = 0;
  Array.prototype.sort = function (this: unknown[], ...args) {
    longestSorted = Math.max(longestSorted, this.length);
    return sort.apply(this, args as [((a: unknown, b: unknown) => number)?]);
  } as typeof sort;
  try {
    expect(() => json(members)).toThrow(new RangeError("JSON exceeds byte limit"));
  } finally {
    Array.prototype.sort = sort;
  }
  expect(longestSorted).toBe(0);
});

test("both SDKs refuse an output for the same reason", () => {
  // The Python suite checks the same outputs. Values are read in order, members by key, and each
  // is checked for its type before it is counted.
  const big = "x".repeat(300_000);
  const cases: [unknown, "bytes" | "structure" | "not JSON"][] = [
    [[big, Number.NaN], "bytes"],
    [[Number.NaN, big], "not JSON"],
    [{ b: Array(25_000).fill(0), a: big }, "bytes"],
    [[big, ...Array(25_000).fill(0)], "structure"],
    [{ "key\u0000": 1 }, "not JSON"],
    [{ "\ud800": 1 }, "not JSON"],
    // JavaScript sorts 😀 (a surrogate pair) before \uffff; by code point it sorts after.
    [{ "\uffff": Number.NaN, "😀": big }, "bytes"],
    // Keys that need more bytes than are left are refused before any member is read, counting
    // each key's code points, two quotes and a colon.
    [{ a: Number.NaN, "😀": 1, ["\uffff" + big]: 1 }, "bytes"],
    [{ a: Number.NaN, ["x".repeat(199_993)]: 1 }, "not JSON"],
    [{ a: Number.NaN, ["x".repeat(199_994)]: 1 }, "bytes"],
    [{ a: Number.NaN, ["😀".repeat(199_993)]: 1 }, "not JSON"],
    [{ a: Number.NaN, ["😀".repeat(199_994)]: 1 }, "bytes"],
  ];
  for (const [value, reason] of cases) {
    let outcome = "accepted";
    try {
      json(value);
    } catch (error) {
      outcome =
        error instanceof RangeError
          ? error.message === "JSON exceeds byte limit"
            ? "bytes"
            : "structure"
          : "not JSON";
    }
    expect(outcome).toBe(reason);
  }
});
