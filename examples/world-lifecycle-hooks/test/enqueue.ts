import { readFileSync } from "node:fs";
import { configSchema, loginEvent } from "../src/contracts.ts";
import { Store } from "../src/store.ts";
const [configFile, directory, requestId] = process.argv.slice(2);
if (!configFile || !directory || !requestId) throw new Error("missing_test_arguments");
const config = configSchema.parse(JSON.parse(readFileSync(configFile, "utf8")));
const store = new Store(directory, config);
console.log("ready");
for await (const _ of process.stdin) break;
try {
  store.enqueue(
    loginEvent(config, { requestId, subjectId: "test-user", stage: "oauth", outcome: "succeeded" }),
  );
  console.log("accepted");
} catch (error) {
  if (!(error instanceof Error) || error.message !== "queue_full") throw error;
  console.log("full");
} finally {
  store.close();
}
