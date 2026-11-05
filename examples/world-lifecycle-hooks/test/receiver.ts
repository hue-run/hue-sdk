import { DatabaseSync } from "node:sqlite";
import { eventSchema } from "../src/contracts.ts";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const event = eventSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
const file = process.env.TEST_RECEIVER_DB;
if (!file) throw new Error("receiver_database_missing");
const db = new DatabaseSync(file);
db.exec("PRAGMA busy_timeout=5000");
const mode = db.prepare("SELECT mode FROM control").get()?.mode;
// Prove a receiver failure does not leak its stderr through the helper or count as completion.
if (mode === "fail") {
  console.error("private-receiver-diagnostic");
  process.exit(7);
}
if (mode === "no_ack") process.exit(0);
if (Object.keys(process.env).some((name) => name.startsWith("HUE_")))
  throw new Error("control_credential_leaked");
if (mode === "hold_pipe" && event.type === "auth.outcome") {
  const descendant = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (!descendant.pid) throw new Error("descendant_missing");
  db.prepare("INSERT INTO active_adapters VALUES(?)").run(descendant.pid);
  descendant.unref();
  db.close();
  process.exit(0);
}
if (mode === "delay_auth" && event.type === "auth.outcome") {
  db.prepare("INSERT INTO active_adapters VALUES(?)").run(process.pid);
  await delay(40_000);
}
db.exec("BEGIN IMMEDIATE");
const applied =
  db
    .prepare("INSERT OR IGNORE INTO receipts(id,payload) VALUES (?,?)")
    .run(event.idempotencyKey, JSON.stringify(event)).changes > 0;
if (applied && event.type === "world.ended") {
  db.prepare("INSERT OR IGNORE INTO terminal VALUES(?,?,?)").run(
    event.scope.projectId,
    event.scope.worldId,
    event.scope.connectionId,
  );
  db.prepare("DELETE FROM connections WHERE project_id=? AND world_id=? AND connection_id=?").run(
    event.scope.projectId,
    event.scope.worldId,
    event.scope.connectionId,
  );
}
if (applied && event.type === "auth.outcome") {
  const ended = db
    .prepare("SELECT 1 FROM terminal WHERE project_id=? AND world_id=? AND connection_id=?")
    .get(event.scope.projectId, event.scope.worldId, event.scope.connectionId);
  if (!ended && event.login.outcome === "succeeded") {
    db.prepare("INSERT OR IGNORE INTO connections VALUES(?,?,?)").run(
      event.scope.projectId,
      event.scope.worldId,
      event.scope.connectionId,
    );
  }
  db.prepare("INSERT INTO auth_effects VALUES(?,?)").run(
    event.idempotencyKey,
    ended ? "ignored_after_end" : event.login.outcome,
  );
}
db.prepare("DELETE FROM active_adapters WHERE pid=?").run(process.pid);
db.exec("COMMIT");
if (mode === "crash_after_apply") {
  db.prepare("UPDATE control SET mode='ok'").run();
  process.kill(process.ppid, "SIGKILL");
  process.exit(8);
}
db.close();
console.log(JSON.stringify({ acknowledged: event.idempotencyKey }));
