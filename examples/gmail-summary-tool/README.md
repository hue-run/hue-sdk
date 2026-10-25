# Gmail summary tools

An agent tool can return a short summary while its HTTP spans record what Gmail
actually returned. These runnable consumers read `messages.list` and five
`messages.get?format=full` responses, then return `{count, ids}`. They preserve
the helper's result and add no custom endpoint markers.

- [TypeScript](./typescript/README.md) requires TypeScript SDK 0.26.0.
- [Python](./python/README.md) requires Python SDK 0.14.0.

Both have an offline mode with synthetic Gmail and separate loopback OTLP
receivers. They inspect the exported spans and acknowledgements, including
identity-only, HTTP-off, and metadata-only controls. No paid provider or real
mailbox is involved in verification. Live mode reads Gmail using credentials
from an ignored environment file and changes no mailbox data.

Default capture produces one request span, one `execute_tool` span, and six
HTTP CLIENT children of the tool. The tool returns only the summary. With
content capture enabled, the HTTP spans hold query parameters as `input.value`
and raw parsed JSON responses as `output.value`. HTTP status and selected behavior headers are separate attributes.

The local receiver proves capture and acknowledgement. A stored trace receipt
and a World build require a configured Hue project and separate verification.
