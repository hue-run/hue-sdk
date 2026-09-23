import type { EvaluationClient } from "./client.js";
import type { CaseConversion, CaseConversionSummary, Dataset, Page, PageOptions } from "./types.js";

/** Immutable pins resolved from a published Scenario or a saved eval set. */
export interface ScenarioPins {
  /** Scenario ID, or `null` when the pins came from an eval set. */
  scenarioId: string | null;
  /** Display name of the dataset behind the pins. */
  name: string;
  /** Dataset holding the pinned version. */
  datasetId: string;
  /** Pinned dataset version; frozen only when `saved` is true. */
  datasetVersionId: string;
  /** Pinned scorer versions; a Scenario pins exactly one. */
  scorerVersionIds: string[];
  /** Pinned simulated-world version, or `null` when the selection does not pin one. */
  environmentVersionId: string | null;
  /** Whether the dataset version is frozen (`frozenAt` is set); experiments require a saved version. */
  saved: boolean;
  /** Current optimistic revision of the dataset version, needed to freeze an unsaved draft. */
  revision: number;
}

/** Subset of {@link EvaluationClient} used to resolve Scenario pins. */
export type ScenarioClient = Pick<
  EvaluationClient,
  "listCaseConversions" | "getCaseConversion" | "getDataset" | "getDatasetVersion" | "listDatasets"
>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Scenarios listed while resolving a name; bounds the registry reads of one selection. */
const MAX_LISTED = 200;

/** Lists Scenarios of the project; requires a Read and write key. */
export function listScenarios(
  client: Pick<EvaluationClient, "listCaseConversions">,
  page?: PageOptions,
): Promise<Page<CaseConversionSummary>> {
  return client.listCaseConversions(page);
}

/** Reads one Scenario with its publication pins; requires a Read and write key. */
export function getScenario(
  client: Pick<EvaluationClient, "getCaseConversion">,
  id: string,
): Promise<CaseConversion> {
  return client.getCaseConversion(id);
}

/** How a selector was interpreted: a UUID, a Hue URL or a display name. */
export type ScenarioSelector =
  | {
      /** The selector is an ID or a URL naming one. */
      kind: "id";
      /** Lowercase UUID. */
      id: string;
    }
  | {
      /** The selector is a display name to match. */
      kind: "name";
      /** Trimmed name. */
      name: string;
    };

/**
 * Interprets a selector as a UUID, a Hue URL containing `/<segment>/<uuid>` (for example
 * `/scenarios/<uuid>`, query parameters ignored) or a display name.
 *
 * @throws TypeError for an empty selector or a URL without the expected segment.
 */
export function parseScenarioSelector(
  selector: string,
  segments: string[] = ["scenarios"],
): ScenarioSelector {
  const value = selector.trim();
  if (!value) throw new TypeError("A Scenario selector is required");
  if (UUID.test(value)) return { kind: "id", id: value.toLowerCase() };
  if (/^https?:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new TypeError("The selector is not a valid URL");
    }
    const parts = url.pathname.split("/");
    for (let index = 0; index < parts.length - 1; index++) {
      const next = parts[index + 1]!;
      if (segments.includes(parts[index]!) && UUID.test(next))
        return { kind: "id", id: next.toLowerCase() };
    }
    throw new TypeError(
      `The URL does not contain /${segments.join("|")}/<id>; paste the page URL or the ID`,
    );
  }
  return { kind: "name", name: value };
}

/** A candidate with a display name, such as a dataset or Scenario. */
export interface NamedCandidate {
  /** Display name compared case-insensitively. */
  name: string;
}
/** Outcome of {@link matchByName}. */
export interface NameMatch<T extends NamedCandidate> {
  /** Candidates that matched; one means an unambiguous selection. */
  matches: T[];
  /** Whether the matches are exact (case-insensitive) rather than prefix or substring matches. */
  exact: boolean;
}
/** Case-insensitive exact matches first, then unique prefix/substring matches. */
export function matchByName<T extends NamedCandidate>(candidates: T[], name: string): NameMatch<T> {
  const wanted = name.trim().toLowerCase();
  const exact = candidates.filter((candidate) => candidate.name.trim().toLowerCase() === wanted);
  if (exact.length) return { matches: exact, exact: true };
  const prefix = candidates.filter((candidate) =>
    candidate.name.trim().toLowerCase().startsWith(wanted),
  );
  if (prefix.length) return { matches: prefix, exact: false };
  return {
    matches: candidates.filter((candidate) => candidate.name.toLowerCase().includes(wanted)),
    exact: false,
  };
}

async function listPublishedScenarios(client: ScenarioClient): Promise<CaseConversionSummary[]> {
  const items: CaseConversionSummary[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await client.listCaseConversions({ after, limit: 100 });
    items.push(...page.items.filter((item) => item.status === "published"));
    if (!page.nextCursor || items.length >= MAX_LISTED) return items.slice(0, MAX_LISTED);
    after = page.nextCursor;
  }
}

const describe = (candidates: { name: string; id: string }[]) =>
  candidates.map((candidate) => `${candidate.name} (${candidate.id})`).join(", ");

