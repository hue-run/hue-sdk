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
