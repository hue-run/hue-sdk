# Portable capture v1

Capture records preserve source evidence for trace-to-case authoring. OpenTelemetry remains the trace foundation; a capture can link `externalTraceId` and each observation can link `externalSpanId`. No agent framework, model vendor, or Hue SDK is required. Producers can send the public JSON contract directly.

This protocol is an opt-in companion to OpenTelemetry. `schema.json` defines the portable records and `fixtures.json` contains shared canonical-JSON/hash examples exercised by the standalone TypeScript package. Capture records provide evidence for review; they do not implement recorded-response playback or automatically certify a complete simulated world.

The TypeScript API is prepared for unreleased `@hue-run/sdk@0.3.1` and requires a supporting Hue
deployment. Python has no portable capture API in its published package. Independent producers can
use this schema and the canonical fixtures without either SDK.

## Records and boundaries

The capture manifest has `schemaVersion: "1"`, a capture/project identity, a capture `revision`, optional OTel trace/session linkage, immutable tool `bindings`, append-only `observations`, verified artifact `sources`, explicit `stateEvidence`, producer watermarks, and computed `omissions`. Its SHA-256 is over canonical JSON without the outer digest. Capture revisions and telemetry revisions are independent numbers.

A binding declares a stable ID, a contract version, its tool/service operations and their JSON input schemas. Function, MCP and HTTP contracts share this representation. Adapters must be selected explicitly; models and generated answers are not source tools. The TypeScript SDK exposes an explicit function wrapper. Automatic HTTP/MCP interception is not included.

Each observation is a separate start or finish with a producer-local sequence beginning at 1. A start carries arguments; a finish carries a result or sanitized error category. They share call identity, binding, operation, contract version and request key. Finishes can arrive before starts. Equal record IDs and content are idempotent; conflicting IDs, duplicate sequences, or disagreeing call identities fail. `requestKey` is SHA-256 of canonical `{bindingId,operation,contractVersion,arguments}`; credentials are removed before buffering. The inherited `replayable` field means that this particular observation has portable content; it does not promise a complete stateful environment.

`stateEvidence` explicitly declares:

- `adapter`: `gmail@1`, `slack@1` or `gmail-provider@1`, plus service, account, actor, and optional resource identity.
- `kind`: `initial_snapshot`, `before_image` or `execution_journal`.
- `boundary`: `pre_execution`, `before_operation` or `after_execution`, optional call identity, complete collections, and known omissions.
- `initialState` and `actions`: the captured world and semantic action declarations consumed by the environment compiler. Runtime validation remains mandatory.
- Optional causal call dependencies and per-collection search coverage, including an unfinished pagination cursor.

For `gmail-provider@1`, an initial snapshot also requires `providerInterface` (`gmail-provider/v1`)
with complete selected MCP/HTTP catalogs and world identities. An `execution_journal` requires
`journal` (`hue.environment-journal/v1`) and the `after_execution` boundary, with original world
steps, coverage assessment and a separate provider-call inventory. These additive evidence records
do not change the V2 attempt connection bundle or provider transport.

A post-write response cannot become an initial snapshot. An empty collection is known empty only when its pre-execution coverage is explicitly complete. The capture API validates evidence shape and integrity; the conversion compiler validates supported world semantics and findings. A producer's assertions are recorded provenance, not independent proof of production completeness.

Source records are only `query_attachment` or `tool_source`. Complete artifact sources pin `artifactId`, `sha256`, `byteSize`, and `mimeType`. The server checks that each artifact was reserved through this capture and is ready with exactly those verified values, both at append and finalization. Expiring URLs and reference-only sources remain omissions; the server never dereferences them. Original generated outputs do not become source files or expected answers.

## HTTP and authorization

All routes use Bearer authentication and private/no-store responses. `capture_write` authorizes only the creating key's captures and uploads reserved within those captures. It grants no general artifact list, read, download, arbitrary association, evaluation write, or telemetry access. `project_write` may also use the capture API. A telemetry-only key cannot capture source content. Project membership separately authorizes conversion and retrieval of immutable capture pins.

| Method and path under `/api/v1`                     | Body / result                                                                                                                                                        |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /captures`                                    | `{idempotencyKey,producerId,startedAt,bindings,capturePolicy:{sourceContent:true,redactionVersion:"1"},externalTraceId?,sessionId?,input?}` → `{id,captureRevision}` |
| `GET /captures/:id`                                 | Capture revision and registered producer IDs; owner key only.                                                                                                        |
| `POST /captures/:id/producers`                      | `{producerId}`; registration advances the capture revision.                                                                                                          |
| `POST /captures/:id/append`                         | `{idempotencyKey,observations?,sources?,stateEvidence?}` → `{captureRevision}`.                                                                                      |
| `POST /captures/:id/finalize`                       | `{idempotencyKey,expectedCaptureRevision,producers:[{producerId,lastSequence,pending,dropped}],endedAt}` → `{captureId,revision,digest,omissions}`.                  |
| `GET /captures/:id/revisions/:revision`             | Immutable `{manifest,digest}`; owner key only.                                                                                                                       |
| `POST /captures/:id/artifacts`                      | Existing artifact reservation fields → capture-owned reservation.                                                                                                    |
| `POST /captures/:id/artifacts/:artifactId/upload`   | Scoped, short-lived PUT capability.                                                                                                                                  |
| `POST /captures/:id/artifacts/:artifactId/complete` | Verify and seal exact bytes using the existing artifact service.                                                                                                     |
| `POST /captures/:id/artifacts/:artifactId/cancel`   | Cancel a reservation before a write capability was issued.                                                                                                           |

Create identity is unique by project/idempotency key. A retry under a different key cannot take ownership. Append receipts retain their original revision. Finalization requires an exact current revision and a report for every registered producer; a retry of an already finalized identical request succeeds even after late arrivals. Later evidence creates later immutable revisions. Finalization never silently treats pending records, dropped records, missing sequences, unmatched calls, partial source bytes, or partial pagination as complete.

Each JSON request is bounded at 1 MiB, inline payloads at 256 KiB, cumulative capture data at 8 MiB, observations at 4,000 across 2,000 calls, source records at 2,000, state records at 200, and producers at 128. There are at most 10,000 mutations. Artifact uploads preserve the existing 25 MiB file and project storage limits. Integer values must be finite and within the interoperable safe range; NUL, invalid Unicode, cycles, accessors, host objects and coercive serialization are rejected.