async function pinsFromScenario(
  client: ScenarioClient,
  scenario: CaseConversion,
  dataset: Dataset,
) {
  if (!scenario.publication)
    throw new Error(
      `Scenario ${scenario.id} is a draft without published pins; publish it in Hue first`,
    );
  const version = await client.getDatasetVersion(scenario.publication.datasetVersionId);
  return {
    scenarioId: scenario.id,
    name: dataset.name,
    datasetId: scenario.publication.datasetId,
    datasetVersionId: version.id,
    scorerVersionIds: [scenario.publication.scorerVersionId],
    environmentVersionId: scenario.publication.environmentVersionId,
    saved: version.frozenAt !== null,
    revision: version.revision,
  } satisfies ScenarioPins;
}

/**
 * Resolves a published Scenario's immutable pins from its ID, its Hue URL or its name. A name
 * matches the dataset name of published Scenarios case-insensitively: exact matches first, then
 * a unique prefix or substring.
 *
 * @throws Error when no Scenario matches, several match, or the Scenario is an unpublished draft.
 */
export async function resolveScenarioPins(
  client: ScenarioClient,
  selector: string,
): Promise<ScenarioPins> {
  const parsed = parseScenarioSelector(selector);
  if (parsed.kind === "id") {
    const scenario = await client.getCaseConversion(parsed.id);
    if (!scenario.publication)
      throw new Error(
        `Scenario ${scenario.id} is a draft without published pins; publish it in Hue first`,
      );
    return pinsFromScenario(
      client,
      scenario,
      await client.getDataset(scenario.publication.datasetId),
    );
  }
  const published = await listPublishedScenarios(client);
  const datasets = new Map<string, Dataset>();
  const candidates: { name: string; id: string; scenario: CaseConversion; dataset: Dataset }[] = [];
  for (const summary of published) {
    const scenario = await client.getCaseConversion(summary.id);
    if (!scenario.publication) continue;
    let dataset = datasets.get(scenario.publication.datasetId);
    if (!dataset) {
      dataset = await client.getDataset(scenario.publication.datasetId);
      datasets.set(dataset.id, dataset);
    }
    candidates.push({ name: dataset.name, id: scenario.id, scenario, dataset });
  }
  const { matches } = matchByName(candidates, parsed.name);
  if (matches.length === 1)
    return pinsFromScenario(client, matches[0]!.scenario, matches[0]!.dataset);
  if (matches.length > 1)
    throw new Error(
      `Several published Scenarios match "${parsed.name}"; pass an ID or URL instead: ${describe(matches)}`,
    );
  throw new Error(
    candidates.length
      ? `No published Scenario matches "${parsed.name}". Published Scenarios: ${describe(candidates)}`
      : `No published Scenario matches "${parsed.name}"; publish one in Hue first`,
  );
}

/**
 * Resolves an eval set (dataset) by ID, Hue URL or name to its latest saved version. When the
 * set has no saved version, the latest draft is returned with `saved: false` so a caller can
 * freeze it explicitly. Scorer versions are not pinned by a set; supply them separately.
 *
 * @throws Error when no set matches, several match, or the set has no versions.
 */
export async function resolveEvalSetPins(
  client: ScenarioClient,
  selector: string,
  options: {
    /** Scorer versions to pin alongside the dataset version. */
    scorerVersionIds?: string[];
  } = {},
): Promise<ScenarioPins> {
  const parsed = parseScenarioSelector(selector, ["datasets", "eval-sets", "evalsets", "sets"]);
  let dataset: Dataset;
  if (parsed.kind === "id") dataset = await client.getDataset(parsed.id);
  else {
    const candidates: { id: string; name: string; slug?: string }[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await client.listDatasets({ after, limit: 100 });
      candidates.push(...page.items.filter((item) => !item.archivedAt));
      if (!page.nextCursor || candidates.length >= MAX_LISTED) break;
      after = page.nextCursor;
    }
    // An exact slug is the stable handle scripts and agents pass; names are matched after it.
    const wanted = parsed.name.trim().toLowerCase();
    const bySlug = candidates.filter((item) => item.slug?.toLowerCase() === wanted);
    const { matches } = bySlug.length ? { matches: bySlug } : matchByName(candidates, parsed.name);
    if (matches.length > 1)
      throw new Error(
        `Several eval sets match "${parsed.name}"; pass an ID or URL instead: ${describe(matches)}`,
      );
    if (!matches.length)
      throw new Error(
        candidates.length
          ? `No eval set matches "${parsed.name}". Eval sets: ${describe(candidates)}`
          : `No eval set matches "${parsed.name}"`,
      );
    dataset = await client.getDataset(matches[0]!.id);
  }
  const latest = (versions: Dataset["versions"]) =>
    versions.reduce<Dataset["versions"][number] | undefined>(
      (best, version) => (best === undefined || version.version > best.version ? version : best),
      undefined,
    );
  const version =
    latest(dataset.versions.filter((item) => item.frozenAt !== null)) ?? latest(dataset.versions);
  if (!version) throw new Error(`Eval set "${dataset.name}" has no versions`);
  return {
    scenarioId: null,
    name: dataset.name,
    datasetId: dataset.id,
    datasetVersionId: version.id,
    scorerVersionIds: [...(options.scorerVersionIds ?? [])],
    environmentVersionId: null,
    saved: version.frozenAt !== null,
    revision: version.revision,
  };
}
