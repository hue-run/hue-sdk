import { describe, expect, test } from "bun:test";
import {
  redactSetupTranscriptText,
  renderHumanEvent,
  renderJsonlEvent,
  renderPlainEvent,
} from "../src/setup/render.js";
import { SETUP_EVENT_CONTRACT_VERSION, type SetupEvent } from "../src/setup/types.js";
const { containsSetupSecretText, publicSetupEvidenceEvents } = (await import(
  new URL("../scripts/verify-setup-live.mjs", import.meta.url).href
)) as {
  containsSetupSecretText: (value: unknown) => boolean;
  publicSetupEvidenceEvents: (events: unknown[]) => Array<{ event: string }>;
};

const base = {
  contractVersion: SETUP_EVENT_CONTRACT_VERSION,
  runId: "setup_redaction_test",
  sequence: 1,
  timestamp: "2026-09-20T12:00:00.000Z",
} as const;
const capability = "S".repeat(43);
const tokens = [
  ...["live", "test"].flatMap((environment) => [
    ["hue", "sk", environment, "a".repeat(24), capability].join("_"),
    ["hue", "setup", environment, `setup-${"a".repeat(24)}`, capability].join("_"),
  ]),
  ["hue", "install", capability].join("_"),
  ["hue", "claim", capability].join("_"),
];
const renderers = [
  renderJsonlEvent,
  (event: SetupEvent) => renderHumanEvent(event, 200, false),
  (event: SetupEvent) => renderPlainEvent(event, 200),
];

describe("setup transcript privacy boundaries", () => {
  test("normal/setup tokens and installation proofs are removed in every presentation", () => {
    for (const token of tokens) {
      const event: SetupEvent = {
        ...base,
        event: "diagnostic",
        level: "warning",
        code: "transport_failed",
        message: `Transport refused Bearer ${token}`,
      };
      for (const render of renderers) {
        const output = render(event);
        expect(output.includes(token)).toBe(false);
        expect(output.includes(capability)).toBe(false);
      }
    }
    expect(redactSetupTranscriptText(`Bearer ${tokens[2]}`)).toBe("Bearer [private credential]");
  });

  test("redacts before output truncation and after encoded/control character normalization", () => {
    for (const token of tokens) {
      const encodings = [
        token,
        token.slice(0, -20),
        token.replaceAll("_", "%5f"),
        token.replaceAll("_", "%255f"),
        token.replaceAll("_", "\\u005f"),
        token.replaceAll("_", "_\u0000"),
        token.replaceAll("_", "_\u200b"),
      ];
      for (const encoded of encodings) {
        const output = redactSetupTranscriptText(`${"x ".repeat(480)}${encoded}`);
        expect(output.includes("hue_")).toBe(false);
        expect(output.includes("hue%")).toBe(false);
        expect(output.length <= 1000).toBe(true);
      }
    }
  });

  test("claim URLs, bare capabilities, labels and truncated redirects remain private", () => {
    const values = [
      `Redirect https://example.invalid/setup/claim#${capability}`,
      `Redirect https://example.invalid/setup/claim#${capability.slice(0, 8)}`,
      `Redirect https%3a%2f%2fexample.invalid%2fsetup%2fclaim%23${capability}`,
      `claim_secret=${capability}`,
      `{"claimToken":"${capability}"}`,
      `Fragment #${capability}`,
      `Bare ${capability}`,
    ];
    for (const value of values) {
      const output = redactSetupTranscriptText(value);
      expect(output.includes(capability.slice(0, 8))).toBe(false);
      expect(output.includes("/setup/claim")).toBe(false);
    }
    expect(redactSetupTranscriptText("https://hue.run/privacy")).toBe("https://hue.run/privacy");
    expect(redactSetupTranscriptText("a".repeat(64))).toBe("a".repeat(64));
  });

  test("closed project and plan projections remove nested properties and invalid enum values", () => {
    const token = tokens[2]!;
    const project = {
      ...base,
      event: "project.detected",
      project: {
        root: `/project/${token}`,
        fingerprint: "a".repeat(64),
        languages: ["typescript", token],
        packageManagers: ["npm", { toJSON: () => token }],
        frameworks: ["express", token],
        hue: token,
        openTelemetry: "absent",
        claimUrl: `https://example.invalid/setup/claim#${capability}`,
        nested: { token },
        toJSON: () => ({ token }),
      },
    } as unknown as SetupEvent;
    const plan = {
      ...base,
      event: "plan.ready",
      plan: {
        steps: ["detect-project", token],
        mutatesProject: { toJSON: () => token },
        backendRequired: true,
        token,
        toJSON: () => ({ token }),
      },
    } as unknown as SetupEvent;
    for (const event of [project, plan]) {
      for (const render of renderers) {
        const output = render(event);
        expect(output.includes(token)).toBe(false);
        expect(output.includes(capability)).toBe(false);
        expect(output.includes("claimUrl")).toBe(false);
      }
    }
    expect(JSON.parse(renderJsonlEvent(plan)).plan).toEqual({
      steps: ["detect-project"],
      mutatesProject: false,
      backendRequired: true,
    });
  });

  test("identifier, failure and receipt fields cannot smuggle bearer values", () => {
    const token = tokens[2]!;
    const events = [
      { event: "claim.required", claimId: token },
      { event: "claim.completed", claimId: token },
      { event: "trial.created", trialId: token, expiresAt: token },
      { event: "receipt.verified", receiptId: token, traceId: token, source: token },
      { event: "run.failed", code: token, message: token, resumable: { toJSON: () => token } },
      { event: "action.required", action: token, message: token, command: token },
      { event: "step.started", step: token },
      { event: "run.completed", outcome: token, checkpointed: { toJSON: () => token } },
    ];
    for (const fields of events) {
      const event = { ...base, ...fields, runId: token, timestamp: token } as unknown as SetupEvent;
      for (const render of renderers) expect(render(event).includes(token)).toBe(false);
    }
  });
});

describe("manual acceptance output guard", () => {
  test("independently suppresses keys, truncations and encoded/bare claim capabilities", () => {
    for (const value of [
      ...tokens,
      ...tokens.map((token) => token.slice(0, -25)),
      ...tokens.map((token) => token.replaceAll("_", "\\u005f")),
      ...tokens.map((token) => token.replaceAll("_", "%255f")),
      capability,
      `https://example.invalid/setup/claim#${capability.slice(0, 8)}`,
    ])
      expect(containsSetupSecretText(value)).toBe(true);
    expect(containsSetupSecretText("https://hue.run/privacy")).toBe(false);
  });

  test("evidence uses a closed projection and never labels event presence as independent receipt proof", () => {
    expect(
      publicSetupEvidenceEvents([{ event: "receipt.verified", traceId: "a".repeat(32) }]),
    ).toEqual([{ event: "receipt.verified" }]);
    expect(() =>
      publicSetupEvidenceEvents([{ event: "claim.required", nested: { token: tokens[2] } }]),
    ).toThrow("private material");
    expect(() => publicSetupEvidenceEvents([{ event: tokens[2] }])).toThrow("invalid event");
  });
});
