import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  getScenario,
  HueApiError,
  listScenarios,
  matchByName,
  parseScenarioSelector,
  resolveEvalSetPins,
  resolveScenarioPins,
  type CaseConversion,
  type Dataset,
  type DatasetVersion,
  type ScenarioClient,
} from "../src/evals.js";

/** In-memory Scenario registry mirroring the case-conversion and dataset routes. */
function registry(pageSize = 100) {
  const datasets = new Map<string, Dataset>();
  const versions = new Map<string, DatasetVersion>();
  const scenarios = new Map<string, CaseConversion>();
  const calls = { list: 0, get: 0, datasets: 0 };
  function addVersion(datasetId: string, frozen: boolean): DatasetVersion {
    const dataset = datasets.get(datasetId)!;
    const version: DatasetVersion = {
      id: randomUUID(),
      datasetId,
      version: dataset.versions.length + 1,
      revision: 3,
      frozenAt: frozen ? "2026-09-18T00:00:00.000Z" : null,
      contentDigest: frozen ? "c".repeat(64) : null,
    };
    versions.set(version.id, version);
    dataset.versions.push(version);
    return version;
  }
  function dataset(name: string, options: { frozen?: boolean; archived?: boolean } = {}) {
    const id = randomUUID();
    datasets.set(id, {
      id,
      name,
      slug: name.toLowerCase().replace(/\s+/g, "-"),
      archivedAt: options.archived ? "2026-09-18T00:00:00.000Z" : null,
      versions: [],
    });
    return { id, version: addVersion(id, options.frozen ?? true) };
  }
  function scenario(
    name: string,
    options: { published?: boolean; frozen?: boolean; listedScorers?: number | "empty" } = {},
  ) {
    const { id: datasetId, version } = dataset(name, { frozen: options.frozen ?? true });
    const id = randomUUID();
    const pins = {
      caseId: randomUUID(),
      datasetId,
      datasetVersionId: version.id,
      environmentId: randomUUID(),
      environmentVersionId: randomUUID(),
      scorerId: randomUUID(),
      scorerVersionId: randomUUID(),
    };
    // A publication that lists its pins names the outcome scorer first, then the others.
    const listed =
      options.listedScorers === undefined
        ? {}
        : options.listedScorers === "empty"
          ? { scorerVersionIds: [] as string[] }
          : {
              scorerVersionIds: [
                pins.scorerVersionId,
                ...Array.from({ length: options.listedScorers }, () => randomUUID()),
              ],
            };
    scenarios.set(id, {
      id,
      domain: "support",
      status: options.published === false ? "draft" : "published",
      revision: 1,
      createdAt: "2026-09-18T00:00:00.000Z",
      traceId: randomUUID(),
      publication: options.published === false ? null : { ...pins, ...listed },
    });
    return { id, ...pins, ...listed };
  }
  const page = <T extends { id: string }>(items: T[], after?: string) => {
    const start = after ? items.findIndex((item) => item.id === after) + 1 : 0;
    const slice = items.slice(start, start + pageSize);
    const last = slice.at(-1);
    return { items: slice, nextCursor: start + pageSize < items.length && last ? last.id : null };
  };
  const client: ScenarioClient = {
    listCaseConversions: async (options) => {
      calls.list++;
      // The list omits publication details, as the server does.
      const summaries = [...scenarios.values()].map(({ publication: _pins, ...summary }) => ({
        ...summary,
        domain: summary.domain!,
        revision: summary.revision!,
        createdAt: summary.createdAt!,
        traceId: summary.traceId!,
        extra: "ignored",
      }));
      return page(summaries, options?.after);
    },
    getCaseConversion: async (id) => {
      calls.get++;
      const found = scenarios.get(id);
      if (!found) throw new HueApiError(404);
      return { ...found, unexpected: true } as CaseConversion;
    },
    getDataset: async (id) => {
      calls.datasets++;
      const found = datasets.get(id);
      if (!found) throw new HueApiError(404);
      return structuredClone(found);
    },
    getDatasetVersion: async (id) => {
      const found = versions.get(id);
      if (!found) throw new HueApiError(404);
      return structuredClone(found);
    },
    listDatasets: async (options) => {
      const summaries = [...datasets.values()].map(
        ({ versions: _versions, ...summary }) => summary,
      );
      return page(summaries, options?.after);
    },
  };
  return { client, calls, dataset, scenario, addVersion };
}

