import { ConversionError, convertAtifExport, isObject } from "../traces-import-convert.js";
import type { ImportAdapter } from "./adapter.js";

/** Text ATIF v1.7 and v1.8 exports, one standalone document each, converted whole. */
export const atif: ImportAdapter = {
  id: "atif",
  manifestFormat: "atif",
  detect: (value) =>
    isObject(value) &&
    typeof value.schema_version === "string" &&
    value.schema_version.startsWith("ATIF-"),
  convert(value, context) {
    if (!isObject(value) || !Array.isArray(value.steps))
      throw new ConversionError("an ATIF document without steps");
    const { text, unsafeIntegers, bytes } = context.source;
    context.trace(convertAtifExport({ text, document: value, unsafeIntegers }, bytes));
  },
};
