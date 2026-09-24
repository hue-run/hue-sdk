import { expect, test } from "bun:test";
import { scrubToolCredentials } from "../src/tool-definitions.js";

test("scrubs generic credentials and URL userinfo/query values without changing parameter schemas", () => {
  const input = {
    type: "mcp",
    server_url:
      "https://synthetic-user:synthetic-password@mcp.example.test/gmail?token=synthetic-query&region=synthetic-region",
    token: "synthetic-token",
    api_token: "synthetic-api-token",
    bearer_token: "synthetic-bearer-token",
    refresh_token: "synthetic-refresh-token",
    client_secret: "synthetic-client-secret",
    api_secret: "synthetic-api-secret",
    password: "synthetic-password",
    database_password: "synthetic-database-password",
    secret: "synthetic-secret",
    service_credential: "synthetic-service-credential",
    properties: {
      token: { type: "string", description: "A tool parameter named token" },
      secret: { type: "string", description: "A tool parameter named secret" },
    },
  };

  const output = JSON.parse(
    scrubToolCredentials("gen_ai.tool.definitions", JSON.stringify(input)) as string,
  ) as typeof input;
  expect(output).toMatchObject({
    token: "[redacted]",
    api_token: "[redacted]",
    bearer_token: "[redacted]",
    refresh_token: "[redacted]",
    client_secret: "[redacted]",
    api_secret: "[redacted]",
    password: "[redacted]",
    database_password: "[redacted]",
    secret: "[redacted]",
    service_credential: "[redacted]",
    properties: input.properties,
  });
  expect(output.server_url).toBe(
    "https://mcp.example.test/gmail?token=%5Bredacted%5D&region=%5Bredacted%5D",
  );
  const text = JSON.stringify(output);
  for (const credential of [
    "synthetic-user",
    "synthetic-password",
    "synthetic-query",
    "synthetic-region",
    "synthetic-token",
    "synthetic-api-token",
    "synthetic-bearer-token",
    "synthetic-refresh-token",
    "synthetic-client-secret",
    "synthetic-api-secret",
    "synthetic-database-password",
    "synthetic-secret",
    "synthetic-service-credential",
  ]) {
    expect(text).not.toContain(credential);
  }

  expect(
    scrubToolCredentials(
      "gen_ai.tool.definitions",
      JSON.stringify({ server_url: "https://[synthetic-secret" }),
    ),
  ).toBe(JSON.stringify({ server_url: "[redacted]" }));
});

test("scrubs credential values embedded in JSON Schema parameter metadata", () => {
  const output = JSON.parse(
    scrubToolCredentials(
      "gen_ai.tool.definitions",
      JSON.stringify({
        type: "function",
        parameters: {
          type: "object",
          properties: {
            authorization: {
              type: "string",
              default: "synthetic-default",
              const: "synthetic-const",
              examples: ["synthetic-example"],
              enum: ["synthetic-enum"],
              description: "The authorization argument is retained.",
            },
          },
        },
      }),
    ) as string,
  );
  expect(output.parameters.properties.authorization).toEqual({
    type: "string",
    default: "[redacted]",
    const: "[redacted]",
    examples: "[redacted]",
    enum: "[redacted]",
    description: "The authorization argument is retained.",
  });
});
