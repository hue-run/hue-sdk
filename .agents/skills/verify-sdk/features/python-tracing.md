# Python tracing

An application opens `Hue(base_url, api_key, ...)`, records spans, model calls and tools, and `force_flush()` returns whether the export was acknowledged.

## Sub-features

- `py-span` records `span`, `model`, `tool` and `context` with input and output.
- `py-subagent` records `subagent()` (a `with` block, or a decorator for functions and coroutine functions) as an `invoke_agent {name}` span under the active tool span, or under `parent_context` from `Hue.extract()` in another process. A shared helper restores each task's parent context independently, including nested and inherited scopes.
- `py-capture` honors `capture_content` and redaction before export.
- `py-http` observes outbound HTTP identity and eligible request and response bodies by default
  through `requests`, `httpx` and `httpx2` sync and async, `urllib.request`, `aiohttp`, `httplib2` and `urllib3`.
  It preserves consumer bytes and request headers, observes streams without extra reads, applies
  content opt-outs and redaction, marks bodies over 1 MiB, keeps model HTTP identity without bodies,
  resumes body capture in nested Hue tools and suppresses exporter traffic. Import hooks, nested
  wrappers, independent provider contexts and multiple-client shutdown remain safe.
- `py-http-identity` scrubs recognized credentials in URL paths, preserves ordinary identifiers,
  applies URL and present URI-alias redactors in both content modes, removes `url.query` and
  sanitizes aliases and method-only span names only in Hue's export copy.
- `py-http-fork` keeps ordinary HTTP working after `os.fork()`, detaches inherited capture and
  permits a fresh Hue client in the child, including inherited requests and aiohttp responses.
- `py-ack` returns `force_flush()` and receipt results that match the receiver.
- `py-media` inspects bounded, nonempty media and exports exact digests and blob entries.
- `py-file-upload` covers opt-in `record_file` uploads and name validation.
- `py-attachment` places `hue_sdk.Attachment` in recorded values and uploads it under `<attribute>#<pointer>` or `body#<pointer>`.
- `py-serving-isolation` preserves results, original exceptions and operation counts when metadata lookup or iteration fails; disabled clients never inspect optional metadata, and primitive attribute arrays have bounded traversal.
- `py-async-serving` exercises the real `AsyncOpenAI` HTTP stream through full consumption, early close and real task cancellation, with capture enabled or disabled and tracing enabled or disabled. Request context and cleanup stay intact and the provider and tool each run once.
- `py-advisory-isolation` keeps completed spans and explicit flushes independent of slow live-announcement acknowledgements, including an advisory request already in flight. Advisory delivery has one bounded slot and never holds shutdown.

## How to get to it (user POV)

- `from hue_sdk import Hue` after `pip install hue-run` (packages/sdk-python/README.md).

## Driving it with uv and the loopback stub (fake Hue API)

Preconditions:

- `uv sync --frozen --all-groups` done in `packages/sdk-python`; stub running; `HUE_BASE_URL` exported.

- **Drive.** From `packages/sdk-python`:

  ```sh
  uv run --frozen --all-groups python -c '
  import os
  from hue_sdk import Hue
  with Hue(os.environ["HUE_BASE_URL"], "synthetic-verify-key", capture_content=True, service_name="verify-sdk") as hue:
      hue.validate_project()
      with hue.span("agent.run") as run:
          run.set_input({"q": "hello"}); run.set_output({"a": "HELLO"}); trace = run.trace_id
      print("trace_id", trace, "flushed", hue.force_flush())
  '
  cat "$V"/stub.log
  ```

  Expected: `trace_id <32 hex> flushed True`, and the stub logs `GET /api/v1/projects/current` and `POST /api/v1/otlp/v1/traces` with status 200.
- **Behavior test.** `uv run --frozen --all-groups pytest tests/test_sdk.py -q -k redact`. Expected: all selected tests pass in about 2 s.
- **Outbound HTTP (`py-http`).** Run `uv run --frozen --all-groups pytest tests/test_http_capture.py tests/test_http_markers.py tests/test_http_parent_context.py tests/test_http_context_cleanup.py`.
  Check exported CLIENT spans against a loopback server, their scrubbed URLs, query/body input
  values, parsed response bodies and structured OTLP truncation placeholders. Confirm the
  application receives the same bytes and headers with capture on and off. Cover all supported clients and real Slack, Google
  API and Pipedream transports, unread and partially consumed responses, model/export suppression,
  metadata-only and HTTP opt-outs, existing redaction, imports after Hue creation and client
  shutdown. Repeat from the installed wheel, including Python 3.10. These checks use synthetic
  HTTP endpoints and establish no live-provider compatibility claim.
