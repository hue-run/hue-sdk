/**
 * What this process holds on disk while it runs — a world case's files, a checkpoint lock, a
 * token-bearing MCP configuration — each with a synchronous removal. Normal paths remove them
 * themselves and unregister; a forced exit (a second Ctrl+C in `hue eval`) cannot wait for them,
 * so it runs whatever is still registered, newest first, before `process.exit`.
 */
const cleanups = new Set<() => void>();

/** Register a synchronous removal; the returned function unregisters it. */
export function onForcedExit(cleanup: () => void): () => void {
  cleanups.add(cleanup);
  return () => {
    cleanups.delete(cleanup);
  };
}

/** Run every registered removal, newest first: files before the lock that guards them. */
export function runForcedExitCleanups(): void {
  for (const cleanup of [...cleanups].reverse()) {
    try {
      cleanup();
    } catch {
      // Best effort on the way out; the rest still run.
    }
  }
  cleanups.clear();
}
