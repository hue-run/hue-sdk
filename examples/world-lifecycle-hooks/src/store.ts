import { DatabaseSync } from "node:sqlite";
import { chmodSync, lstatSync, mkdirSync, openSync, closeSync, constants } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { digest, eventSchema, type HookConfig, type HookEvent } from "./contracts.ts";

const rowSchema = z.object({ event_key: z.string(), payload: z.string() });
export class Store {
  readonly db: DatabaseSync;
  constructor(directory: string, config: HookConfig) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directoryStat = lstatSync(directory);
    if (
      !directoryStat.isDirectory() ||
      (directoryStat.mode & 0o077) !== 0 ||
      directoryStat.uid !== process.getuid?.()
    )
      throw new Error("state_directory_not_private");
    const file = join(directory, "hooks.sqlite");
    closeSync(openSync(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600));
    if (!lstatSync(file).isFile()) throw new Error("state_file_not_regular");
    chmodSync(file, 0o600);
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS binding (id INTEGER PRIMARY KEY CHECK(id=1), digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS event (event_key TEXT PRIMARY KEY, payload TEXT NOT NULL, kind TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL DEFAULT 0, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0, error TEXT);`);
    // Bind the adapter too: a restarted helper must not silently deliver old work to another command.
    const binding = digest({
      origin: new URL(config.origin).origin,
      projectId: config.projectId,
      worldId: config.worldId,
      connectionId: config.connectionId,
      command: config.command,
      envNames: config.envNames,
    });
    this.db.prepare("INSERT OR IGNORE INTO binding VALUES (1, ?)").run(binding);
    const saved = z
      .object({ digest: z.string() })
      .parse(this.db.prepare("SELECT digest FROM binding WHERE id=1").get());
    if (saved.digest !== binding) {
      this.db.close();
      throw new Error("state_binding_mismatch");
    }
  }
  enqueue(event: HookEvent) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.insert(event);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private insert(event: HookEvent) {
    const payload = JSON.stringify(event);
    if (event.type === "auth.outcome" && !this.existing(event)) {
      if (this.terminal()) throw new Error("world_not_live");
      if (Number(this.db.prepare("SELECT count(*) AS count FROM event").get()?.count) >= 999)
        throw new Error("queue_full");
    }
    this.db
      .prepare("INSERT OR IGNORE INTO event(event_key,payload,kind) VALUES(?,?,?)")
      .run(event.idempotencyKey, payload, event.type);
    const saved = rowSchema.parse(
      this.db
        .prepare("SELECT event_key,payload FROM event WHERE event_key=?")
        .get(event.idempotencyKey),
    );
    if (saved.payload !== payload) throw new Error("idempotency_conflict");
  }
  existing(event: HookEvent): boolean {
    const row = this.db
      .prepare("SELECT event_key,payload FROM event WHERE event_key=?")
      .get(event.idempotencyKey);
    if (!row) return false;
    if (rowSchema.parse(row).payload !== JSON.stringify(event))
      throw new Error("idempotency_conflict");
    return true;
  }
  terminal() {
    const row = this.db
      .prepare("SELECT event_key,payload FROM event WHERE kind='world.ended'")
      .get();
    if (!row) return null;
    const event = eventSchema.parse(JSON.parse(rowSchema.parse(row).payload));
    if (event.type !== "world.ended") throw new Error("terminal_receipt_invalid");
    return event;
  }
  cancelLogins() {
    this.db
      .prepare(
        "UPDATE event SET state='cancelled' WHERE kind='auth.outcome' AND state='pending' AND lease_until<=?",
      )
      .run(Date.now());
  }
  claim(kind: HookEvent["type"]) {
    const now = Date.now();
    const lease = randomUUID();
    const row = this.db
      .prepare(
        `UPDATE event SET lease=?, lease_until=?, attempts=attempts+1
      WHERE event_key=(SELECT event_key FROM event WHERE state='pending' AND kind=? AND next_at<=? AND lease_until<=?
        AND NOT EXISTS(SELECT 1 FROM event WHERE state='pending' AND lease_until>?)
        AND (kind='world.ended' OR NOT EXISTS(SELECT 1 FROM event WHERE kind='world.ended'))
        ORDER BY rowid LIMIT 1) RETURNING event_key,payload`,
      )
      .get(lease, now + 30_000, kind, now, now, now);
    return row
      ? { event: eventSchema.parse(JSON.parse(rowSchema.parse(row).payload)), lease }
      : null;
  }
  settle(key: string, lease: string, success: boolean) {
    this.db
      .prepare(
        `UPDATE event SET state=?, lease=NULL, lease_until=0, next_at=?, error=?
      WHERE event_key=? AND lease=? AND state='pending'`,
      )
      .run(
        success ? "done" : "pending",
        Date.now() + 5_000,
        success ? null : "adapter_failed",
        key,
        lease,
      );
  }
  status() {
    return this.db
      .prepare(
        "SELECT event_key AS idempotencyKey,kind,state,attempts,error FROM event ORDER BY rowid LIMIT 1000",
      )
      .all();
  }
  close() {
    this.db.close();
  }
}