- **HTTP identity (`py-http-identity`).** Run `uv run --frozen --all-groups pytest tests/test_http_identity.py`.
  Check real requests and HTTPX consumer bytes, default and metadata-only policies, redacted path
  credentials and preserved business IDs. Borrowed stable and legacy URLs use the canonical URL
  redactor followed by present full URL and path hooks. Final aliases agree, query attributes are
  removed, all URI aliases disappear on invalid redaction, and the other exporter keeps its
  original attributes and span name. Path-only spans run only their present path hooks.
- **After fork (`py-http-fork`).** Run `uv run --frozen --all-groups pytest tests/test_http_fork.py`.
  All three cases cover ordinary child HTTP and a fresh child Hue client, with no inherited
  response, an inherited requests response or an inherited aiohttp response. The parent continues
  its own capture. These cases require `os.fork()` and run against the installed wheel too.
- **Sub-agents (`py-subagent`).** `uv run --frozen --all-groups pytest tests/test_sdk.py -q -k subagent`. Expected: `6 passed` in about 2 s.
- **Static checks** (3.5 s): `uv run --frozen --all-groups ruff check src tests && uv run --frozen --all-groups mypy`.
- **Serving isolation.** Run `uv run --frozen --all-groups pytest tests/test_isolation.py -k "attribute or mcp"` and `uv run --frozen --all-groups pytest tests/test_async_serving.py`. The optional compatibility group supplies the real async provider client; all HTTP responses are synthetic.
- **Advisory isolation.** Run `uv run --frozen --all-groups pytest tests/test_live_spans.py`. Inspect the delayed-advisory regressions and resource/capability checks; a successful completed-record flush is no longer a barrier for observing a live announcement.

## Gotchas

- The Python version is independent of the TypeScript version (see `pyproject.toml`).
- `RUST_LOG=info` in the shell makes uv print resolver noise; ignore it or run `RUST_LOG= uv ...`.
- CI also runs Python 3.10. Mention it if your change touches syntax or typing that 3.10 lacks.

