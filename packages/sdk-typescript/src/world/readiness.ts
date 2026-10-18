/** Progress of one requested starting World. */
export interface WorldPreparationProgress {
  /** Whether the request is preparing, usable, or waiting for changed evidence or dependencies. */
  state:
    | "preparing"
    | "insufficient_evidence"
    | "processing_limit"
    | "dependency_unavailable"
    | "ready";
  /** Evidence cutoff selected for this request. */
  selectedEvidenceCutoff: number;
  /** Latest retained evidence cutoff. */
  retainedEvidenceCutoff: number;
  /** Latest indexed evidence cutoff for the current interpretation. */
  readyEvidenceCutoff: number;
  /** Whether retained evidence is still waiting for indexing. */
  pendingEvidence: boolean;
}

/** Retained and indexed progress of an entity history. */
export interface WorldModelProcessing
  extends Omit<WorldPreparationProgress, "state" | "selectedEvidenceCutoff"> {
  /** Indexing progress; a requested represented time may still lack required evidence. */
  state:
    | "indexed"
    | "preparing"
    | "insufficient_evidence"
    | "processing_limit"
    | "dependency_unavailable";
}

const diagnosticStates: Readonly<Record<string, WorldPreparationProgress["state"]>> = {
  world_preparing: "preparing",
  world_insufficient_evidence: "insufficient_evidence",
  world_processing_limit: "processing_limit",
  world_dependency_unavailable: "dependency_unavailable",
};

/** @internal Only numeric progress and an allowlisted state cross the error boundary. */
export async function readWorldPreparation(
  response: Response,
  diagnostic?: string,
): Promise<WorldPreparationProgress | undefined> {
  if (response.status !== 503 || diagnostic === undefined || !(diagnostic in diagnosticStates)) {
    await response.body?.cancel().catch(() => {});
    return undefined;
  }
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16 * 1024) return undefined;
      chunks.push(value);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || !("preparation" in body)) return undefined;
    const value = body.preparation;
    if (!value || typeof value !== "object") return undefined;
    const {
      state,
      selectedEvidenceCutoff: selected,
      retainedEvidenceCutoff: retained,
      readyEvidenceCutoff: ready,
      pendingEvidence,
    } = value as Record<string, unknown>;
    const expectedState = diagnosticStates[diagnostic];
    if (
      expectedState === undefined ||
      state !== expectedState ||
      !Number.isSafeInteger(selected) ||
      !Number.isSafeInteger(retained) ||
      !Number.isSafeInteger(ready) ||
      typeof selected !== "number" ||
      typeof retained !== "number" ||
      typeof ready !== "number" ||
      selected < 0 ||
      ready < 0 ||
      selected > retained ||
      ready > retained ||
      pendingEvidence !== retained > ready
    )
      return undefined;
    return {
      state: expectedState,
      selectedEvidenceCutoff: selected,
      retainedEvidenceCutoff: retained,
      readyEvidenceCutoff: ready,
      pendingEvidence,
    };
  } catch {
    return undefined;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** @internal These failures require changed evidence or processing, not another identical call. */
export const TERMINAL_WORLD_DIAGNOSTICS: ReadonlySet<string> = new Set([
  "world_insufficient_evidence",
  "world_processing_limit",
]);
