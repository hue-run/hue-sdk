import { spawn } from "node:child_process";
import { z } from "zod";
import type { HookConfig, HookEvent } from "./contracts.ts";

export async function runAdapter(
  config: HookConfig,
  event: HookEvent,
  environment: NodeJS.ProcessEnv,
): Promise<boolean> {
  const executable = config.command[0];
  if (!executable) throw new Error("adapter_missing");
  const env: NodeJS.ProcessEnv = { PATH: environment.PATH, LANG: "C.UTF-8" };
  for (const name of config.envNames) {
    const value = environment[name];
    if (value === undefined) throw new Error("adapter_environment_missing");
    env[name] = value;
  }
  return new Promise((resolve) => {
    const child = spawn(executable, config.command.slice(1), {
      env,
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let outputBytes = 0;
    let settled = false;
    const finish = (success: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A detached descendant can retain these pipes after the adapter exits.
      // Release our handles and settle without waiting for its close event.
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      resolve(success);
    };
    const kill = () => {
      if (settled) return;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already exited */
        }
      }
      finish(false);
    };
    const timer = setTimeout(kill, 10_000);
    child.stdout.on("data", (bytes: Buffer) => {
      outputBytes += bytes.length;
      if (outputBytes > 4096) kill();
      else output += bytes.toString("utf8");
    });
    // Adapter output may contain customer secrets. Only its fixed acknowledgement is consumed.
    child.stderr.resume();
    child.stdin.on("error", kill);
    child.on("error", kill);
    child.on("close", (code) => {
      if (settled) return;
      try {
        const ack = z
          .strictObject({ acknowledged: z.literal(event.idempotencyKey) })
          .parse(JSON.parse(output));
        finish(code === 0 && ack.acknowledged === event.idempotencyKey);
      } catch {
        finish(false);
      }
    });
    child.stdin.end(JSON.stringify(event));
  });
}
