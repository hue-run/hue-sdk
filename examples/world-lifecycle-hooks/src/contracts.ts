import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/);
export const configSchema = z.strictObject({
  origin: z.url().refine((value) => {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/" &&
      ((url.protocol === "https:" && ["app.hue.run", "staging.hue.run"].includes(url.hostname)) ||
        (url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  }, "Use a Hue origin or an explicit loopback HTTP origin"),
  projectId: z.uuid(),
  worldId: z.uuid(),
  connectionId: identifier,
  command: z
    .array(z.string().min(1))
    .min(1)
    .max(32)
    .refine((parts) => isAbsolute(parts[0] ?? ""), "Use an absolute executable path"),
  envNames: z
    .array(
      z
        .string()
        .regex(/^[A-Z][A-Z0-9_]*$/)
        .refine(
          (name) =>
            !name.startsWith("HUE_") &&
            !["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH"].includes(name),
        ),
    )
    .max(16)
    .default([]),
  port: z.number().int().min(0).max(65535).default(8788),
});
export type HookConfig = z.infer<typeof configSchema>;
export const loginSchema = z.strictObject({
  requestId: identifier,
  subjectId: identifier,
  stage: z.enum(["oauth", "sso", "mfa"]),
  outcome: z.enum(["succeeded", "rejected", "timed_out", "failed"]),
});
export type LoginOutcome = z.infer<typeof loginSchema>;
const terminal = z.enum(["completed", "abandoned", "expired"]);
export const worldSchema = z
  .object({
    worldId: z.uuid(),
    projectId: z.uuid(),
    lifecycle: z.enum(["pending", "live", "completing", "sealed"]),
    activity: z.enum(["active", "building", "inactive"]),
    status: z.union([z.literal("open"), terminal]),
    sealedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .refine(
    (value) =>
      value.lifecycle === "sealed"
        ? value.status !== "open" && value.sealedAt !== null
        : value.status === "open" && value.sealedAt === null,
    "Inconsistent World lifecycle",
  );
export type WorldStatus = z.infer<typeof worldSchema>;
const scopeSchema = z.strictObject({
  projectId: z.uuid(),
  worldId: z.uuid(),
  connectionId: identifier,
});
export const eventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    version: z.literal(1),
    type: z.literal("auth.outcome"),
    idempotencyKey: z.string(),
    scope: scopeSchema,
    login: loginSchema,
  }),
  z.strictObject({
    version: z.literal(1),
    type: z.literal("world.ended"),
    idempotencyKey: z.string(),
    scope: scopeSchema,
    status: terminal,
    sealedAt: z.iso.datetime({ offset: true }),
  }),
]);
export type HookEvent = z.infer<typeof eventSchema>;
export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function scope(config: HookConfig) {
  return {
    projectId: config.projectId,
    worldId: config.worldId,
    connectionId: config.connectionId,
  };
}
export function loginEvent(config: HookConfig, login: LoginOutcome): HookEvent {
  return {
    version: 1,
    type: "auth.outcome",
    idempotencyKey: digest([scope(config), "auth.outcome", login.requestId, login.stage]),
    scope: scope(config),
    login,
  };
}
export function endedEvent(config: HookConfig, world: WorldStatus): HookEvent {
  if (world.lifecycle !== "sealed" || world.status === "open" || !world.sealedAt)
    throw new Error("world_not_sealed");
  return {
    version: 1,
    type: "world.ended",
    idempotencyKey: digest([scope(config), "world.ended"]),
    scope: scope(config),
    status: world.status,
    sealedAt: world.sealedAt,
  };
}
