import { resolve } from "node:path";

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
