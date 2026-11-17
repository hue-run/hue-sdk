import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

/** The key file `hue login` writes; `hue eval` loads it when no env file is named and the shell has no HUE_API_KEY. */
export const DEFAULT_ENV_FILE = ".env.hue";

/** The only variables taken from `./.env.hue` or an eval env file: any other name, such as
 * LD_PRELOAD or NODE_OPTIONS, would reach the processes the CLI starts. */
const HUE_SETTINGS = ["HUE_API_KEY", "HUE_BASE_URL"] as const;

/** The Hue settings in env-file text, without any other variable it assigns. */
export function hueSettings(text: string): Record<string, string> {
  const parsed = parseEnv(text);
  const settings: Record<string, string> = {};
  for (const name of HUE_SETTINGS) {
    const value = parsed[name];
    if (value !== undefined) settings[name] = value;
  }
  return settings;
}

/** Sets the file's Hue settings that `process.env` does not have yet; throws when it is unreadable. */
export function loadHueSettings(path: string): void {
  for (const [name, value] of Object.entries(hueSettings(readFileSync(path, "utf8"))))
    process.env[name] ??= value;
}

/**
 * Node 22 and 24 scan the whole command line for `--env-file`, including arguments meant for the
 * script, and exit with "node: <path>: not found" before the CLI runs when that file does not
 * exist. `--env-path` is the same option under a name Node ignores, so a command such as
 * `hue login` can name a file it is about to create.
 */
export const envFileOptions = {
  "env-file": { type: "string" },
  "env-path": { type: "string" },
} as const;

/**
 * The env file named by `--env-path` or `--env-file`; throws when both name different files,
 * comparing them as resolved from `cwd`.
 */
export function envFileArgument(
  values: { "env-file"?: string | undefined; "env-path"?: string | undefined },
  cwd: string,
): string | undefined {
  const { "env-file": file, "env-path": path } = values;
  if (file !== undefined && path !== undefined && resolve(cwd, file) !== resolve(cwd, path))
    throw new Error("Pass one of --env-file and --env-path, not both.");
  return path ?? file;
}
