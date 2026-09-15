# Scenes protocol v1

This directory is canonical in hue-run/hue-sdk. Fern vendors schema.json and fixtures.json with a SHA-256 pin; SDKs never import Fern source. Additive public API/version changes require coordinated review.

## Portable records
schema.json defines the manifest and shared records. Timestamps are UTC ISO strings. IDs are opaque; API-owned scene/project IDs are UUIDs and external trace IDs are 32 lowercase nonzero hex characters. JSON uses finite interoperable numbers (integers beyond ±9007199254740991 are rejected); null differs from absence. Only JSON, explicit bytes, HTTP bodies and pull-only async item streams are supported codecs. Never pickle objects or serialize closures.

A binding has stable id, kind (tool/mcp/http), contractVersion, optional portable operations and accountScope. HTTP bindings require a canonical HTTP(S) origin (lowercase scheme/hostname, no default port, userinfo, path, query or fragment) and an absolute pathPrefix beginning with `/`. Noncanonical origins are rejected instead of normalized during playback. They claim origin + pathPrefix, independently of method/request matching. No selection means ordinary live behavior outside capture/playback; an unmatched request inside a selected binding is a miss. Model calls, output generation and Hue traffic must not be selected source bindings. MCP method identities are tools/call:<name>, resources/read, tools/list, resources/list and resources/templates/list. Resource-read arguments contain uri. Tool function operation is its registered name.

Observation start and finish are independent append-only records. Both retain bindingId, operation, contractVersion, requestKey, callId and producer ordering. Start carries arguments; finish carries result/error and outcome. Success requires a result payload (including explicit absent). at is observation time; a call interval comes from its start/finish. Finishes may arrive before starts. Duplicate observation id with equal canonical body succeeds, changed body conflicts. Sources may be registered on a finish; query attachments use the sources API.

Payload kind=json stores JSON up to the 256 KiB inline limit. bytes is base64 up to that same encoded limit, including empty bytes. Larger bytes/JSON use kind=blob with verified artifact ref; encoding tells the loader how to decode. HTTP bodies use nested bytes/blob payloads; metadata is not counted as original body bytes. Stream payloads preserve item order without timing. Missing/capped/unsupported content remains non-replayable with an omission reason. Sources are only query_attachment or tool_source; generated output documents have no source relation.

Optional observation.externalSpanId is the current 16-hex OpenTelemetry span identity, for trace deep links; it does not affect matching or claim the result reached a model. Scene capturePolicy records {sourceContent:true,redactionVersion:"1"} for the initial policy; later policies use their own version. Current SDKs include this policy in create/resume and freeze it into each manifest. For initial protocol-v1 producers that omit this optional field, the sole supported policy is exactly `{sourceContent:true,redactionVersion:"1"}`; omission never selects another redaction policy or disables the SDK explicit-opt-in requirement. A future policy must carry an explicit version.

## HTTP API
All routes below are under /api/v1. Bearer project service keys derive project/actor; human procedures use the same core after membership checks. Feature availability must be explicit. Every metadata request is <=1 MiB, inline payload <=256 KiB, artifact <=25 MiB, up to 200 observations per batch and 2,000 calls per scene. Unknown fields/invalid references are rejected. Use private,no-store responses.

- POST /scenes: {idempotencyKey,externalTraceId,bindings,producerId,startedAt,input?,sessionId?,observedUserId?,capturePolicy?} -> {id,captureRevision}. One scene per project/externalTraceId. Same create key/body returns original.
- POST /scenes/:id/observations: {idempotencyKey,observations} -> {accepted,captureRevision}. Observation sequence is producer-local; references use scene/project scope.
- POST /scenes/:id/sources: {idempotencyKey,sources} -> {accepted,captureRevision}.
- POST /scenes/:id/finalize: {idempotencyKey,expectedCaptureRevision,producers,endedAt} -> {sceneId,revision,digest}. Conflicting current capture revision returns409. Freeze exact observations/sources/completeness at this revision; never freeze pointers that later become playable.
- GET /scenes?after=<id>&limit=50 -> {items,nextCursor}.
- GET /scenes/:id -> scene header and revision summaries.
- GET /scenes/:id/revisions/:revision -> {manifest,digest}. Digest is SHA-256 of canonical manifest without this outer digest. Manifests that exceed response bounds are delivered using actual streaming; callers verify size limits/digest before use.
- POST /scene-replays: {idempotencyKey,sceneId,revision,bindingIds,externalTraceId} -> {id}. Reserve a new non-source trace identity and pin exact binding configuration. Server establishes trace source=replay.
- POST /scene-replays/:id/events: {idempotencyKey,events} -> {accepted}. Append idempotent replayEvent records.
- POST /scene-replays/:id/complete: {idempotencyKey,state,endedAt}, state=completed|failed|interrupted -> {id,state,missCount}. Repeated terminal write must agree; completion does not erase miss evidence.
- GET /scene-replays?sceneId=<id> -> {items,nextCursor}; GET /scene-replays/:id -> metadata and diagnostics.

