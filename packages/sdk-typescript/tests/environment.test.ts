import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  createEnvironmentClient,
  HueEnvironmentError,
  type EnvironmentDefinition,
} from "../src/environment.js";

const key = "synthetic-environment-key";
const definition: EnvironmentDefinition = {
  schemaVersion: 1,
  state: { collections: { records: {} } },
  actions: [
    {
      name: "list_records",
      semantics: { entry: "hue.collection.list@1", config: { collection: "records" } },
    },
  ],
};

describe("environment HTTP client", () => {
  test("authors an immutable environment version", async () => {
    const environmentId = randomUUID();
    const versionId = randomUUID();
    const requests: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        expect(request.headers.get("authorization")).toBe(`Bearer ${key}`);
        const path = new URL(request.url).pathname.replace("/api/v1", "");
        requests.push(`${request.method} ${path}`);
        if (path === "/environments" && request.method === "POST")
          return Response.json({
            id: environmentId,
            ...((await request.json()) as Record<string, unknown>),
            description: "",
            archivedAt: null,
          });
        if (path === `/environments/${environmentId}/versions`)
          return Response.json({ id: versionId, version: 1, contentDigest: "a".repeat(64) });
        return new Response(null, { status: 404 });
      },
    });
    const client = createEnvironmentClient({ apiKey: key, baseUrl: server.url.origin });
    try {
      expect((await client.createEnvironment({ name: "Records", slug: "records" })).id).toBe(
        environmentId,
      );
      expect((await client.publishVersion(environmentId, definition)).id).toBe(versionId);
      expect(() =>
        client.createRun({
          idempotencyKey: randomUUID(),
          environmentVersionId: versionId,
          maxSteps: 501,
        }),
      ).toThrow(RangeError);
      expect(requests).toEqual([
        "POST /environments",
        `POST /environments/${environmentId}/versions`,
      ]);
    } finally {
      server.stop(true);
    }
  });

  test("does not retry non-idempotent registry publication", async () => {
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests++;
        return new Response(null, { status: 503 });
      },
    });
    const client = createEnvironmentClient({ apiKey: key, baseUrl: server.url.origin });
    try {
      await expect(client.publishVersion(randomUUID(), definition)).rejects.toBeInstanceOf(
        HueEnvironmentError,
      );
      expect(requests).toBe(1);
    } finally {
      server.stop(true);
    }
  });
});
