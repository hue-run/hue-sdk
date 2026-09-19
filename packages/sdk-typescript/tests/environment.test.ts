import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  createEnvironmentClient,
  HueEnvironmentError,
  type EnvironmentDefinition,
  type EnvironmentDefinitionV1,
  type EnvironmentDefinitionV2,
  type PublishableEnvironmentDefinition,
} from "../src/environment.js";

const key = "synthetic-environment-key";
interface NamedLegacyEnvironment extends EnvironmentDefinition {
  description: string;
}

const definition: NamedLegacyEnvironment = {
  schemaVersion: 1,
  description: "Extendable V1 world",
  state: { collections: { records: {} } },
  actions: [
    {
      name: "list_records",
      semantics: { entry: "hue.collection.list@1", config: { collection: "records" } },
    },
  ],
};
const v1: EnvironmentDefinitionV1 = definition;
const v2: EnvironmentDefinitionV2 = {
  ...definition,
  schemaVersion: 2,
  state: { collections: { records: {}, messages: {}, drafts: {} } },
  providerInstances: [
    {
      providerInstanceKey: "gmail-primary",
      providerId: "google.gmail",
      syntheticPrincipalId: "abcdefab-1234-4abc-8def-abcdefabcdef",
      configuration: {
        kind: "gmail_mailbox/v1",
        messagesCollection: "messages",
        draftsCollection: "drafts",
        mailboxAddress: "owner@example.test",
      },
    },
  ],
};

describe("environment HTTP client", () => {
  test("authors an immutable environment version", async () => {
    const environmentId = randomUUID();
    const versionIds: string[] = [randomUUID(), randomUUID()];
    const requests: string[] = [];
    const published: PublishableEnvironmentDefinition[] = [];
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
        if (path === `/environments/${environmentId}/versions`) {
          const body = (await request.json()) as { definition: PublishableEnvironmentDefinition };
          const index = published.push(body.definition) - 1;
          return Response.json({
            id: versionIds[index],
            version: index + 1,
            contentDigest: String(index + 1).repeat(64),
          });
        }
        const versionIndex = versionIds.indexOf(path.slice("/environment-versions/".length));
        if (path.startsWith("/environment-versions/") && versionIndex >= 0)
          return Response.json({
            id: versionIds[versionIndex],
            environmentId,
            version: versionIndex + 1,
            contentDigest: String(versionIndex + 1).repeat(64),
            createdAt: new Date().toISOString(),
            definition: published[versionIndex],
            actions: [],
          });
        return new Response(null, { status: 404 });
      },
    });
    const client = createEnvironmentClient({ apiKey: key, baseUrl: server.url.origin });
    try {
      expect((await client.createEnvironment({ name: "Records", slug: "records" })).id).toBe(
        environmentId,
      );
      expect((await client.publishVersion(environmentId, v1)).id).toBe(versionIds[0]);
      expect((await client.publishVersion(environmentId, v2)).id).toBe(versionIds[1]);
      expect((await client.getVersion(versionIds[0]!)).definition).toEqual(v1);
      expect((await client.getVersion(versionIds[1]!)).definition).toEqual(v2);
      expect(published).toEqual([v1, v2]);
      expect(() =>
        client.createRun({
          idempotencyKey: randomUUID(),
          environmentVersionId: versionIds[0]!,
          maxSteps: 501,
        }),
      ).toThrow(RangeError);
      expect(requests).toEqual([
        "POST /environments",
        `POST /environments/${environmentId}/versions`,
        `POST /environments/${environmentId}/versions`,
        `GET /environment-versions/${versionIds[0]}`,
        `GET /environment-versions/${versionIds[1]}`,
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