describe("scenario selectors", () => {
  test("interprets IDs, Hue URLs and names", () => {
    const id = randomUUID();
    expect(parseScenarioSelector(id.toUpperCase())).toEqual({ kind: "id", id });
    expect(
      parseScenarioSelector(`https://app.hue.run/projects/p/scenarios/${id}?tab=checks#top`),
    ).toEqual({ kind: "id", id });
    expect(parseScenarioSelector(" Refund flow ")).toEqual({ kind: "name", name: "Refund flow" });
    expect(parseScenarioSelector(`https://app.hue.run/experiments/${id}`, ["experiments"])).toEqual(
      { kind: "id", id },
    );
    expect(() => parseScenarioSelector(`https://app.hue.run/experiments/${id}`)).toThrow(
      "/scenarios/<id>",
    );
    expect(() => parseScenarioSelector("   ")).toThrow("selector is required");
  });

  test("prefers exact names, then unique prefixes, then substrings", () => {
    const candidates = [{ name: "Refund flow" }, { name: "Refund flow v2" }, { name: "Billing" }];
    expect(matchByName(candidates, "refund FLOW")).toEqual({
      matches: [{ name: "Refund flow" }],
      exact: true,
    });
    expect(matchByName(candidates, "refund").matches).toHaveLength(2);
    expect(matchByName(candidates, "ill")).toEqual({
      matches: [{ name: "Billing" }],
      exact: false,
    });
    expect(matchByName(candidates, "nothing").matches).toEqual([]);
  });
});

describe("resolveScenarioPins", () => {
  test("resolves a published Scenario by ID and by URL with query parameters", async () => {
    const fixture = registry();
    const published = fixture.scenario("Refund flow");
    const expected = {
      scenarioId: published.id,
      name: "Refund flow",
      datasetId: published.datasetId,
      datasetVersionId: published.datasetVersionId,
      scorerVersionIds: [published.scorerVersionId],
      environmentVersionId: published.environmentVersionId,
      saved: true,
      revision: 3,
    };
    expect(await resolveScenarioPins(fixture.client, published.id)).toEqual(expected);
    expect(
      await resolveScenarioPins(
        fixture.client,
        `https://app.hue.run/projects/demo/scenarios/${published.id}?from=list&tab=checks`,
      ),
    ).toEqual(expected);
    expect(fixture.calls.list).toBe(0);
  });

  test("resolves a published Scenario by the ID or case page URL of the case it published", async () => {
    const fixture = registry();
    fixture.scenario("Billing dispute");
    const published = fixture.scenario("Refund flow");
    const pins = await resolveScenarioPins(fixture.client, published.id);
    expect(fixture.calls.list).toBe(0);
    // Hue shows the published eval set case's own ID, not the Scenario's, on the case page.
    expect(await resolveScenarioPins(fixture.client, published.caseId.toUpperCase())).toEqual(pins);
    expect(
      await resolveScenarioPins(
        fixture.client,
        `https://app.hue.run/evals/${published.datasetId}/cases/${published.caseId}`,
      ),
    ).toEqual(pins);
    expect(
      await resolveScenarioPins(
        fixture.client,
        `https://app.hue.run/case-conversions/${published.id}`,
      ),
    ).toEqual(pins);
    // A draft's case is not published, so its ID resolves nothing.
    const draft = fixture.scenario("Draft only", { published: false });
    await expect(resolveScenarioPins(fixture.client, draft.caseId)).rejects.toBeInstanceOf(
      HueApiError,
    );
  });

  test("finds a published case past the name search's bound and past a vanished Scenario", async () => {
    const fixture = registry();
    const gone = fixture.scenario("Removed after listing");
    for (let index = 0; index < 200; index++) fixture.scenario(`Filler ${index}`);
    const last = fixture.scenario("Refund flow");
    // A Scenario listed but no longer readable is skipped rather than failing the lookup.
    const client: ScenarioClient = {
      ...fixture.client,
      getCaseConversion: async (id) => {
        if (id === gone.id) throw new HueApiError(404);
        return fixture.client.getCaseConversion(id);
      },
    };
    expect((await resolveScenarioPins(client, last.caseId)).scenarioId).toBe(last.id);
    expect((await resolveScenarioPins(client, "Filler 7")).name).toBe("Filler 7");
    // Another failure still surfaces.
    const failing: ScenarioClient = {
      ...client,
      getCaseConversion: async (id) => {
        if (id !== last.id) throw new HueApiError(503);
        return fixture.client.getCaseConversion(id);
      },
    };
    await expect(resolveScenarioPins(failing, last.caseId)).rejects.toMatchObject({ status: 503 });
  });

  test("pins every scorer version a publication lists, the outcome scorer first", async () => {
    const fixture = registry();
    const published = fixture.scenario("Refund flow with judges", { listedScorers: 2 });
    const pins = await resolveScenarioPins(fixture.client, published.id);
    expect(pins.scorerVersionIds).toEqual(published.scorerVersionIds!);
    expect(pins.scorerVersionIds).toHaveLength(3);
    expect(pins.scorerVersionIds[0]).toBe(published.scorerVersionId);
    // An empty list reads as an older publication: the single pin stands.
    const empty = fixture.scenario("Refund flow, empty list", { listedScorers: "empty" });
    const single = await resolveScenarioPins(fixture.client, empty.id);
    expect(single.scorerVersionIds).toEqual([empty.scorerVersionId]);
  });

  test("resolves by exact and case-insensitive name across published Scenarios only", async () => {
    const fixture = registry(2);
    const refund = fixture.scenario("Refund flow");
    fixture.scenario("Refund flow v2");
    fixture.scenario("Refund flow", { published: false });
    fixture.scenario("Billing dispute");
    expect((await resolveScenarioPins(fixture.client, "Refund flow")).scenarioId).toBe(refund.id);
    expect((await resolveScenarioPins(fixture.client, "refund FLOW")).scenarioId).toBe(refund.id);
    expect((await resolveScenarioPins(fixture.client, "billing")).name).toBe("Billing dispute");
    expect((await resolveScenarioPins(fixture.client, "dispute")).name).toBe("Billing dispute");
    // Three published Scenarios over two-item pages need two list reads per resolution.
    expect(fixture.calls.list).toBe(8);
  });

  test("reports ambiguous, unknown and draft selections", async () => {
    const fixture = registry();
    const first = fixture.scenario("Refund flow");
    const second = fixture.scenario("Refund flow v2");
    const draft = fixture.scenario("Draft only", { published: false });
    await expect(resolveScenarioPins(fixture.client, "Refund")).rejects.toThrow(
      `Several published Scenarios match "Refund"; pass an ID or URL instead: Refund flow (${first.id}), Refund flow v2 (${second.id})`,
    );
    await expect(resolveScenarioPins(fixture.client, "Missing")).rejects.toThrow(
      'No published Scenario matches "Missing". Published Scenarios: Refund flow',
    );
    await expect(resolveScenarioPins(fixture.client, "Draft only")).rejects.toThrow(
      'No published Scenario matches "Draft only"',
    );
    await expect(resolveScenarioPins(fixture.client, draft.id)).rejects.toThrow(
      `Scenario ${draft.id} is a draft without published pins`,
    );
    await expect(resolveScenarioPins(fixture.client, randomUUID())).rejects.toBeInstanceOf(
      HueApiError,
    );
  });

  test("detects an unsaved dataset version behind a Scenario", async () => {
    const fixture = registry();
    const unsaved = fixture.scenario("Unsaved", { frozen: false });
    const pins = await resolveScenarioPins(fixture.client, unsaved.id);
    expect(pins.saved).toBe(false);
    expect(pins.revision).toBe(3);
    expect(pins.datasetVersionId).toBe(unsaved.datasetVersionId);
  });

  test("list and read helpers pass through the client", async () => {
    const fixture = registry();
    const published = fixture.scenario("Refund flow");
    expect((await listScenarios(fixture.client)).items.map((item) => item.id)).toEqual([
      published.id,
    ]);
    expect((await getScenario(fixture.client, published.id)).publication?.datasetId).toBe(
      published.datasetId,
    );
  });
});

