import { readFileSync } from "node:fs";

/** A peer dependency of `@hue-run/sdk` that a command needs and the project has not installed. */
export class MissingPeerError extends Error {
  constructor(
    readonly command: string,
    readonly peer: string,
    readonly range: string,
  ) {
    super(
      `hue ${command} needs ${peer}, a peer dependency of @hue-run/sdk that this project has not installed. Install it with: npm install "${peer}@${range}" (or bun add, pnpm add or yarn add with the same argument)`,
    );
    this.name = "MissingPeerError";
  }
}

/** The range `@hue-run/sdk` declares for a peer, or undefined when `name` is not one of its peers. */
function peerRange(name: string): string | undefined {
  try {
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { peerDependencies?: Record<string, unknown> };
    const range = manifest.peerDependencies?.[name];
    return typeof range === "string" ? range : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Loads a command module. When the import fails because one of the SDK's peers, such as `zod` or
 * `@opentelemetry/api`, is not installed, the failure names that peer and how to add it instead
 * of the runtime's resolution error; any other failure is rethrown unchanged.
 */
export async function loadCommand<T>(command: string, load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error) {
    const missing = /Cannot find (?:package|module) ['"]((?:@[^/'"]+\/)?[^/'"]+)/.exec(
      error instanceof Error ? error.message : "",
    )?.[1];
    const range = missing === undefined ? undefined : peerRange(missing);
    if (missing === undefined || range === undefined) throw error;
    throw new MissingPeerError(command, missing, range);
  }
}
