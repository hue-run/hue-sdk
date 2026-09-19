import { Ajv2020 } from "ajv/dist/2020.js";
import schema from "./schema.json" with { type: "json" };
import { canonical } from "./portable.js";
const ajv = new Ajv2020({ strict: false });
ajv.addFormat("uuid", /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
ajv.addFormat(
  "date-time",
  (value: string) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)),
);
ajv.addSchema(schema);
export function captureRecord<T>(definition: keyof typeof schema.$defs, input: unknown): T {
  const value: unknown = JSON.parse(canonical(input));
  const validate = ajv.getSchema(`${schema.$id}#/$defs/${definition}`);
  if (!validate?.(value)) throw new TypeError(`Invalid capture ${definition}`);
  return value as T;
}
/** JSON validation cannot alter a valid typed record's structure. */
export function copyCaptureRecord<T>(value: T): T {
  const decoded: unknown = JSON.parse(canonical(value));
  return decoded as T;
}