describe("resolveEvalSetPins", () => {
  test("uses the latest saved version even when a newer draft exists", async () => {
    const fixture = registry();
    const set = fixture.dataset("Greetings");
    fixture.addVersion(set.id, true);
    const latestFrozen = fixture.addVersion(set.id, true);
    fixture.addVersion(set.id, false);
    const scorer = randomUUID();
    const pins = await resolveEvalSetPins(fixture.client, "greetings", {
      scorerVersionIds: [scorer],
    });
    expect(pins).toEqual({
      scenarioId: null,
      name: "Greetings",
      datasetId: set.id,
      datasetVersionId: latestFrozen.id,
      scorerVersionIds: [scorer],
      environmentVersionId: null,
      saved: true,
      revision: 3,
    });
    expect((await resolveEvalSetPins(fixture.client, set.id)).datasetVersionId).toBe(
      latestFrozen.id,
    );
    expect(
      (await resolveEvalSetPins(fixture.client, `https://app.hue.run/datasets/${set.id}?x=1`))
        .datasetVersionId,
    ).toBe(latestFrozen.id);
  });

  test("returns the draft as unsaved when nothing was saved and rejects ambiguity", async () => {
    const fixture = registry();
    const draftOnly = fixture.dataset("Drafts", { frozen: false });
    fixture.dataset("Drafts archived", { archived: true });
    const pins = await resolveEvalSetPins(fixture.client, "Drafts");
    expect(pins.saved).toBe(false);
    expect(pins.datasetVersionId).toBe(draftOnly.version.id);
    fixture.dataset("Drafts second");
    await expect(resolveEvalSetPins(fixture.client, "Drafts s")).resolves.toMatchObject({
      name: "Drafts second",
    });
    await expect(resolveEvalSetPins(fixture.client, "Dra")).rejects.toThrow("Several eval sets");
    await expect(resolveEvalSetPins(fixture.client, "Nothing")).rejects.toThrow(
      'No eval set matches "Nothing"',
    );
  });
});