Artifacts use POST /artifacts {idempotencyKey,filename,contentType,byteSize,sha256,purpose?}, purpose=source|scene_payload|preview (ordinary user artifact default remains unchanged); POST /artifacts/:id/upload -> {uploadUrl,method,headers,expiresAt}; exact PUT bytes; POST /artifacts/:id/complete; GET /artifacts/:id/download. No storage management credential reaches a client. Bodies are verified before use.

## Matching and playback
requestKey = SHA256(JCS({bindingId,operation,contractVersion,arguments})). This uses credential-sanitized portable argument JSON, not the payload wrapper or framework invocation ID. Hash fixtures are in fixtures.json. No fuzzy/semantic matching. Reject unsupported numeric/object values rather than coercing them.

HTTP arguments are {method,url,headers,bodySha256}; method uppercase, URL scheme/host/default-port normalized, fragment removed, path/query ordering and repeated values preserved. headers use lowercase names with representation headers Accept, Content-Type, Range, If-Match, If-None-Match, If-Modified-Since, If-Unmodified-Since, If-Range plus explicitly configured source argument headers. The default representation headers always participate; binding.http.headers adds extra names rather than replacing defaults. Credential headers/query fields are stripped before buffering. For a nonempty body, remove Content-Type parameters and trim whitespace; compare the remaining media type case-insensitively. Exactly `application/json` or a valid `type/subtype+json` selects strict UTF-8 JSON decoding (an initial UTF-8 BOM may be removed), credential sanitization, portable-value validation, then JCS bytes for the digest. Malformed/nonportable JSON is ineligible, with no raw-byte fallback. Other media types, including `text/json` and `application/notjson`, hash the exact bytes. UTF-16/32 JSON and streamed/multipart requests are ineligible. Shared `httpBodies` fixtures pin this gate. Zero-byte request body hashes empty bytes. Unsupported streamed/multipart request matching is explicitly ineligible.

Selection is pinned per replay. Reject selected ancestor/descendant binding overlap. Selected outer results bypass implementations/children. Per-key occurrences are consumed atomically in start-sequence order; different keys may reorder. Identical overlapping calls with differing results are ambiguous. Cross-producer order without a causal order is ambiguous if outcomes differ.

Miss reason codes: unrecorded, exhausted, incompatible, ambiguous, incomplete, unavailable_content, nonportable, overlapping_bindings, integrity. Misses never fall through to a live implementation. Plain SDK misses raise SnapshotMissError; MCP exposes isError with HUE_SNAPSHOT_MISS. Recorded exceptions use RecordedToolError, not dynamically reconstructed classes. HTTP status failures remain recorded responses. Every replay receives fresh cursors; resending diagnostics cannot rerun the agent.

Serve one recorded MCP/function namespace through local stdio. Preserve tool names/input schemas. HTTP-only sources cannot be served as original MCP tools. No state simulation, interactive MCP elicitation/sampling, remote live fallback, generated output files, or automatic URL/file dereferencing.

## Capture safety and finalization
Capture is explicitly opted in independently from trace content policy. Remove credentials before any queue. Sanitizers/extractors/export errors cannot replace live returns or exceptions. Buffering is bounded (default64 MiB payload bytes and2048 records per client, maximum2 simultaneous uploads); record dropped/pending counts. No body eager draining in injected transports; optional interceptors must bound their hidden response clones and preserve the original consumer.

Use explicit finalize with default30s drain deadline; open streams remain pending. Incomplete revisions remain inspectable and complete individual recordings may play, but cannot claim global coverage. Late arrivals can create a new immutable revision. Existing revisions and playback pins never change. Capture timestamps/SDK IDs need not be byte-identical across languages; canonical keys and preserved payloads must agree.

Retain pilot data until explicit project erasure; no retention timer. Artifact/source/derivative access is authorized and audited without payload logging. Local downloaded bytes cannot be recalled. Previews are separate immutable derivatives, never replay sources.


## Redaction version 1

Credential field names are compared after lowercasing and removing ASCII hyphens and underscores. The complete denylist is: `authorization`, `proxyauthorization`, `cookie`, `setcookie`, `password`, `passwd`, `secret`, `clientsecret`, `apikey`, `accesstoken`, `refreshtoken`, `idtoken`, `token`, `xapikey`, `xauthtoken`, `signature`, `sig`, `xamzsignature`, `xamzcredential`, `xamzsecuritytoken`, `xgoogsignature`, `xgoogcredential`. Generic `key` remains semantic data.

Remove these members recursively from JSON and from HTTP headers. Remove URL userinfo and fragments, and remove query pairs whose decoded name matches the denylist; retain the raw spelling and order of remaining pairs. The same rule applies to HTTP(S) URL strings embedded in JSON. Response JSON whose sanitization changes content is explicitly non-replayable; do not claim reconstructed wire bytes are the original response. Binary/custom formats need an explicit source codec or caller sanitizer when their bytes contain credentials. This finite rule cannot recognize arbitrary secrets hidden in free text.