## Recorded media and file uploads
- Langfuse-shaped values and raw PCM (since TypeScript 0.19.1 / Python 0.12.1): a JSON-convention attribute whose whole text is a `data:` URL (a Langfuse SDK's string input or output) uploads and is placed as `<attribute>#`, while other non-JSON text stays as recorded; `audio/pcm`, `audio/x-pcm` and `audio/L16` with a declared rate keep `;rate=<n>;channels=<n>` in the reservation, the `hue.blobs` entry and the placed part, and `pcm16` audio is listed as `audio/pcm;rate=24000;channels=1`. Verify with `uv run --frozen --all-groups pytest tests/test_blobs.py tests/test_inline_files.py tests/test_media_parts.py tests/test_large_media.py -q -k "raw_data_url or no_json or pcm or retry_after or no_file_to_upload"` and compare against Fern's `pcmFormatOf`.
- Uploads run after export (since 0.12.0): a record is sent with its digest parts, prefixes and `hue.blobs` entries before any reservation, and its uploads run on background `hue-upload` threads. Verify with `uv run --frozen --all-groups pytest tests/test_blobs.py -q -k "while_its_put or rate_limit or later_flush or remembered or give_way"`: a span reaches the receiver while its PUT is blocked, a blob 429 never holds or drops it, a later `force_flush` sends its own span, and a late failure keeps the entry (counted `not_uploaded`). Lines above that say failed uploads add no entries describe values refused when their record is exported.
- `py-media` covers the shared `tests/fixtures/media-parts/cases.json` corpus across `gen_ai.input.messages`, `gen_ai.output.messages` and `ai.prompt.messages`, including OpenAI content arrays, and the other attributes Hue reads files from (`ai.prompt`, `input.value`/`output.value`, tool arguments and results, OpenLLMetry entities and `gen_ai.prompt.<n>.content`, Langfuse inputs, outputs and metadata, `metadata`, `ai.telemetry.metadata.<key>`, OpenInference flattened image URLs). A case's `value` is raw attribute text compared exactly; `messages` is JSON compared parsed. Outside the recorded messages a failed upload leaves the file inline. The corpus's `logs` cases drive `log_inference` and compare the log body, its `body#<pointer>` entries and the trace the bytes were stored under. Compare both successful uploads and failed uploads with each fixture's exact messages and ordered compact JSON strings in `hue.blobs`. Hash the decoded bytes, not their base64 spelling. Content that reads as base64 is decoded whatever its declared type, as Hue reads it (`YWJj` is `abc`; corpus `genai-text-base64-*`, `vertex-media-text-base64-over-limit`, `ai-file-text-base64-over-limit`); other content is its own UTF-8 text. An invalid declared MIME type falls back to a valid data URL MIME type, then the binary/text default.
- Nonempty eligible binary parts within inspection limits export part-level `sha256` and `size` at every size. Empty values stay recorded without uploads. Successful text uploads over 64 KiB retain a UTF-8-safe 16 KiB prefix and a content-field blob entry; a text file held as bare base64 takes the digest form. Failed text uploads retain the digest and size without an entry.
- Placing a file keeps every other byte of the recorded JSON, in the attribute and in a JSON-encoded tool string (corpus `tool-strings-keep-recorded-bytes`, `tool-call-arguments-js-numbers`, `input-value-request-numbers`). Files more than ten levels deep, attribute JSON nested past 32 levels or holding an integer past 2^53, and an `input.value` declared `text/plain` are left as recorded (corpus `input-value-file-deeper-than-the-reader`, `input-value-nested-past-the-reader`, `input-value-js-numbers`; `-k text_plain`).
- Names must be nonblank after trimming, contain at most 256 UTF-16 code units, be well-formed Unicode and contain no C0 characters (U+0000–U+001F) or DEL (U+007F). Invalid source names stay in the message but do not enter blob metadata. Remote URLs, file IDs and S3 locations stay unchanged and cause no fetch.
- `py-file-upload` covers `record_file`: the existing `hue.file` event stays present, `upload` defaults to `False`, and supplied data is limited to 25 MiB. With `upload=True`, a successful upload adds `event:hue.file:<sha256>` to the same span. A `path` names a regular file: a named pipe is refused at once, never waited on, and counted. Up to 25 MiB it is read as `data`; a regular file over 25 MiB, up to 1 GB, is hashed a slice at a time when recorded and read from disk at upload, sent only if its size and SHA-256 still match (the last slice withheld until they do); a changed, removed or pipe-replaced file uploads nothing, completes nothing and counts one fallback, each read of a source starts fresh, a cut-off upload closes its file without a collection, a relative path is resolved before it is read, another reference to the same bytes uploads its own, and a 2xx answered before the whole body was sent is a failure; a file over 1 GB, or `data` with `path`, counts an instrumentation issue (`pytest tests/test_attachments.py -q -k "30_mib or changed_after or still_refused"`, sparse temporary files). Digest-only records do not upload. An invalid helper name omits only the name and counts an instrumentation failure while preserving the otherwise valid event.
- Verify duplicate media is reserved once per trace, failed uploads add no entries, and `capture_content=False` and setup credentials cause no upload requests. Whole string attributes retain their separate 1,000,000,000-byte upload limit.
- One export fits every span before any helper upload, then uploads the admitted files of all its spans four at a time within one upload budget; a file whose event was redacted or shed is not uploaded, and copies of one file share a single upload without holding a place another file needs. A requested upload of a span dropped at the queue counts in `export_status.upload_fallbacks`.
- Media inspection is bounded to 8 Mi UTF-16 code units per attribute and 16 Mi per record. A skipped value keeps its original content for ordinary hold, cut or drop admission. A span's own attribute held whole past those bounds (`Held.large`) is read in place at export (`_large_media.py`): strict base64 and base64 `data:` URL strings over 16 Ki code units without escapes become stand-ins in a skeleton parsed within 8 Mi (scanned a 1 MiB window per step), their files are decoded, hashed and uploaded a window at a time, and the placement edits the skeleton, the strings no file replaced written back as a `JoinedText` uploaded or cut from its pieces without a second copy. A percent-escaped `data:` URL is parsed, so past the bound its value uploads whole. Text is hashed, uploaded and cut as JavaScript encodes it, a lone surrogate as U+FFFD. Check the corpus's `large` cases (6.3 MB files) for both outcomes, that a 10 MB audio part is never parsed or decoded whole (parses under 64 KiB, base64 decodes of at most 1 MiB), that a value past the record's allowance is read in place, that JSON around the files over 8 Mi and a 9 Mi percent-escaped `data:` URL still upload whole, that the corpus's `placements` match (`-k shared_placements`), that JSON edits to 20,000 members render in time linear in them (`tests/test_inline_files.py -k linear`), and that `tests/test_large_media.py` places every corpus shape (and the corpus lengthened past a lowered threshold) exactly as the parsed path does (`pytest tests/test_media_parts.py -q -k "large or read_in_place or allowance or past_the_bound"`, `pytest tests/test_large_media.py -q`). In recognized message attributes on resources, events, links and log records that are not offloaded, inline media up to 64 KiB stays verbatim; larger inline media becomes a digest, preserving legacy behavior. Resources, events and links never upload; a log record correlated with a span uploads its inspected attributes' and its `gen_ai.*` structured body's media under its own trace, together with the attachments its body holds, in one placement step; a log record's message file that is not uploaded keeps the same 64 KiB rule. Verify both sides of the threshold and that no nested upload requests occur. Explicit `record_file(upload=True, ...)` remains the event upload opt-in.
- What admission and export make of a value with inline media (its parse, decoded files, edited text) is freed by reference counting as soon as they are done with it, not left to the cycle collector: `test_an_image_in_input_value_is_let_go_once_placed_without_a_collection` in `tests/test_blobs.py` places spans one after another with the collector off and bounds the peak below eight copies of one value's text.

Run `uv run --frozen --all-groups pytest tests/test_media_parts.py -q -k "helpers_across_spans or repeated_helpers or dropped_at_the_queue or code_units"` for the shared upload scheduling, `uv run --frozen --all-groups pytest tests/test_media_parts.py -q -k "corpus or correlated_logs or deprecated or over_the_cap or metadata_only or inspection_limit or nested_media or queue_cut"` for the broader capture and log-record uploads (a log body string the queue cut is never uploaded as a shorter file), and `uv run --frozen --all-groups pytest tests/test_media_parts.py -q` for inspection limits, preservation of nested records, upload-state isolation, capture opt-out and same-pointer loopback upload regressions. The installed wheel verifier runs these tests against the built package too.

Use a loopback receiver that implements blob reservation, byte upload and completion for the success path, then refuse reservation or upload for the fallback path. The generic `stub-hue.py` returns 404 for blobs and proves only fallback. Repeat the helper upload and privacy checks from an installed wheel and inspect the decoded OTLP payload and received bytes.

The shared corpus covers empty byte fields, null alternate MIME/name/inline-data selectors, a valid 128-astral-character name (256 UTF-16 units), invalid 129- and 256-astral-character names, blank names, C0, DEL and lone surrogates. Keep both fixture files byte-identical.

## Attachments placed in values
- `py-attachment` covers the `attachments` section of the shared corpus: an `Attachment` in `set_input`/`set_output`, `model()` messages, a `metadata` attribute (whole and nested) and `log_inference()` messages, with the exact recorded JSON text (the part as `{"type":"blob","mime_type","modality","sha256","size","name"}`) and the ordered `hue.blobs` strings, for successful and refused uploads. The log case's entry sits on the log record, keyed `body#/gen_ai.input.messages/0/parts/1`. A file used twice in one trace is PUT once.
- Also check: `path` and every `data` form give the same digest and the bytes are copied; an invalid attachment records `None` and an invalid name is omitted, each counted as an instrumentation issue, while the span exports; `capture_content=False` keeps the metadata part without its name and sends no reservations; a redacted or replaced value uploads nothing and counts nothing; a part deeper than 10 levels keeps its digest and counts one fallback; an attachment in a value still over the value limit with its files as digest parts (the value uploads whole) is still uploaded and listed, and its bytes are stored (`-k uploads_whole`); setup keys upload nothing.
- A `span(attributes=...)` or `set_attribute` value OpenTelemetry cannot hold (a dict, a list not of one primitive type) is recorded as JSON text with or without attachments; bytes over 25 MiB are refused before they are copied, while a `path` over 25 MiB (up to 1 GB) is hashed without being held and uploaded from disk only if unchanged. Numbers in JSON the SDK writes again are spelled as JavaScript writes them (`test_placed_json_numbers_are_written_as_javascript_writes_them` in `tests/test_inline_files.py`, and the corpus's `*-js-numbers` cases).
- One step places a log record's files: an `Attachment` next to an inline image in one `log_inference()` body is reserved at most once, by `place_logs`, and both entries sit on the log record, the inline image's first; refused, both fall back together. A log record's message file that is not uploaded keeps the 64 KiB rule: a small image stays inline and a large one becomes its digest. A record lost while it is copied counts its attachments as not uploaded.

Run from `packages/sdk-python` (about 20 s):

```sh
uv run --frozen --all-groups pytest tests/test_attachments.py -q
```

Expected: `27 passed`. `tests/test_wheel.py` runs the same file against the built wheel.

## Opt-in tool endpoint evidence

Use `uv run --frozen --all-groups pytest tests/test_tool_endpoint.py` against the loopback receiver. Check actual URL/source/method, query allowlisting without deduplication, credentials and fragment removal, metadata-only omission, existing redaction, invalid evidence and unchanged single execution/result/error. Repeat the file against the installed archive before shipping a new endpoint API. These checks make no live provider requests.
