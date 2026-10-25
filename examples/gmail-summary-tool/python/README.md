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
