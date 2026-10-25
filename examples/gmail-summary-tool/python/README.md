# Gmail summary tool in Python

This example requires Python 3.10+ and `hue-run` 0.14.0. The tool lists five unread
Gmail messages, reads each full message, and returns only `{count, ids}`. Hue's
default HTTP capture records the API responses separately from that summary.
Each HTTP span carries the parsed JSON response in `output.value` and the status
in `http.response.status_code`.

## Run without credentials

From this directory, install the public package and run the example:

```sh
uv venv .venv
uv pip install --python .venv/bin/python -r requirements.txt
.venv/bin/python main.py
```

The default mode starts separate loopback Gmail and OTLP servers. It checks the
real exported spans, their parents, query inputs, response bodies, omitted
authorization, and export acknowledgement. The output includes a trace ID,
`"http_spans": 6`, and `"exported": true`. No model or external app is called.
The receiver proves local export, not storage in Hue or a World build.

Run the same requests with each capture policy:

```sh
HUE_CAPTURE_HTTP_BODIES=false .venv/bin/python main.py
HUE_CAPTURE_HTTP=false .venv/bin/python main.py
HUE_CAPTURE_CONTENT=false HUE_CAPTURE_HTTP_BODIES=true .venv/bin/python main.py
```

The first run checks six HTTP spans without bodies. The second checks that no
HTTP spans are exported. The last checks that metadata-only capture omits bodies
even when HTTP body capture is explicitly enabled. All runs return the same summary.
These environment variables are conventions implemented by `main.py`; the SDK
accepts constructor options and does not read them.

To check an ordinary tool nested inside a model span, run:

```sh
.venv/bin/python main.py --model-scope
```

This offline mode sends a synthetic model HTTP request before and after the same
Gmail summary tool. It checks that both model HTTP spans keep their identity and
omit their bodies, while the six Gmail HTTP spans capture their bodies under the
ordinary tool. The model keeps its provider and model metadata. With the default
capture settings, the output reports eight HTTP spans. Both servers remain on
loopback, and no model provider is called.

To use the separate shared Gmail response fixture, run:

```sh
.venv/bin/python main.py --canonical
```

The [canonical v2 fixture](../fixtures/README.md) requests `maxResults=10` and
returns five fuller synthetic messages in newest-first order, without a next-page
token. Gmail defines [`maxResults`](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)
as a maximum. The tool still summarizes at most five messages. The offline server
checks that the actual request asks for ten, and the receiver checks that the
captured query says `"maxResults": "10"` and that each response matches the server
fixture. No recorded payload or query is repaired.

The output identifies `"fixture": "canonical-gmail-v2"`. Canonical v1 and its
earlier full-page comparison remain preserved. The original default and
model-scope scenarios still request five messages.

## Read a live mailbox

Copy `.env.example` to the ignored `.env` and fill `HUE_API_KEY` and a short-lived
OAuth `GMAIL_ACCESS_TOKEN` locally, or set them through your shell. Give the Gmail
token the
`https://www.googleapis.com/auth/gmail.readonly` scope. Do not paste credentials
into code, commands saved in history, or a chat.

After loading those variables into the process environment, run:

```sh
.venv/bin/python main.py --live
```

Live mode sends only Gmail `GET` requests. It prints the message count and trace
ID, leaving message content in the trace under your capture and redaction policy.
It makes no model request and changes no mailbox data. `HUE_BASE_URL` can select
a different Hue deployment. Gmail's live hostname stays `gmail.googleapis.com`.
