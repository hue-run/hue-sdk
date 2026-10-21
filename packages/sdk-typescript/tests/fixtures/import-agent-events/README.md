# Agent runtime, event and transcript import fixtures

Synthetic exports for `tests/traces-import-agent-events.test.ts`. Every id, user, timestamp and
message is invented; the shapes follow each vendor's published SDK source or API reference.

- `openai-agents.jsonl`: the lines a `TracingProcessor` of the OpenAI Agents SDK writes, one
  `Trace.export()` record and the `Span.export()` records of its spans (agent, generation,
  function, response, handoff with an error, guardrail), with timezone-aware ISO 8601 instants as
  the SDK records them. Shape from `openai-agents-python` `src/agents/tracing/traces.py`,
  `spans.py`, `span_data.py` and `usage.py` (v0.24.0), which `openai-agents-js` matches.
- `raindrop-track.json`: a `POST /v1/events/track` body, an array of one AI event with two tool
  calls (one failed) and one analytics event without `ai_data`. Shape from Raindrop's HTTP API
  reference and the `raindrop-ai` 1.0.2 and Go SDK event payloads.
- `raindrop-query.json`: a Query API `GET /v1/events` page with one event and its tool call
  timing. Shape from the Query API's OpenAPI document (version 1.0.0).
- `raindrop-traces.json`: a Query API `GET /v1/traces?event_id=` answer: an interaction span, its
  model call and a failed tool call without `end_time_ns`, with the association attributes
  Raindrop's SDKs stamp on every span. Shape from the same OpenAPI document.
- `helicone-export.jsonl`: `HeliconeRequest` records as `npx @helicone/export --include-body`
  writes them: two OpenAI chat requests of one session (a tool call, then its answer) and an
  Anthropic request with no session and no response time. Shape from Helicone's
  `packages/llm-mapper/types.ts`, the `query-clickhouse` request store (which writes
  `target_url`, not `request_path`) and the export tool's writer. Token counts are stored as
  Helicone's body processors store them, with cached and reasoning tokens taken out of
  `prompt_tokens` and `completion_tokens`.
- `openai-chat.jsonl`: Chat Completions requests as a chat JSONL file holds them, one with a tool
  call, its result and a further turn, and one with no tools and no end-user field.
- `openai-responses.jsonl`: a Responses API `response` object (reasoning, a hosted web search call
  and a message, with usage) and a logged request with `input` items (a function call and its
  output) beside its `output`.
- `anthropic-messages.jsonl`: a Messages API request with a system prompt, two tool uses and their
  results (one `is_error`), and a response with thinking, text and cache usage.
