# Row-platform trace export fixtures

Synthetic exports for `hue traces import prepare`, one per platform, each holding the same turn of
an invented support agent: an agent span, a model call that requests the `lookup_order` tool with
its messages and token counts, and the tool call. The end user is `user-42` in conversation
`thread-7`; each tool record names a different account (`account-the-tool-touched`), which must
never become the trace's user. Ids, names, content and timestamps are invented.

The record shapes follow each platform's published source, read on 2026-10-21:

- `langsmith-runs.json`: the runs query page (`{"runs": […], "cursors": …}`) of LangChain runs:
  `Run` in `python/langsmith/schemas.py` and the `list_runs` default selection in
  `python/langsmith/client.py` of `langchain-ai/langsmith-sdk` (commit `290f06a`). Run times carry
  no zone, as LangSmith's run format documents; messages are LangChain's serialized form, the
  tool's answer a `ToolMessage` dumped as LangSmith's client dumps it, and the tool call id in
  `extra` as LangChain's tracer stores its keyword arguments.
- `langsmith-runs-v2.json`: the v2 runs query page (`{"items": […], "next_cursor": …}`): `Run`
  in `python/langsmith/_openapi_client/types/run.py` and `SyncItemsCursorPostPagination` in its
  `pagination.py`, same commit: upper-case `run_type`, top-level `metadata`, `parent_run_ids`,
  `thread_id`, `project_id`, `ls_user_id` and `raw` token details.
- `mlflow-trace.json`: `Trace.to_dict()` of `mlflow/mlflow` v3.17.2 (`mlflow/entities/trace.py`,
  `trace_info.py`, `span.py`; keys in `mlflow/tracing/constant.py`): base64 span and trace ids,
  nanosecond times as JSON integers, attribute values encoded with Python's `json.dumps`, and the
  user and session as `mlflow.trace.user` and `mlflow.trace.session` trace metadata.
- `opik-trace.json`: one file of `opik export … project …`
  (`sdks/python/src/opik/cli/exports/project.py` of `comet-ml/opik`, commit `4c2860d`): the trace,
  its spans, `attachments`, `downloaded_at` and `project_name`, with `TracePublic` and `SpanPublic`
  dumped by `json.dump(…, default=str)`, so times are Python's `str(datetime)`; usage keys as
  `opik/llm_usage` flattens them.
- `weave-calls.jsonl`: calls stream query lines, `CallSchema` in
  `weave/shared/trace_server_interface.py` of `wandb/weave` (commit `25398c8`), with the op kind in
  `attributes.weave.kind` and token counts per model in `summary.usage`.
