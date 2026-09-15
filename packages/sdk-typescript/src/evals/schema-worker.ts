import { parentPort, workerData } from "node:worker_threads";
import { Ajv2020 } from "ajv/dist/2020.js";

try {
  // No asynchronous loading, custom formats, coercion, defaults or data mutation.
  const ajv = new Ajv2020({ strict: false, allErrors: false, validateFormats: false });
  const validate = ajv.compile(workerData.schema);
  if ("$async" in validate && validate.$async) throw new Error("Async schemas are unsupported");
  parentPort!.postMessage({ match: validate(workerData.output) === true });
} catch {
  parentPort!.postMessage({ error: true });
}
parentPort!.close();
