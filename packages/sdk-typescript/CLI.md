# Hue setup CLI

The local setup-session CLI core shipped in TypeScript `0.3.1`. TypeScript `0.4.0` is an unreleased,
activation-gated candidate for the real one-command flow:

```sh
npx --yes @hue-run/sdk@latest setup --agent
# Default Terminal mode, when a person is present:
npx @hue-run/sdk@latest setup
```

These public commands are not working onboarding promises until candidate publication, Fern
activation, production acceptance and `latest` promotion all pass. The automatic matrix is limited
to Express with npm, Express with Bun, and Flask with uv in a single application package with one recognizable
entrypoint, a literal existing GET route and `PORT` supplied by the environment. The command uses the
detected manager to install an exact runtime, inserts two owned middleware marker blocks without
rewriting business logic, starts that exact entrypoint without a shell, authenticates its loopback
socket before sending HTTP, makes one request on that same socket, flushes, and verifies its exact trace/span receipt.
A delayed listener, failing handler, missing telemetry or receipt failure never authorizes replay of
business work. A setup probe is separate transport evidence and cannot establish application
instrumentation.

Workspace roots, mixed languages/managers, custom Hue versions, edited marker blocks, unfamiliar
entrypoints and ambiguous routes stop with `action.required`. Follow its specific local action and
rerun the same installation; select the intended application package with `--project` when needed.
Setup does not choose a monorepo package or silently broaden its supported shapes. Preserve the
application's business logic when completing an integration manually.

The bounded fixture contract is ESM JavaScript/TypeScript Express with `const app = express();`,
one literal `app.get(...)`, an environment-selected listen port, and a start script containing only
`node path/to/server.mjs` (or `.js`, `.ts`, `.mts`) or `bun path/to/server.mjs`. A Bun start script
requires the Bun manager. Plain JavaScript does not need a TypeScript dependency. Flask uses root
`app.py`, `app = Flask(__name__)`, one literal `@app.get(...)` and a port read from
`os.environ["PORT"]`. Routes cannot contain network-path prefixes, escapes or dynamic segments.
JavaScript/TypeScript shebang/BOM entrypoints require manual integration. Python UTF-8/ASCII
shebang, encoding, comments, module docstring (including parenthesized forms) and future imports
are preserved using an isolated stdlib Python 3 syntax parser. Other encodings and ambiguous
statement layouts are refused. Package roots nested in an npm/Bun workspace or beneath any Python
project manifest are refused because managers can update ancestor locks; Python build-system/custom-source projects are also outside this matrix.
`uv` uses binary-only dependency installation and starts with no implicit sync/build.

The generated `hue.setup.mjs` or `hue_setup.py` always selects `captureContent: false` /
`capture_content=False`. For a supported application, setup installs the dependency and adds the
managed import and middleware registration to the existing entrypoint; an unreferenced helper is
not a completed integration. TypeScript uses `@hue-run/sdk@0.25.0`, `@opentelemetry/api@1.9.1` and
`@opentelemetry/context-async-hooks@2.11.0`; Python setup uses its separately tested package pin.
Content capture requires an ordinary account-managed key and a later explicit application decision.

The generated bootstrap supplies standard active SERVER-span context across asynchronous/streaming
handlers; the core SDK's global-provider/context ownership is unchanged. It preserves a working
caller context manager and disposes only its own instance. Unknown local imports, custom/late manager
bootstraps, runtime preloads and conflicting OTel dependencies require manual review before any
mutation or provisioning. Automatic Express entrypoints import only Express, the standard OTel API,
or the supported `node:fs`, `node:fs/promises`, `node:timers/promises` and `node:stream` modules.
Syntax parsing, not matches inside comments/strings/templates/regular expressions, establishes the
constructor and literal route. Custom middleware, alternate route methods, app aliases/escapes and
extra Flask handler decorators are outside the automatic matrix. The one selected request must finish with a 2xx response; a 404 or
telemetry failure never authorizes a business retry.

Bun runtime checks and application launch use an explicit empty config and disable dotenv loading.
Local runtime/preload settings, dotenv files and a global `.bunfig.toml` require manual review before
any Bun invocation. The only supported local `bunfig.toml` is an `[install]` section with one
credential-free registry origin for package installation; this does not become runtime config.

Automatic Express listeners must be the single top-level
`app.listen(Number(process.env.PORT), "127.0.0.1")` (the direct `process.env.PORT` argument
is also recognized). Flask permits only `app.run(port=int(os.environ["PORT"]))`, optionally
with `host="127.0.0.1"`, at module level or under the usual main guard. Custom callbacks,
server handles, socket metadata access, reloaders, workers and listener options require manual
integration. Flask dotenv/runtime bootstrap configuration also requires review.
Before dependency or credential changes, an isolated compile-only check validates the selected
Node/Bun entrypoint without executing it; Node-unsupported TypeScript syntax is refused.

During this setup-owned invocation only, a bounded server-first proof authenticates the retained
loopback connection. HTTP uses that exact socket once, with no redirect, redial or retry. Express
uses a private inner listener and a one-connection forwarding listener; Flask uses its standard
request-handler seam. The per-attempt secret stays in memory/private child transport, never in
events, checkpoints or receipts. Ordinary app starts have no handshake and retain their original
listener behavior. This prevents accidental requests to an unrelated listener, not access by
malicious code running as the same local user.

Setup creates no simulation, Hue Run, evaluation, source capture, worker or remote execution. Package
manager lifecycle scripts are disabled. The supported existing application entrypoint is executed
directly with fixed argv solely for its bounded local HTTP verification; no shell command is accepted.

## Technical preflight and privacy disclosure

Read-only project detection and conflict checks precede project mutation. Public
`GET /api/v1/setup/preflight` reports `available` or `inactive`, `metadata-only-v1`, trial limits and
lifetime, and the published privacy and security information. An inactive deployment remains
unverified. An available deployment proceeds through runtime installation, private installation and
credential provisioning, managed application wiring, one application request and exact receipt
verification.

Before telemetry, `privacy.notice` presents `https://hue.run/privacy`, effective date `2026-08-24`,
and `https://trust.hue.run/`. This is a non-blocking disclosure. Setup has no acceptance step or
acceptance fields and does not infer a person's acknowledgement. It does not invent notice content.

The anonymous ingestion window is 24 hours with lifetime limits of 100 traces, 1,000 spans and 2 MiB
of sanitized stored data. Unclaimed data is purged seven days after expiry. Claim preserves the
project and its data; the setup-issued replacement key remains metadata-only.

## Commands and modes

```sh
hue setup                 # provision/configure/verify, then prepare a private owner handoff
hue resume                # continue the same project/origin installation
hue status                # read status; after claim, reconcile generation 1 if necessary
hue claim                 # open the owner-only handoff, or reconcile after browser claim
hue claim --restart       # explicit owner recovery; requires an interactive local terminal
hue setup --agent         # noninteractive version-2 JSONL events
hue setup --format human  # explicit append-only terminal rendering
hue setup --origin http://127.0.0.1:PORT # isolated loopback tests only
hue login                 # validate keys created in Hue and store them in ./.env.hue
hue mcp install --client claude-code # write the Hue MCP configuration for a coding agent
hue world create --apps linear,slack --files ./data --describe "A 40-person support team" # make a World
hue world run <world version id> -- node agent.js # run an agent in a fresh instance of it
hue listen --subscription <id> --forward-to http://localhost:3000/slack/events # deliver events to a local bot
hue import langfuse --from 2026-01-01 --dry-run # count a Langfuse project's traces, then import them
hue traces import prepare ./exports --out ./exports.hue-import --json # convert exports into a bundle
hue traces import upload ./exports.hue-import --authorization-file ./authorization.json --json # deliver it
```

Hosted setup accepts HTTPS origins only. HTTP is accepted solely for `localhost`, `127.0.0.1` and
`[::1]` test origins. Origins with credentials, paths, queries or fragments are refused, and
redirects are never followed.

`--agent` never reads stdin or opens a browser. It emits exactly one terminal `run.completed` or
`run.failed` event and only a generic owner action. No setup mode prints a bearer claim URL or token.
The CLI saves the capability in an ignored owner-only local handoff and human Terminal mode opens
only that local file; the browser consumes the short-lived one-time capability. A repository-reading
agent can read local project files, so this boundary prevents durable transcript/log disclosure, not
a malicious local process. The browser owns the claim cookie; the CLI never reads it. After claim
completes, rerun `hue claim` or `hue status` to fetch credential generation 1, atomically replace the
locally managed key, verify the preserved original receipt and confirm the old key receives `401`.
The superseded key is retained only in private managed state until that check succeeds, so an
interruption does not lose the revocation check. Reconciliation does not replay the application
request or require a second one.

A pending handoff expires after at most ten minutes and is exchanged once for a distinct browser
session lasting at most thirty minutes; both deadlines are bounded by trial expiry. Status polling
never creates or rotates a handoff. Retrying or reopening a pending handoff keeps its original ID
and expiry; a consumed handoff with an active browser session remains intact. Only the owner can
explicitly replace an expired or lost handoff with `hue claim --restart`; this persists a new ID and
uses the observed predecessor for compare-and-swap. A conflict refreshes status once and stops.
At most 32 distinct handoff IDs exist per installation; `SETUP_HANDOFF_LIMIT` is terminal. Replacing a
handoff does not create a trial, reset quota or rerun business work.

## Store project keys

`hue login` stores keys that a person creates in Hue; it never mints one, because setup
credentials are deliberately isolated from ordinary project keys. It prints the key settings page
(`<origin>/settings/integrations`, opened in a browser only when a terminal is attached and
`--no-browser` is absent), then reads one **Read and write** key from stdin without echo. By
default that single key serves both uses: it is checked with `GET /api/v1/projects/current` and
`GET /api/v1/datasets` (a **Read** or **Tracing only** key is refused because it cannot use
evaluations) and with an MCP `tools/list` request, then stored as `HUE_API_KEY` with
`HUE_BASE_URL` and `HUE_MCP_KEY` with `HUE_MCP_URL` in one write. A rejected key (`401` or `403`)
exits `1` and stores nothing. `--keys evaluations` stores only `HUE_API_KEY`; `--keys coding-agent`
stores only `HUE_MCP_KEY` and also accepts a **Read** key, for an agent that should only inspect the
project. Run them separately with different keys if you want to revoke either use alone.

```sh
hue login                                  # one key for both uses into ./.env.hue
hue login --keys coding-agent --gitignore  # only HUE_MCP_KEY; add .env.hue to .gitignore
hue login --origin https://staging.hue.run --env-path .env.staging
```

`--env-path <path>` writes another env file, creating it when missing. `--env-file <path>` is
accepted too, but Node 22 and 24 read that flag from the whole command line and exit with
`node: <path>: not found` before `hue` runs when the file does not exist yet.

The env file is written with mode `0600` through a temporary file and an atomic rename. Other
lines are preserved; a symlink or a non-regular file is refused; an existing different value is
replaced only with `--force`. Empty values, whitespace and URLs are refused before any request.
The production MCP server is available only at `https://mcp.hue.run/mcp`. `hue login` uses
`https://mcp.staging.hue.run/mcp` with `https://staging.hue.run` and `<origin>/api/mcp` for other
development or preview origins; plain HTTP origins are accepted for loopback test servers only.
Output names variables and lengths (`Stored the key (NN chars) as HUE_API_KEY and HUE_MCP_KEY`),
never values. When git does not ignore the env file, the command warns; `--gitignore` appends the
file name to the `.gitignore` next to it. Exit codes: `0` stored, `1` failed, `2` usage error, `130`
interrupted.

## Install the MCP for your coding agent

`hue mcp install --client <name>` writes, runs or prints the configuration for Hue's MCP server,
in the shapes of the [connection guide](https://docs.hue.run/agents/mcp-server): server name
`hue` and the endpoint (default `https://mcp.hue.run/mcp`; `--url https://mcp.staging.hue.run/mcp`
for staging). Hue's Settings page does not show these snippets; this command keeps its own copy.

`--auth` chooses how the client authenticates:

- `oauth` configures the URL only. The client opens Hue in a browser, where you sign in and
  approve the connection; no key is involved. A new sign-in connection has **Read and
  write** access to every active project in the organization the consent page names, within your
  role, so an agent first calls `list_projects` and passes the chosen project's id as `project_id`.
  The approval lasts 30 days; then sign in again. Sign-in covers the MCP server only: tracing and
  `hue eval` still use a project key as `HUE_API_KEY`. It is available for `claude-code`, `codex`,
  `conductor` and `cursor`; the other clients use a key.
- `key` references the `HUE_MCP_KEY` environment variable, which `hue login` stores in
  `.env.hue`. A key value is never written. Use a key for read-only access (a **Read** key, which
  only `hue login --keys coding-agent` accepts), for a run that cannot complete a browser sign-in
  (CI, `claude -p`), or for access that must outlast 30 days.

Without `--auth`, `claude-code`, `codex`, `conductor` and `cursor` sign in and the other clients
use a key. `--read-only` (or `read_only=true` in `--url`) selects a key. Otherwise `claude-code`,
`codex` and `cursor` keep the choice of the server's existing entry, in `./.mcp.json`,
`./.cursor/mcp.json` or as `codex mcp get` reports it, so a rerun that changes `--toolsets` keeps a
key and its `read_only`; for a new entry they use a key when `HUE_MCP_KEY` is set (only its
presence is checked). When `codex` is on `PATH` but `codex mcp get` fails
for another reason, the command asks for `--auth` rather than guess which to keep. `conductor` keeps signing in, since
its agents read the login-shell environment Conductor captures rather than your terminal's. The
command names its choice on stderr; pass `--auth` to replace an entry as given.

`--project <id-or-slug>` pins either kind of connection to one project. The command adds or
replaces `?project=<value>` while keeping `toolsets`, and names the server `hue-<value>` so it can
sit beside the organization-wide `hue` connection. A pinned connection's tools do not publish or
accept `project_id`; `list_projects` returns only that project with `connection.pinned: true`.
The printed sign-in Codex TOML keeps its URL bare and sends `X-Hue-MCP-Project` together with any
`X-Hue-MCP-Toolsets` header. An empty pin is refused. If the selected project is inactive or the
credential cannot reach it, Hue returns HTTP `404`; change or remove `--project`, because signing
in again does not change the credential's reach.

`--read-only` selects a key and adds `?read_only=true` to its URL, so Hue hides and rejects write
tools whatever the key allows. A project key, with or without it, keeps reaching its one project.
With `--auth oauth` it is refused, as is any `read_only` in a sign-in `--url` (Hue reads only
`true` or `1`): a sign-in connection has **Read and write** access, so use a **Read** project key
for read-only access.

`--toolsets <names>` chooses the tools the connection lists: `all`; the profiles `observe`
(production reads), `author` (author evaluations) and `evaluate` (run an agent against a case);
or the groups `project`, `traces`, `eval_sets`, `runs`, `judges`, `cases`, `runners`,
`environments`, `intents` and `docs`, comma-separated. Each group holds at most 20 tools. The
selection is added to the URL as `?toolsets=<names>`, for a key or a sign-in configuration alike.
Without `--toolsets`, `claude-code`, `codex` and `conductor` select `all`,
because those agents defer MCP tools behind their own tool search; `cursor`, which caps the tools
it loads, selects `observe`; the other clients list Hue's default. The default is the production
reads plus `search_hue_tools`, which finds every other tool the connection can call, and
`execute_hue_tool` and `execute_hue_write_tool`, which call one by name (the write executor only
with write access), so nothing is out of reach. `--toolsets` replaces a selection already in
`--url`, and a selection in `--url` is kept without it. Unknown names are refused rather than
passed on, because Hue ignores them and would list its default. `get_project_context` is always
listed and reports the selection.

MCP arguments and results name ids after their product objects. Eval tools use `eval_set_id`,
`eval_set_version_id`, `from_eval_set_version_id` and `eval_set_case_id`; `evaluator_id`,
`evaluator_version_id` and `evaluator_version_ids`; `run_id` and `baseline_run_id`; and
`scoring_run_id` and `scoring_item_id`. Dispatches use `managed_run_id` and `local_run_id`,
reviewed cases `case_id`, environment versions `environment_version_id`, and trace-check versions
`trace_check_version_id` or `active_trace_check_version_id`. List results are named `eval_sets`,
`evaluators`, `runs`, `scoring_runs` and `cases`, while a row's own id remains `id`.

| Client | Key (`--auth key`) | Sign-in (`--auth oauth`) |
| --- | --- | --- |
| `claude-code` | Merges `mcpServers.hue` into `./.mcp.json`. `--scope user` runs `claude mcp add --transport http --scope user hue URL --header 'Authorization: Bearer ${HUE_MCP_KEY}'` when `claude` is on `PATH`, otherwise prints it. | Merges `mcpServers.hue` with only `type` and `url` into `./.mcp.json`; `--scope user` runs `claude mcp add --transport http --scope user hue URL`. Then restart Claude Code, run `/mcp`, select `hue` and choose **Authenticate**. |
| `codex` | Runs `codex mcp add hue --url URL --bearer-token-env-var HUE_MCP_KEY`, or prints the `[mcp_servers.hue]` TOML block for `~/.codex/config.toml`. | Runs `codex mcp add hue --url URL`, which signs in at once and waits up to 5 minutes for the browser; without `--auth` and outside a terminal (CI, an agent's shell tool) the command prints it instead. A sign-in that does not finish leaves the server registered, and `codex mcp login hue` signs in. Then start a new Codex session. The printed TOML block keeps its URL bare and sends the selection as the `X-Hue-MCP-Toolsets` header. |
| `conductor` | Runs the Claude Code user-scope and Codex key commands above. | Runs `claude mcp add --transport http --scope user hue URL` and `codex mcp add hue --url URL` (printed outside a terminal, as for `codex`). Then use `hue`'s authentication action in Conductor's MCP status (the plug icon or `/mcp-status`). |
| `cursor` | Merges `mcpServers.hue` into `./.cursor/mcp.json` with `${env:HUE_MCP_KEY}`. | Merges `mcpServers.hue` with only `url` into `./.cursor/mcp.json`. Then turn on `hue` in Cursor's MCP settings and use its login action, or run `cursor-agent mcp login hue`. |
| `vscode` | Merges `servers.hue` and the `hue-mcp-key` password input into `./.vscode/mcp.json`. | Refused. |
| `windsurf` | Prints the `serverUrl` snippet for `~/.codeium/windsurf/mcp_config.json`; nothing is written to the home directory. | Refused. |
| `gemini` | Runs `gemini mcp add --scope user --transport http hue URL --header 'Authorization: Bearer ${HUE_MCP_KEY}'`, or prints it. | Refused. |

Every Codex TOML block sets `supports_parallel_tool_calls = true`, so Codex runs Hue's independent
calls in parallel rather than one at a time. `codex mcp add` has no option for it, so after
registering with Codex the command names the line to add under `[mcp_servers.hue]`.

Conductor has no MCP configuration of its own: its Claude Code and Codex agents read their user
configuration in every workspace, so `conductor` registers the server at user scope with each CLI
on `PATH` and prints the command for a CLI that is missing. A failing CLI does not stop the other;
the command then exits `1`. Hue has not yet verified the complete signed-in Conductor flow (consent
through a trace read) end to end; if Hue's tools do not load after signing in, run the command
again with `--auth key`.

JSON files are parsed and merged: other servers, inputs and top-level fields are kept, only the
selected server entry is replaced (`hue`, or `hue-<value>` with `--project`), and invalid JSON
(including comments) is refused together with the snippet
to add by hand. Files are written through a temporary file and an atomic rename. A new file is
owner-only (mode `0600`, narrowed further by the umask), because other servers' literal tokens often
end up in it; a replaced file keeps its read, write and execute permissions, so a file kept at
`0600` is never widened, except that other accounts lose write access (they could add a command for
the client to run). It keeps its group, and its owner when root runs the command (if root cannot
give the file back, the write fails and the old file stays); when the group cannot be kept, the
group and other accounts get only the access both had. Setuid, setgid and sticky bits are dropped,
and an access control list is not kept: the replacement has only the mode bits, whose group bits are
the list's mask, plus any default list the directory gives new files, whose entries then get up to
the group's access. Restore a list afterwards if you use one. A symlinked file, or a symlinked
`.cursor` or `.vscode` directory, is refused; the current directory itself may be reached through a
symlink. The directory is checked before the file is read and again before the rename, and a
different file found in place of the one read is refused, but not atomically: an account that can
write the project directory and races the command can still swap in a link between the last check
and the rename. `--dry-run` prints the resulting file content or commands without writing or
running. In printed file content, every header and `env` value, and each other credential it
recognizes (a known token prefix, the value of an option such as `--api-key VALUE`, `-H VALUE`,
`-e NAME=VALUE` or `--token=VALUE`, a field or assignment such as `clientSecret`, `key` or
`STRIPE_KEY=`, a token-like URL path segment, a URL's query values, which read `%5Bredacted%5D`), is
shown as `[redacted]` unless the whole value is a variable or input reference such as
`Bearer ${HUE_MCP_KEY}`; the file keeps the values. Hue's own URL shows its `toolsets`, `project`
and `read_only` selections, with every other query value and any token-like path segment as
`[redacted]`, there and in the lines that report what the command did; a command printed for you to
run keeps `--url` as given. `--print` prints only the snippet. Client CLIs run without a shell, so
the `${HUE_MCP_KEY}` reference reaches them literally; the printed commands use single quotes for
the same reason, and quote a URL with a query such as `?read_only=true`, whose `?` is a zsh glob.

After a key installation the command reminds you to export `HUE_MCP_KEY` in the shell that starts
the client (VS Code prompts for the key instead). A desktop app started from the Dock or a launcher
does not see that shell's variables, and Conductor's agents read the login-shell environment that
Conductor captures, so sign-in is the simpler choice there. After a sign-in installation it says
how the client loads the server (restart Claude Code, or a new Codex session) and names its
authentication action. Both end with the prompt that verifies the connection:
`Use the Hue MCP: call list_projects and confirm which project to inspect. Then call get_project_context and show that project's traces from the last 24 hours that need attention or have errors, with links; if there are none, show its 5 most recent traces. For an organization connection, pass the project's id or slug as project_id on each call after list_projects.` A pinned installation instead verifies `connection.pinned: true` and omits `project_id`. `list_projects` returns a project key's one project too. Exit codes:
`0` done or printed, `1` failed, `2` usage error.

## Create a World and run your agent in it

`hue world create` makes a World of Hue's simulated apps, several apps in one World, and
`hue world run` starts an instance of it and runs your agent there. Both need a **Read and
write** `HUE_API_KEY` (from the environment, `--env-path` or `./.env.hue`) and a Hue deployment
that serves the World creation routes; `--origin` defaults to `HUE_BASE_URL`, then
`https://app.hue.run`.

```sh
hue world create --apps linear,slack --name "Acme support" --files ./data --describe "A 40-person support team"
hue world create --apps linear --export-from linear
hue world run <world version id> -- node agent.js
```

A World is filled from your files, from a description, or both:

- `--files <dir>` uploads every file under the directory, hidden files skipped, exactly as it is.
  With one app in `--apps` every file is that app's; with several, each app's files go in
  `<dir>/<app>/`, and a file outside them is refused before anything is sent. Each file's path
  in the export is sent as its `name`: its path under `<dir>`, or with several apps under
  `<dir>/<app>/` (`channels/general/2026-01-05.json`). An empty file is skipped with a note.
- `--describe "<text>"` asks Hue to generate the apps' data from the description.
  `--dry-run` prints the outline and estimate Hue answers and creates nothing.
- `--export-from <list>` reads the named apps on your machine with your own access and uploads
  what they answer as each app's files, at most 25 MiB each. The app must also be in `--apps`.

| App | Credentials | What is read |
| --- | --- | --- |
| `linear` | `LINEAR_API_KEY`, or `COMPOSIO_API_KEY` with `--composio-user` and `--composio-account` | The queries of Hue's world-import guide, every page, with each nested list completed past 50 records. A field Linear refuses for the key is dropped from its query and named. Each object is kept as Linear returns it, `__typename` included. |
| `slack` | `SLACK_TOKEN` (a user token reads the most) | `auth.test`, `team.info`, `users.list`, `conversations.list` and `users.conversations`; per conversation `conversations.info`, `conversations.members` (not for a DM), `conversations.history` and the `conversations.replies` of each thread; `pins.list` and `bookmarks.list` per channel; `files.list`; `reactions.list`, `users.profile.get` and `dnd.teamInfo` for the token's own user. |
| `salesforce` | `SALESFORCE_ACCESS_TOKEN` and `SALESFORCE_INSTANCE_URL` (the org's `https://<name>.my.salesforce.com`) | REST API v67.0: the token's user, `sobjects`, and for each standard object Hue simulates (`Account`, `Contact`, `Lead`, `Opportunity`, `Case`, `Task` and the rest of its list) and each queryable custom object, its describe and every page of `query` (live records; deleted ones are not exported for now) over its fields except base64, address and location ones. An object whose query URL would pass 12 KB is read in field groups under that size, each the same full listing with `Id`, so Salesforce's URL limit never drops its records; the export names each object it split and into how many groups. |
| `gmail` | `GMAIL_ACCESS_TOKEN`, an OAuth access token with `gmail.readonly` | `profile`, `labels`, every page of `messages` with spam and trash, each message in `full` format and again in `raw` format when it has an attachment and is at most 190,000 bytes, and every page of `drafts`. Messages are read four at a time. |

Slack, Salesforce and Gmail calls are recorded as exchanges,
`{"request": {"method", "url", "headers", "body"}, "response": {"status", "headers", "body"}}`:
the request's headers without its credential (`Authorization`, `X-Api-Key`, cookies), and the
answer and its headers as the app gave them (cookies left out); a conversation the token cannot
read is recorded with Slack's `ok: false` answer. Each read an app refuses (a Slack `ok: false`,
a Salesforce describe or query error, a Gmail list or message error) is also named on stderr, so
a partial export shows as one. A page too large for one file (25 MiB) is asked for again in
smaller pages: a Slack list page from the same cursor at half its limit, down to 100, keeping
the cursor chain whole (`conversations.list` stays at 200), and a Salesforce listing from the
start at `batchSize=200`. A Gmail message too large for one file, or a page still too large at
the smallest size, is left out and named in the summary. Through Composio, Linear's queries run with the
`LINEAR_RUN_QUERY_OR_MUTATION` tool on the connected account, and the World also answers the
Composio calls your agent makes with the same user id and connected account. The credentials
travel only in request headers, are never recorded and are replaced with `[redacted]` in output.
Rate limits are waited out as the app's answer asks, and a 5xx or a dropped connection is tried
again after 1, 2, 4 and 8 seconds.

Hue answers a signed upload URL per file. The command sends each file's exact bytes there (it
checks a file on disk has not changed since it was hashed), retries a busy upload, then tells Hue
the uploads are done. It prints each status as Hue reports it and waits up to `--wait` seconds
(default 900; `0` returns once Hue has started). A ready World prints, on stdout:

```text
World: https://app.hue.run/...
World version: <world version id>
Stored: 1240
  linear issues: 1200
  linear users: 40
Normalized: 3
  linear date_format: 3
Stand-ins: none
...
Run your agent in it: hue world run <world version id> -- <command>
```

The report is Hue's by app account: what it stored, normalized, stood in for, assumed, does not
simulate and excluded. Each section prints its total, then a line per app (with its account
when it has one) and collection, code, field or kind, with its count. A refused request or a failed World prints Hue's error code and its first
faults (a code, a record kind, its id and a field, never a value). The signed URLs are never
printed.

`hue world run <world version id> -- <command> [args...]` starts an instance, then runs the
command (no shell; everything after `--` is its arguments) with the instance's variables:
one `HUE_SIM_<SURFACE ID>_URL` per simulated app, `HUE_WORLD_TOKEN`, `HUE_WORLD_NOW`,
`HUE_WORLD_ID`, `HUE_MCP_CONFIG` naming an owner-only `mcpServers` file that is removed after the
command, and `HUE_MCP_URL`, `HUE_MCP_TOKEN` and `HUE_MCP_EXPIRES_AT` for the first MCP mirror. The
rest of your environment, including `--env-path` variables, is passed on except `HUE_API_KEY`,
`HUE_MCP_KEY` and any other Hue project credential. When the command exits, the instance is
finished as `completed` (exit code 0) or `abandoned`, and stderr lists the calls the command made,
by app surface, operation and classification, what it changed, and the coverage gaps it met
(calls the World does not simulate, and a gap reported to Hue):

```text
Calls: 4
  2 × linear/graphql issues (ok)
  1 × linear/graphql issueUpdate (ok)
  1 × linear/graphql customerNeeds (unimplemented)
Writes: 1
  updated issues 5c3e... (/stateId, /updatedAt)
Coverage gaps: 1
  1 × linear/graphql customerNeeds (unimplemented)
```

The command's stdout and stderr are its own; Hue's lines go to stderr. Ctrl+C reaches the
command; a second stop request a second or more after the first kills it, and the instance is
still finished and reported. Without a terminal (in CI or a script) the command runs in a
process group of its own: a stop request reaches everything it started, and whatever it leaves
running when it exits is stopped (`SIGTERM`, then `SIGKILL` 5 seconds later) before the instance
is finished. In a terminal the command keeps the terminal, so it can read from it, and Ctrl+C
reaches everything it started. If the MCP configuration file cannot be written, the instance is
abandoned. Exit codes: `create` exits `0` when the World is ready (or started
with `--wait 0`, or previewed), `1` when it failed or is not ready in time, and `130` when stopped;
`run` exits with the command's code (`128` plus the signal number when a signal ended it, `127`
when it could not start), or `1` when the instance could not start or the command succeeded but
Hue could not finish or report the instance. Both exit `2` for a usage error.

## Deliver simulated events to a local bot

`hue listen` delivers a simulated world's events to a receiver on your machine, so an event-driven
agent such as a Slack bot can be tested without a public URL, the way `stripe listen --forward-to`
delivers webhooks. Hue signs each request as the provider does (Slack Events API requests today);
the command pulls them, forwards each one unchanged to `--forward-to` and reports the bot's answer
to Hue. It needs a **listen** event subscription on the world or on a connection key, and the bot
configured with that subscription's signing secret where `SLACK_SIGNING_SECRET` went. Event
subscriptions are not yet available on `https://app.hue.run`; until the origin offers them, the
command exits `1` with the refusal it receives.

```sh
hue listen --subscription <id> --forward-to http://localhost:3000/slack/events --env-path .env.world
```
The credential is the subscription's own, read from the environment (or `--env-path`, loaded first;
a variable already set keeps its value): `HUE_WORLD_TOKEN` for a world's subscription or
`HUE_CONNECTION_KEY` for a connection key's, chosen with `--credential world-token|connection-key`
when both are set. It is never taken from the command line, where other local processes and shell
history can read it. A project key is refused: a value equal to `HUE_API_KEY`, `HUE_MCP_KEY`,
`HUE_PROJECT_KEY` or `HUE_SERVICE_KEY` exits 2 before any request.
`--origin` (default `HUE_BASE_URL`, then `https://app.hue.run`) must be HTTPS, or plain HTTP on a
loopback test server.

Each request reaches the bot with its body bytes and headers unchanged, so the provider's signature
verifies as it would in production; only `Host`, `Content-Length` and connection headers are the
local request's own, and Hue's credential is never forwarded. No redirect is followed: a `3xx` is
reported as the answer. An answer counts only within three seconds, Slack's acknowledgement window;
a later one is a timeout. A failing answer with `x-slack-no-retry: 1` is reported so Hue stops
retrying it. Only a successful URL verification answer's body (at most 4 KiB, for its challenge) is
sent to Hue; any other answer body stays on this machine. Each pull waits for at most 20 seconds and
leases up to `--max` deliveries (1 to 10, default 10), which are forwarded concurrently; the next
pull starts once they are acknowledged, and a delivery beyond `--max` is never forwarded. A waiting
pull that forwarded something is not repeated until 50 ms after it began, and one that answers at
once with nothing new to forward is not repeated for a second. A provider retry of
an event is a new delivery and is forwarded again with its `X-Slack-Retry-Num` and
`X-Slack-Retry-Reason`, so the bot deduplicates by `event_id` as it does with Slack. A delivery Hue
hands out a second time is not sent again; its recorded answer is repeated. An acknowledgement Hue
did not answer is repeated until the delivery's lease ends, as the pull's answer stated it, and for
at most 30 seconds.

`--forward-to` must name this machine: `localhost`, a `.localhost` name or a loopback address, and a
name is refused unless every address it resolves to is a loopback address. `--allow-remote-forward`
permits another host over HTTPS only, because every request carries the subscription's verification
token and a valid signature; plain HTTP still reaches only loopback addresses. Credentials and
fragments in the URL are refused. Output is one line per delivery (time, event id, retry number, the
bot's status and duration, and the state Hue recorded), never a body, a signature or a credential;
credentials in error messages are replaced with `[redacted]`.

Ctrl+C or `SIGTERM` stops pulling (a waiting pull is cancelled), finishes the deliveries in flight
and acknowledges them, then exits `0`, no sooner than a second after the first Ctrl+C. A second
Ctrl+C a second or more after the first abandons the forwards and acknowledgements still in flight
and exits `130`; one within a second of the first, such as the copy `npx` forwards to the command,
is the same stop. Nothing is acknowledged before the bot answered or its window closed; a delivery
left unacknowledged is left to its lease. Network errors, `429`, `5xx`, an unreadable pull answer
and another open pull for the same subscription (a second `hue listen`) are retried with backoff up
to 30 seconds; a `Retry-After` can lengthen a wait to at most 60 seconds, never shorten it. Exit
codes: `0` stopped, `1` Hue refused the credential, the subscription (unknown, revoked, or one that
delivers to a request URL) or the pull itself (a redirect, another refusal or an answer without
deliveries), `2` usage error, `130` interrupted twice.

## Import traces from Langfuse

`hue import langfuse` copies a Langfuse project's traces into Hue, for a team moving from Langfuse.
It runs on your machine: it reads Langfuse's public API with the project's own keys and sends the
spans with your Hue project key through the SDK's exporter, so the Langfuse keys go only to Langfuse
and Hue never receives or stores them. The command is part of the `hue` executable and runs with
`npx` whatever language the application is written in; the Python SDK has no counterpart.

```sh
# .env.langfuse, kept out of version control:
#   LANGFUSE_PUBLIC_KEY=pk-lf-...
#   LANGFUSE_SECRET_KEY=sk-lf-...
#   LANGFUSE_BASE_URL=https://cloud.langfuse.com
npx -y @hue-run/sdk@0.25.0 import langfuse --env-path .env.langfuse --from 2026-01-01 --dry-run
npx -y @hue-run/sdk@0.25.0 import langfuse --env-path .env.langfuse --from 2026-01-01 --media
```

`LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` come from the environment or `--env-path`
(`--env-file` also works when the file exists), loaded first; a variable already set keeps its
value. `--langfuse-public-key` replaces the public key on the command line, but the secret key is
never taken from it, where other local processes and shell history can read it. The host is
`--langfuse-host`, then `LANGFUSE_BASE_URL`, then `LANGFUSE_HOST`, then `https://cloud.langfuse.com`:
use your region's host or your self-hosted URL, over HTTPS (plain HTTP only on this machine). A
request carrying the keys follows no redirect. `HUE_API_KEY` is the Hue project key the spans are
sent with, from the environment, the env file, or `./.env.hue` (where `hue login` stores it) when
neither sets it (a dry run, which needs no Hue key, reads no `./.env.hue` beside a named file); `--origin` (default `HUE_BASE_URL`, then `https://app.hue.run`) is checked with
`GET /api/v1/projects/current` before Langfuse is read. Keys are never printed.

**What is read.** The command first asks for `GET /api/public/v2/observations`, which Langfuse Cloud
and self-hosted Langfuse v4 answer. The traces are then the root observations
(`isRootObservation=true`) that started in the window, listed newest first in cursor pages, and each
trace's observations are read 100 a page with the field groups
`core,basic,time,io,metadata,model,usage,prompt,trace_context`; a page whose metadata values Langfuse
cut at 200 characters is read again with those keys expanded. A deployment that answers `404` there
(self-hosted Langfuse v3) is read through `GET /api/public/traces` (`fromTimestamp`, `toTimestamp`,
`orderBy=timestamp.desc`, `fields=core,io`) and `GET /api/public/observations?traceId=…`, in numbered
pages. An answer over 32 MiB, or a `413`, is asked for again in smaller pages.

**Selection.** `--from` and `--to` take an ISO 8601 date (midnight UTC) or a date and time with a time
zone. A trace is selected by when it started, its root observation's start time or a v1 trace's
timestamp, `--from` inclusive and `--to` exclusive. Without `--to` the window ends an hour before the
command starts, so a trace still running, or still arriving in Langfuse, is left for a later run
rather than sent half recorded. `--limit N` imports the N
newest traces; `--trace-id ID` (repeatable, up to 1,000) imports those traces only and is not combined
with the window or the limit.

**What Hue receives.** Each observation becomes a completed span as a Langfuse OpenTelemetry SDK
records it: its name, start, end (an observation without an end lasts no time) and parent, with
`langfuse.observation.type` (lower case), `langfuse.observation.input` and `.output` (a string as
recorded, any other value as its JSON), one `langfuse.observation.metadata.<key>` per metadata key,
`.level`, `.status_message`, `.model.name`, `.model.parameters`, `.usage_details`, `.cost_details`,
`.completion_start_time`, `.prompt.name` and `.prompt.version`, and the trace's
`langfuse.trace.name`, `langfuse.trace.tags`, `langfuse.user.id`, `langfuse.session.id`,
`langfuse.release`, `langfuse.version` and `langfuse.environment`. The model is also
`gen_ai.request.model`, and Langfuse's `input` and `output` usage counts are
`gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens`. An observation at level `ERROR` is an
error span with its status message. A v1 trace is also a span of its own, named as the trace and
carrying `langfuse.trace.input`, `.output`, `.metadata.<key>`, `.tags` and `.public`; its observations
without a parent are its children, and it lasts from the earliest of its timestamp and their starts
to their last end. Spans carry `service.name` `langfuse` (`--service-name` sets another) and the
instrumentation scope `@hue-run/sdk/import/langfuse`.

**Environment and Worlds.** A span whose observation, or v1 trace, records an environment also
carries it as recorded in `hue.import.source_environment`, which marks the trace as imported; one
that records none carries neither attribute, and the resource never declares
`deployment.environment.name`, since one import can mix environments. Ended traces with a resolved
user can contribute to that user's World with any environment value or without an environment
declaration. Traces linked to Hue runs, World instances, or run executions never contribute.
Hue's evaluation and simulation evidence and deliberately excluded traces also stay excluded.

**Ids and resuming.** A Langfuse id that already is an OpenTelemetry id (32 lowercase hex digits for
a trace, 16 for an observation, as Langfuse's OpenTelemetry SDKs write them) is kept; any other id,
such as an older SDK's UUID, becomes one derived from it with SHA-256. The original ids are kept as
`langfuse.trace.id` and `langfuse.observation.id`. Running the same command again sends the same
spans, and Hue keeps one copy of an exact replay of a completed span, so an interrupted or partly
failed import is resumed by running it again. Hue refuses a different payload for a span it already
holds: keep `--media`, `--no-content`, `--service-name` and the SDK version the same when
resuming, and expect a span whose Langfuse data changed after it was imported to be refused. For
the same reason the import sends nothing that depends on the run: a trace's root never carries
`hue.sdk.dropped_records`, and files and large values are stored before their span is sent. Leave
out of the window any traces that already reached Hue through OpenTelemetry.

**Export and content.** Spans go through the SDK's own exporter, as `createHue` sends them: batched,
compressed, retried and within the limits Hue advertises. Before a span is sent, its content is
stored as that exporter stores it, with the exporter's own placement: a file inline in an attribute
Hue reads files from (a `data:` URL, or the bytes of a provider part, that Langfuse kept in place) is
uploaded and placed in its digest form, and a text value still over Hue's inline limit (1 MiB) is
uploaded whole and replaced by its first 16 KiB, each listed in `hue.blobs` (a whole value also in
`hue.truncated`). Doing this first means a file or value that cannot be stored right now holds its
span back for the next run instead of being kept inline or cut; one over a limit (Hue's size limit,
or a span's 64 entries) is placed the same way on every run and counted in the summary. Content is
captured, the SDK's default; `--no-content` sends metadata only, as `captureContent: false` does (no
inputs, outputs, status messages or model parameters; metadata, model names and usage stay, and
nothing is uploaded). The import waits for its queue to be sent every 1,024 spans or 32 MiB, so its
memory stays bounded whatever the project's size.

**Media.** Langfuse's SDKs replace a file in an input, output or metadata value with a reference,
`@@@langfuseMedia:type=<media type>|id=<id>|source=<source>@@@`. Without `--media`, references are
sent as recorded, and Hue shows them as files held in Langfuse. With `--media`, each reference where
Hue reads a file (a whole string, or the content of a provider part such as an OpenAI `image_url` or
`input_audio`, an Anthropic `source` or a GenAI `blob`, no deeper than ten levels) is looked up with
`GET /api/public/media/{id}`. The file is downloaded from the link Langfuse answers (following up to
five of its store's redirects, without the Langfuse keys). The link and each redirect must use HTTPS
without credentials or a fragment and reach a public address, or the Langfuse host itself; a link to
this machine, a private network or a link-local address such as cloud metadata fails the file. When
the Langfuse host is on this machine, any address is accepted, and plain HTTP to this machine. The
file is then uploaded under the span's trace through Hue's upload route (reservation, presigned
`PUT`, completion), and placed in the digest form the SDK writes for media it records: a whole string
becomes `{"type":"blob","mime_type":…,"modality":…,"sha256":…,"size":…}` and a provider part loses its
bytes and gains `sha256` and `size`, every other byte of the value's text kept, each file listed in
`hue.blobs` under `<attribute>#<JSON pointer>`. Each file is downloaded once per trace. A reference
stays as recorded when Langfuse holds no bytes for it, its file is over 25 MiB, it sits inside longer
text, or its span already lists 64 files. A file that cannot be downloaded or stored right now holds
its span back: the trace is reported, and the next run sends it.

**Rate limits and failures.** A `429` from Langfuse is waited out for as long as its `Retry-After`
asks, up to 15 minutes and ten times in a row; connection failures, timeouts and `5xx` answers are
retried after 1, 2, 4, 8 and 16 seconds. Langfuse Cloud limits each organization's requests per
minute by plan, so a large project imports at that pace: a request per page of traces and per page
of each trace's observations, and one per media file. A refusal of the Langfuse keys (`401` or `403`)
or of `HUE_API_KEY` stops the import before anything is sent; a trace Langfuse cannot answer for is
reported and the import goes on.

**Output and exit codes.** `--dry-run` reads and counts traces, spans and media references, needs no
Hue key and sends nothing. Without `--yes` the command asks for confirmation in a terminal (declining
exits `1`) and refuses to start without one. Progress is printed every 100 traces or 10 seconds, then
a summary of the traces imported, the spans sent and accepted, and the media files uploaded and left
in Langfuse; each trace not fully imported is named with the reason. Ctrl+C or `SIGTERM` stops
reading, sends what was read and exits `130`; a second Ctrl+C a second or more later exits `130` at
once, abandoning exports still in flight for the next run to send. Exit codes: `0` every selected
trace was imported, `1` a trace, span or file was not (or a key was refused), `2` usage error, `130`
stopped.

## Import a bundle of existing traces

`hue traces import` brings historical traces into Hue from exports you already hold: OpenTelemetry
exports (OTLP/JSON, binary OTLP and OpenTelemetry Collector files, Jaeger, Zipkin), the exports of
LLM observability tools (Langfuse, Braintrust, LangSmith, Arize Phoenix, MLflow, Opik, W&B Weave,
Datadog LLM Observability, Helicone, Raindrop events and spans), OpenAI Agents SDK traces, ATIF trajectories and
plain chat transcripts. It needs no project key. `prepare` runs on the machine that holds the
exports and sends nothing; a Hue MCP connection then authorizes the delivery
(`prepare_trace_import`); `upload` delivers the bundle with that authorization, and
`get_trace_import` reports what arrived.

```sh
npx -y @hue-run/sdk@latest traces import prepare ./exports --out ./exports.hue-import --json
npx -y @hue-run/sdk@latest traces import upload ./exports.hue-import --authorization-file ./authorization.json --json
```

**Prepare.** `prepare <path>` reads a file, a directory tree or a ZIP archive (members are inflated
in memory; encrypted members, unsafe paths and nested archives are listed, not read) and
recognizes each file by its content, never by its name. A file may be gzip (every member) or zstd
(every frame, skippable frames passed over; zstd needs Node.js 22.15 or later) compressed, at most
64 MiB decompressed, and hold one JSON document, a JSON array of records, JSON Lines or binary OTLP,
as UTF-8 or as UTF-16 after a byte order mark. Each line of JSON Lines, each record of a JSON array
that no format reads whole, and each message of a length-prefixed protobuf file is recognized on
its own. CSV and Parquet are not read: export JSON or JSON Lines.

Damage stays local. A gzip or zstd file that breaks off, or holds bytes after its last member or
frame, is read up to the break and the rest named in `files.notes`, as is a zstd message of a
length-prefixed protobuf file with bytes after its last frame; one whose content fails its
checksum or the size its member or frame declares is not read. A line that is not UTF-8 is named and
the other lines read. A bare `NaN`, `Infinity` or `-Infinity` (Python's `json.dumps` writes them) is
read as null and named in `files.notes`. A value nested more than 512 levels deep is named and not
read, and JSON text inside a record (metadata, tool arguments) nested that deep is kept as the text
it is. Past 1,000 records in a row from the start of a JSON array that no format reads, the array is
reported as unrecognized without reading the rest.

Every trace becomes gzip OTLP/JSON batches of at most 3 MiB decoded and 900 KiB on the wire,
written to `--out` (default `<path>.hue-import`, created with mode 0700) beside `manifest.json`,
which declares each trace's id, span count, batches (by the SHA-256 of each gzip body), large
values, history owner and origin. A text value over 1 MiB is stored as a value of its own and
listed in `hue.blobs`, as the exporter lists the values it uploads. A span that no batch can hold,
though each of its values is under 1 MiB, has its largest text values stored the same way until a
batch can, its source record last. Nothing about where a file sat or what it was called reaches a
span: a renamed, reordered or re-zipped copy of the bundle prepares to byte-identical batches and
the same manifest digest.

**Formats.** Each value is read by the first format whose rule it matches, in the order
`hue traces --help` lists them; each rule asks for keys the other formats' records lack. The format
id is the key of the report's `formats`, and every span converted from a source record carries it
as `hue.import.format`; spans kept as recorded and spans of the documented Langfuse list carry
none. The last column is where the format finds the trace's end user (written as `user.id`) and
conversation (`gen_ai.conversation.id`); a tool span, tool row or tool call never names either.

| Format id | Source | Recognized by | User and conversation |
| --- | --- | --- | --- |
| `otlp_json` | OTLP/JSON trace export: one document, a list of them, or one per line | a `resourceSpans` (or `resource_spans`) list | the spans' own attributes, read as Hue reads them |
| `otlp_protobuf` | Binary OTLP: one protobuf `ExportTraceServiceRequest` (an OTLP/HTTP body, a `.pb` or `.binpb` file), or Collector file exporter output (`format: proto`, or `compression: zstd` around protobuf or JSON) | content that decodes as an OTLP trace request, or as messages each prefixed with its 4-byte big-endian length | the spans' own attributes |
| `jaeger_api_v3` | Jaeger API v3 answer and NDJSON stream | `{"result": {"resourceSpans": …}}` (or `result.spans`), the stream's `{"end": true}` and `{"error": {"httpCode": …}}` lines | the spans' own attributes |
| `jaeger` | Jaeger `/api/traces` answer, the UI's trace download, one trace, or a span with its process | a trace's `spans` holding a span with `spanID`, `operationName` and `startTime` | span tags, kept as attributes |
| `zipkin` | Zipkin v2 JSON: a list of spans, a list of such lists, one span per line, or one span | hex `traceId` and `id` with a field only a span records (`timestamp`, `duration`, `localEndpoint`, `kind`, `annotations`, `tags`), and none of `type`, `startTime`, `spanId`, `traceID`, `span_id` | span tags, kept as attributes |
| `phoenix_otlp` | Arize Phoenix `GET /v1/projects/{project}/spans/otlpv1`, or one such span per line | `trace_id`, `span_id` and `start_time_unix_nano` or `end_time_unix_nano`, without `context` or `root_span_id` | the spans' attributes, OpenInference `user.id` and `session.id` among them |
| `phoenix_spans` | Arize Phoenix `GET /v1/projects/{project}/spans` | `context.trace_id`, `context.span_id` and `start_time` or `span_kind` | the spans' attributes, OpenInference `user.id` and `session.id` among them |
| `datadog_llmobs` | Datadog LLM Observability export API answer, one span, or one per line | `"type": "span"` with `attributes.span_id` and `attributes.trace_id` | the `user_id`, `user.id` or `usr.id` tag, or `user_id` in `metadata`; `session_id` |
| `langfuse_observations` | The Langfuse observation list Hue documents | a `data` or `observations` list whose every record is an observation (`id`, `traceId`, `type`, `startTime`) without `projectId` | the observations' `userId` and `sessionId`, as `langfuse.user.id` and `langfuse.session.id` |
| `langfuse` | Everything Langfuse writes: `GET /api/public/traces/{id}`, v1 trace and observation pages, Observations API v2 pages, `GET /api/public/sessions/{id}`, UI downloads of the traces, observations and events tables, blob-storage files of the `traces`, `observations` and `observations_v2` tables | a trace (`id`, `timestamp`, `bookmarked`, `public`), an observation (`id`, `type`, `startTime`, `traceId`) or a blob-storage observation row (`start_time`, `trace_id`, `parent_observation_id`), alone or in `data`, `observations` or `traces` | the trace's `userId` and `sessionId`, else each observation's |
| `atif` | ATIF v1.7 and v1.8 exports, embedded subagents included | `schema_version` starting with `ATIF-` | `extra.user_id`; the run's `session_id` |
| `braintrust` | Braintrust span rows: a UI download, the fetch or query API's answer, `bt sync pull` JSON Lines or a cloud-storage export | `span_id` and `root_span_id`, alone or in `events` or `data` | `metadata` (`userId`, `user_id`; `session_id`, `thread_id`, `conversation_id`, …), Mastra's `resourceId`, an OpenAI Agents row's `group_id` |
| `langsmith_runs` | LangSmith runs: a `list_runs` dump, the runs query page or its v2 page, a run with its `child_runs`, bulk-export rows converted from Parquet to JSON Lines | `id`, a LangSmith `run_type` (`chain`, `llm`, `tool`, `embedding`, `retriever`, `prompt`, `parser`) and `start_time` or `dotted_order`, alone or in `runs` or `items` | run metadata (`userId`, `user_id`; `thread_id`, `session_id`, `conversation_id`, …) and the v2 `thread_id`; never the run's own `session_id` (the tracing project) or `ls_user_id` |
| `mlflow_traces` | MLflow `Trace.to_dict()` (`mlflow traces get`, `trace.to_json()`), a list or JSON Lines of them, `mlflow traces search --output json`, MLflow 2's form included | `info` with `trace_id` or `request_id`, and `data.spans`, alone or in `traces` | `mlflow.trace.user` and `mlflow.trace.session` metadata, else a span's `user.id` and `session.id`; never `mlflow.user` |
| `opik_traces` | The files `opik export … project …` writes, or spans alone (the spans API page or JSON Lines) | `trace` (with `id` and `start_time`) beside `spans`; or a span with `id`, `trace_id`, an Opik `type` (`general`, `tool`, `llm`, `guardrail`) and `start_time`, alone or in `content` | metadata (`userId`, `user_id`, …); the trace's `thread_id`, else its metadata's; never `created_by` |
| `weave_calls` | W&B Weave calls: the calls stream's JSON Lines, a list of calls, `{"calls": […]}` or `{"call": …}` | `id`, `trace_id`, `op_name` and `started_at` | `attributes` (`userId`, `user_id`, …); `thread_id`, else in `attributes`; never `wb_user_id` |
| `openai_agents` | OpenAI Agents SDK `Trace.export()` and `Span.export()` records, one per line or in a list, or the `{"data": […]}` body its exporter posts | `"object": "trace"` with `id`, or `"object": "trace.span"` with `trace_id` | the trace metadata's `userId` (or `user_id`); `group_id`, else a conversation field of the metadata |
| `raindrop` | Raindrop events: elements of a `POST /v1/events/track` payload, or a Query API `GET /v1/events` answer | `event` with `ai_data` (or with `event_id` and `user_id`), or `event_name` with `user_input` and `assistant_output`, alone or in `data` | `user_id`; `convo_id` |
| `raindrop_spans` | Raindrop's span rows: a Query API `GET /v1/traces?event_id=` answer, one row, or one per line | `trace_id`, `span_id`, `span_name`, `start_time_ns` and a Raindrop `span_type` (`INTERNAL`, `LLM_GENERATION`, `LLM_GENERATION_STREAM`, `TOOL_CALL`), alone or in `data` | the association attributes Raindrop's SDKs stamp on every span (`traceloop.association.properties.user_id` and `convo_id`, `ai.telemetry.metadata.raindrop.*`); the rows name no event, so `--user-key` names a user they lack |
| `helicone` | Helicone requests: `npx @helicone/export` JSON or JSON Lines (`--include-body` for the bodies), or the `query-clickhouse` API answer | `request_id` and `request_created_at` with `response_status`, `request_user_id` or `request_properties`, alone or in `data` | `request_user_id`, never `helicone_user` (the Helicone account); the `Helicone-Session-Id` property |
| `openai_chat` | An OpenAI Chat Completions request, or a line of a chat JSONL file (a fine-tuning or eval dataset) | a `messages` list holding a `{role}` message, without `object` and without anything only Anthropic sends | `safety_identifier`, else `user` |
| `openai_responses` | An OpenAI Responses `response` object, a request (with its `output` when it was logged with it), or a bare list of input and output items | `"object": "response"` with an `output` list; a value of request fields only, with text or a list of items and messages as `input`; or a list of Responses items | `safety_identifier`, else `user`; `conversation` |
| `anthropic_messages` | An Anthropic Messages request or response | a response (`"type": "message"`, `"role": "assistant"`, `content`, `model`), or a `messages` request carrying something only Anthropic sends (`system`, `anthropic_version`, `stop_sequences`, an `input_schema` tool, a `tool_use` or other Anthropic content block) and nothing only OpenAI sends | `metadata.user_id` |

**How each kind of format is converted.** OTLP/JSON, binary OTLP and Jaeger API v3 spans are kept
exactly as recorded, and the spans of one trace split between files of these formats are read as
one trace. A span that two files hold is read once when the copies differ only in encoding: key
order, an int64 or a uint32 as a number or decimal text, an enum by name or number, a double as a
number or text, bytes or an id as hex or as standard or URL-safe base64, padded or not, or a field
at its default written or left out, and the user and conversation are read alike from either
copy, as Hue reads them. A trace or span id that is not an OpenTelemetry id (an exporter's UUID,
for example) is mapped to one derived from it by SHA-256, with the original kept as
`hue.import.original_trace_id` or `hue.import.original_span_id`. Base64 without its padding is
read as the id it encodes only as an encoder writes the id's bytes, and its text is kept the same
way, since a vendor's own id of that length (a 22-character short UUID) can read as base64 too.

- Jaeger UI JSON, Zipkin v2 and Phoenix spans are written as the OTLP spans they were, as the
  OpenTelemetry Collector converts Jaeger and Zipkin spans. Attributes keep their own names
  (Phoenix's OpenInference attributes among them). The process or local endpoint is the resource.
  The kind, status, scope, events and links come from the tags, references and annotations Jaeger
  and Zipkin write them as, and the source span is kept whole as `hue.import.source_record`. A
  64-bit Jaeger or Zipkin trace id is zero-padded to 128 bits as the Collector pads it, the
  original kept, and a Zipkin server span that shares its client's id becomes the client's child
  under an id derived from it.
- A Langfuse observation of the documented list becomes one span keeping its whole record
  (`hue.import.source_record`) beside the `langfuse.*` and GenAI attributes Hue reads; an id that
  is no OpenTelemetry id is mapped as `hue import langfuse` maps it, so an export and a live import
  of the same trace agree.
- An ATIF export becomes one trace: an agent span for the run (`invoke_agent <agent.name>`), a
  model span per agent step with the conversation so far, a tool span per call, and each embedded
  subagent as its own agent span under the call that spawned it, under the instrumentation scope
  `hue.import.atif`. ATIF records instants, not durations, so model and tool spans are points in
  time, and a tool's result is kept as text with no error status of the importer's making.
- Every other format is read as rows: each record becomes one span of its trace, written by one
  emitter under the GenAI conventions Hue reads. A model call carries `gen_ai.operation.name`
  `chat`, its model, provider, messages and token usage; a tool call `execute_tool` with the tool's
  name, call id, arguments and result; an agent `invoke_agent`. Chat content in the common shapes
  (OpenAI chat messages and choices, OpenAI Responses items, Anthropic content blocks, LangChain
  messages, plain strings) becomes GenAI message parts; any other content is kept as `input.value`
  and `output.value`. An error is an error status with its message. The trace's user and
  conversation go on its root spans (never a tool's), and each span keeps its whole source record
  as `hue.import.source_record`. An attribute the source recorded under its own name (a Raindrop
  span's `gen_ai.*`, for example) is kept as recorded, with none of the same name added beside it,
  unless it names a user or conversation that `--user-key` or `--session-key` replaces.
- A chat transcript (`openai_chat`, `openai_responses`, `anthropic_messages`) is one trace: an
  agent span for the conversation, a model span per assistant turn with the conversation before
  it, and a tool span per call with the result that answers it. The agent's reply is the answer
  logged with the request, else the last turn when the conversation ends with it; a conversation
  that goes on past its last turn, as a request logged without its response does, is the agent's
  input whole and has no reply, as is a Responses request logged with an empty `output`.
- A vendor's own evaluation recorded inside a production trace is read as such, not as the
  agent's work: a Braintrust span with `purpose: "scorer"` or of type `score`, `automation`,
  `facet`, `classifier`, `preprocessor` or `review` (online scoring adds them to production
  traces), and a Langfuse `EVALUATOR` observation. That span and everything beneath it (a judge's
  model call) carry no GenAI operation, model, messages, tool call or usage, their content kept as
  `input.value` and `output.value`, and never name the trace's user or conversation, as a tool's
  subtree never does. The trace's origin is unchanged.

Rules shared by the row formats:

- Ids: a vendor's 32-hex trace id and 16-hex span id are kept (MLflow's base64 ids are read as the
  hex they encode); any other id is mapped by SHA-256, the original kept as
  `hue.import.original_trace_id` or `hue.import.original_span_id`. A parent
  the export does not hold leaves the span a root of its trace, the original kept as
  `hue.import.original_parent_span_id`. A Raindrop event without an `event_id` and a transcript
  without an id of its own are named by the SHA-256 of the record's canonical JSON, so the same
  record in two files is one trace.
- Copies: a record exported more than once keeps its latest copy, by the field the format records
  it in (Braintrust's `_xact_id`, Langfuse's `updatedAt`, Opik's `last_updated_at`, Helicone's
  `updated_at`, the ended copy of a LangSmith run, a Weave call, an OpenAI Agents span or a
  Raindrop event). Copies of a span with no such field must agree, or the trace is refused; an
  MLflow trace's `info`, which a later export may extend, is not compared, and one export's is
  kept, the same whichever file is read first. A record identical to one read elsewhere (a
  repeated line of a chat JSONL file, an overlap of two exports) is read once, and the value that
  added nothing new is named in `files.notes`. When the later file's MLflow `info` is the one kept,
  its note ends `read once from this copy`.
- Token counts follow the GenAI conventions: input includes cached input and output includes
  reasoning, with the cached, cache-write and reasoning counts also kept on their own. Helicone
  stores `prompt_tokens` without `prompt_cache_read_tokens` and `prompt_cache_write_tokens`, and
  `completion_tokens` without `reasoning_tokens`, so those are added back. LangSmith's cache writes
  are read under `cache_creation`, the v2 API's `cache_write`, or the sum of
  `ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens` that its Anthropic wrapper records.
- Kinds a source recorded late: Weave records an op's kind (`attributes.weave.kind`) since January
  2026; an earlier call from an op Weave's integrations patch (`openai.chat.completions.create`,
  `anthropic.Messages.create`, `litellm.completion` and the rest of its model-call ops; MCP
  `call_tool` and CrewAI tools) is read as the kind those integrations give it now.
- Links: an MLflow span's `links` become span links, to a span of its own trace or of another.
- Origin: Braintrust experiment rows and dataset records (`dataset_id`), LangSmith runs with a
  `reference_example_id`, MLflow traces tagged `mlflow.eval.requestId` or
  `mlflow.trace.sourceScorer`, Opik traces from an experiment, evaluator, optimization or the
  playground, Weave traces with an `Evaluation.*` op or a scorer as their root (a scorer applied
  inside the application's own op, a guardrail, is a span of its production trace), Datadog
  `experiment` spans and every span ddtrace tags with an `experiment_id`, Helicone requests of an
  experiment or a Helicone evaluator (the `Helicone-Experiment-Id` or `Helicone-Evaluator`
  property, matched without regard to case), and Langfuse's `sdk-experiment` and `langfuse-…`
  environments (in both Langfuse formats) are declared evaluation traffic.
- Instants: Datadog's `start_ns` and `duration` are nanoseconds, and a `start_ns` too small to be
  nanoseconds is read as milliseconds or microseconds by its size, the span's `duration` in the
  same unit (`start_ns_read_as_ms` and `duration_read_as_ms`, or the `_us` pair). An ISO instant without a zone (LangSmith, Langfuse's ClickHouse
  `YYYY-MM-DD HH:MM:SS.ffffff`) is UTC. Where a source records no instant, a fixed rule fills it
  in, names it on the span (`hue.import.timing`) and counts it in the report (`traces.timing`):
  - a span without a start starts at its end (`start_at_end`), else with its parent
    (`start_from_parent`), else with the trace's earliest instant (`start_from_trace`);
  - a span without an end ends with its last child (`end_from_children`), else at its start
    (`end_at_start`);
  - a trace that records no instant at all is placed at 2000-01-01T00:00:00Z, a millisecond per
    record in source order (`untimed_trace`); plain transcripts record none except a Responses
    object's `created_at`;
  - a format that takes an instant from another field names that too: Braintrust's `created`
    (`start_from_created`), a LangSmith run's `dotted_order` (`start_from_dotted_order`), a
    Helicone request's `delay_ms` (`end_from_latency`) and a Raindrop span's `duration_ns`
    (`end_from_duration`);
  - an event recorded without a time (a Braintrust log row, an MLflow span event) is placed at its
    span's start (`event_at_span_start`).

  The same rules fill in the instants a Zipkin or Phoenix span was exported without.

**History owner.** A trace's owner is read from its spans as Hue reads it: the trace's local roots
(spans with no parent, or one outside the trace) first, then its other spans, never a tool span (a
span any instrumentation convention Hue reads takes as a tool call) or anything beneath one, and
every span that names one must agree. An explicit `hue.world.entity.namespace` and
`hue.world.entity.id` wins over a user. A user is the first of `user.id`, `enduser.id` and the other
attributes and metadata fields Hue reads (OpenTelemetry, Vercel AI SDK, OpenLLMetry, Langfuse,
LangSmith, Braintrust, Mastra and OpenInference metadata), except that `user.id` beside
`user.account_uuid` names a Claude Code installation and is passed over. The conversation the
manifest declares is the one Hue's trace list shows: that of the trace's root span (the earliest
span with no parent; without one, the only span whose parent is outside the trace, when that span
runs an agent or a workflow), else that of the earliest span that names one, spans ordered by
their start in milliseconds, then by span id. The manifest declares none when that span is a tool
span or beneath one, or when Hue does not show the id as it is: one longer than 2,048 bytes of
UTF-8, or holding a NUL or an unpaired surrogate.

**`--user-key` and `--session-key`.** For an export whose user sits under a key of its own,
`--user-key <key>` names it, and `--session-key <key>` names the conversation the same way. The key
is one of:

- a dotted key such as `app.customer_id`, looked up as an attribute of each span or its resource,
  then in the record's metadata (the exact key, then as a dotted path), then in the record itself
  (for MLflow: a span's own attributes, then the trace's metadata, then its tags; the record of an
  MLflow trace's root span holds the trace's `info` beside the span);
- a JSONPath of members and indexes into the source record: `$.metadata.customer.id`,
  `$.metadata["customer.id"]` or `$.tags[0]`;
- a JSON Pointer into the source record: `/metadata/customer/id`.

The key is read on the agent's spans as the owner is: the roots' value when they name one, else the
other spans', never a tool span's, and spans that disagree name nobody. For a row format (the
`langfuse` format among them) the key's value is written as the root's `user.id` (`enduser.id` on a
root that records `user.account_uuid`) or `gen_ai.conversation.id` in place of the one the record
names, and no span keeps an attribute it recorded, nor its resource a user attribute, that Hue
would read another user (or conversation) from, so the trace names the key's value, or nobody when
its spans disagree. A trace kept as recorded or converted span for span (OTLP, Jaeger, Zipkin,
Phoenix, the documented Langfuse list, ATIF) that names no owner gains one child span of the
agent's earliest local root (never a tool span), `hue.import.user` with the single attribute
`user.id` (or `hue.import.session` with `gen_ai.conversation.id`), so its recorded spans keep their
bytes and a trace also sent live does not conflict. `hue.import.session` starts before any tool
span that names a conversation, so that Hue's trace list shows the key's. An owner or a
conversation the agent's spans already name is kept, and a trace with no root but tool spans gains
nothing.

**Limits and refusals.** A malformed record refuses its trace, never the file: an OTLP trace with a
malformed span (an attribute value of no OTLP shape, a protobuf span that does not decode) or whose
parents close on themselves is refused rather than imported without it, and the request's other
traces are read. A page of the documented Langfuse list holding an integer too large to represent
exactly refuses only the traces of the observations that hold one. The same trace in two files is
one trace when the copies agree and a refusal when they differ. A trace with more than 100,000
spans, 512 batches or 10,000 values is refused and named, as is a transcript whose turns together
repeat more than 64 MiB of conversation (each turn's model span holds the conversation before it).
An input of more than 25,000 traces, more than 256 MiB decompressed (every trace is held until all
are read; prepare a larger export in parts, each to its own `--out`), or whose manifest would exceed
32 MiB (4 MiB compressed), is refused whole. The messages of one length-prefixed protobuf file share
the 64 MiB a file may decompress to. Each zstd frame counts at least 128 bytes against these bounds,
as does each member of a damaged gzip file, which is read member by member, and a zstd frame that
does not decompress counts at least 1 MiB: 524,288 tiny frames fill one file's bound, and 256
damaged zstd files the input's. A file over its bound counts more than that bound against the
input's, so four such files refuse the input. Each refusal says whether content decompresses past
the bound or its frames count past it; a file refused for its frames reads once decompressed.

**Report.** `prepare` reports what it read and what it could not, down to the line; `--json` prints
the report as one object:

- `manifest_digest`, `totals` (traces, batches, spans, blobs, bytes) and `source`, which
  `prepare_trace_import` takes as given;
- `formats`: the traces prepared per format id;
- `files.supported`: each file read, with its format and the traces it held;
- `files.unsupported`: each file of which nothing could be read, with the reason (not JSON, a JSON
  document of no recognized format, an OTLP logs or metrics export, an export page with no
  records, an encrypted or nested ZIP member);
- `files.skipped`: each line of JSON Lines (`line`), record of a JSON array (`record`) or message
  of a length-prefixed protobuf file (`line`) that could not be read, with the reason, in file
  order; the rest of the file is read, and past 100 in one file the rest are counted in one entry;
- `files.notes`: what was read with a repair or read once though the input held it more than once
  (a gzip or zstd file read up to a break, `NaN` read as null, a record identical to one read
  elsewhere), with its `line` or `record`; past 100 in one file the rest are counted;
- `traces.refused`: each trace or record refused, with its `file`, `line`, `record` and `trace_id`
  where known and the reason;
- `traces.timing`: the traces whose instants a rule supplied, per rule;
- `traces.without_identity`: the traces without a declared history owner, which import like any
  other trace and can contribute to a World if Hue resolves their owner from the imported records;
- `traces.by_origin`: the origin each source recorded (`production`, `evaluation`, `simulation` or
  `unknown`); evaluation and simulation traffic is imported and kept out of production history;
- `traces.remapped`: the traces and spans whose ids were mapped, their text kept as
  `hue.import.original_trace_id` and `hue.import.original_span_id`.

An existing `--out` directory is accepted only while it holds nothing but an earlier preparation
and no upload has started in it.

**Authorize.** Call `prepare_trace_import` over the Hue MCP with the report's `manifest_digest`,
`totals` and `source`. It answers the import id, `upload_url` and an `authorization` (`hue_it_` and
43 characters) valid for a day. Save its answer, or the authorization alone, in a private file
(mode 0600; never in a transcript, a message or a shell history). The same digest in the same
project is the same import: calling again renews the authorization for an interrupted upload and
revokes the earlier one.

**Upload.** `upload <directory> --authorization-file <file>` reads the authorization from the file
(its JSON answer, or the authorization on the first line and the `upload_url` on the second;
`--import-url` names the URL otherwise, and `--origin` refuses a URL on any other Hue origin),
never from the command line or the environment, and never prints it. It registers the manifest's
exact bytes, then, trace by trace in declared order and two requests at a time, reserves each large
value, sends it to the URL Hue answers and completes it, posts each batch with its SHA-256 in
`Hue-Import-Batch`, and reads the trace's receipt for every span id: a trace counts as verified only
when Hue confirms every span. It then reconciles and completes the import. Progress is written to
`progress.json` in the bundle as it goes; running the same command again resumes there, and what
Hue already holds is not sent twice (a batch sent again after a lost acknowledgement is taken as
duplicates). Connection failures, timeouts, `408`, `429` and `5xx` answers are retried after 1, 2,
4, 8, 16 and 30 seconds, waiting for `Retry-After`; after eight retries the command stops and the
next run resumes. Ctrl+C or `SIGTERM` finishes the requests in flight, saves progress and exits
`130`; a second signal stops at once.

**What Hue refuses.** Every refusal carries a fixed code, which the report names in `error.code`.
An expired or replaced authorization (`401`), a lapsed connection (`403` `authority_lapsed`) and an
expired import (`410`) stop the upload: call `prepare_trace_import` again with the same
`manifest_digest` and `totals`, write the new authorization to the file and run the same command.
A manifest whose digest or totals are not the import's (`409`), an authorization of another import
(`403`), an unknown import (`404`) and a canceled import (`410`) are final. A batch or value Hue
refuses for the trace's own sake (undeclared, another digest, another trace's records, fewer
finished spans than declared, a size or type the manifest did not declare), or a record Hue already
holds under the same id with other content, is a conflict: it is recorded, the trace is reported,
none of its later records are sent, and the same bytes are never sent again. An import Hue reports
already completed is done: the command exits `0` and points to `get_trace_import`.

**Output and exit codes.** Without `--json`, the command prints the registration, every hundredth
verified trace, each conflict and a summary. With `--json`, one progress object per line goes to
stderr and the report to stdout: the state (`completed`, `incomplete`, `stopped` or `failed`), the
traces verified and conflicted, the batches landed and values stored, Hue's own note and the traces
it still lists when completion was refused, the conflicts with their codes, and `next_action`. Exit
codes: `0` prepared or completed, `1` not completed (the report says what to do next), `2` usage
error, `130` stopped.

## Local state and conflicts

Before its first network write, setup creates a lowercase UUIDv4 and a 32-byte random installation
secret. They live with the current telemetry credential in `.hue/installation-<origin-hash>.json`.
The file is added to `.gitignore`, written atomically with mode `0600`, and scoped to this exact
project and Hue origin. A pending browser capability is stored only in
`.hue/claim-handoff-<origin-hash>.html`, also ignored and mode `0600`; `.hue` uses mode `0700`.
Setup rejects symlinks, unsafe paths, oversized or invalid state, custom files at its managed config
paths, and unexpected edits to files it previously managed. It preserves unrelated `.gitignore`,
manifests, lockfiles and project files.

Secret-free checkpoints remain in the operating system's per-user state directory and support
interruption/resume. Claim capabilities never enter checkpoints or public events. Credential retries are idempotent; a lost
credential response is recovered by asking for the same generation. `SETUP_CHANGED` triggers one
status refresh. `SETUP_REVOKED`, expired/purged installations, custom credential conflicts and
exhausted lifetime quota fail closed instead of silently replacing an installation or key.

Commands serialize all origins for one canonical project and reload current state under that lock.
Every invocation re-detects current manifests, managers and managed blocks before mutation. Normal
interruptions release the lock; after a forcible process kill, the owner must inspect the stale
non-secret lock under canonical `/tmp` on Linux/macOS
(`hue-setup-locks-<uid>/<sha256(canonical-project-root)>`) and remove only that lock after confirming
no setup command remains active. Its location does not depend on `TMPDIR`, `HOME` or state-directory
overrides; project aliases and different Hue origins share ownership. Other operating systems fail
closed for automatic setup. Setup never breaks an unexplained lock automatically or retries
business work.

Both setup credential generations use exactly
`^hue_setup_(live|test)_setup-([a-f0-9]{24})_([A-Za-z0-9_-]{43})$`, with `keyId` equal to
`setup-` plus the token's 24-character identifier, fixed kind `anonymous_trial`, and the sole
capability `setup_telemetry_write`.
Normal project credentials and unknown token shapes are refused in setup responses and private
managed state. These credentials authorize metadata-only OTLP at `/api/v1/otlp/v1/traces` and exact
content-free receipt verification at `/api/v1/setup/traces/{traceId}/receipt`. They do not authorize
generic project, receipt, evaluation, log or browsing APIs. The Python package version
pinned by setup can export with the setup
credential; the CLI verifies the dedicated setup receipt instead of Python's generic receipt helper.

Each command uses bounded timeouts and retries. Provisioning records at most five attempts per local
installation in an hour and makes at most two attempts in one invocation; the live service's stricter
per-network admission remains authoritative. Receipt polling honors the SDK's bounded deadline and
`Retry-After`. A missing or late receipt is reported as resumable and unverified, never as success.

The TypeScript event union is exported from `@hue-run/sdk/setup`; its JSON Schema is exported as
`@hue-run/sdk/setup-events.schema.json`. Event `run.*` names describe only CLI invocations, not Hue
Runs.

## Public machine events and actions

Events carry `contractVersion: 2`, a non-secret invocation ID, sequence and timestamp. The closed
event set is `run.started`, `project.detected`, `plan.ready`, `step.started`, `step.completed`,
`file.changed`, `diagnostic`, `privacy.notice`, `action.required`, `trial.created`,
`receipt.verified`, `claim.required`, `claim.completed`, `run.completed` and `run.failed`.

Event version 1 shipped in TypeScript `0.3.1` and `0.3.2`; its public claim URL, action set and receipt
step are incompatible with this flow. The v2 schema shipped in TypeScript `0.4.0` with identity
`https://hue.run/schemas/setup-events-v2.json`. Event version 2 is independent of Setup HTTP
`protocolVersion: 1` and the checkpoint format.

`privacy.notice` has only `privacyUrl`, `effectiveDate` and `securityUrl` beyond the event envelope,
with the literal values above. `receipt.verified` carries non-secret `receiptId`, `traceId` and
`source: "repository-http-boundary"`. It confirms the exercised application boundary and every
expected span, positive stored span count, empty missing IDs and absent input/output content.
It does not establish instrumentation of unexercised application paths. `claim.required` and
`claim.completed` carry only the non-secret `claimId`; neither contains a URL or capability.

The closed `action.required.action` set is:

| Action | Caller response |
| --- | --- |
| `claim-project` | Defer account linkage to the project owner. |
| `configure` | Resolve the reported availability or managed-configuration issue. |
| `select-project` | Select one supported application package explicitly with `--project`. |
| `integrate-application` | Resolve the reported unsupported or ambiguous integration safely. |
| `run-instrumented-request` | Inspect the prior attempt and missing evidence; do not automatically replay business work. |
| `open-claim-handoff` | Ask the owner to run `hue claim` in an interactive local terminal. |
| `restart-claim-handoff` | Ask the owner to explicitly run `hue claim --restart` if recovery is needed. |

A coding agent follows the non-secret message and optional command, reports unverified steps, and
leaves browser account linkage for the human. It must not read or copy the private handoff into a
transcript. `run.completed` with `action_required` is a successful pause, not proof that all setup
steps completed. `claim.completed` requires reconciliation and the retained evidence checks.

## Staging/live acceptance runner

Fern owns hosted acceptance and its private browser/inbox orchestration. SDK verification builds and
retains the exact tarball; it does not spend a live admission or claim hosted success. The Fern job
first accepts the reviewed PR archive, then after merge downloads the exact `publish=false` Release
SDK archive without repacking and repeats acceptance. It uses two persistent installations and at
most four provisioning admissions. Local compatibility fixtures do not spend hosted admissions.

The local/manual diagnostic runner accepts an already prepared supported application fixture. Its `--language`
scaffolding does not create such an application, and its human-output option does not allocate a PTY.
It records CLI outcomes, not independent original-handler span binding or server evidence. It always
exits nonzero: exit `2` means the diagnostic finished but acceptance remains unverified; malformed
events, private output and child failures also fail closed. Even a valid version-2 application receipt
event followed by `ready` cannot make this runner an acceptance gate. Do not use it to authorize a
release, count it as hosted acceptance, or suppress its exit code in a release gate:

```sh
node packages/sdk-typescript/scripts/verify-package.mjs --artifacts-dir .artifacts/typescript
# Set project to an existing supported fixture; use the same directory on resume.
project=/absolute/path/to/supported-fixture
node packages/sdk-typescript/scripts/verify-setup-live.mjs \
  --archive .artifacts/typescript/hue-run-sdk-0.25.0.tgz \
  --origin https://STAGING_ORIGIN \
  --project "$project" --command setup \
  --evidence .context/setup-staging-before-claim.json
```

After the approved backend is available, run `hue claim` from an interactive owner terminal to open
the private local handoff and finish the real browser claim, then reconcile the same project:

```sh
node packages/sdk-typescript/scripts/verify-setup-live.mjs \
  --archive .artifacts/typescript/hue-run-sdk-0.25.0.tgz \
  --origin https://STAGING_ORIGIN \
  --project "$project" --command claim \
  --evidence .context/setup-staging-after-claim.json
```

Repeat from an existing supported Flask/uv fixture when that diagnostic pass is budgeted. Evidence files explicitly
record `purpose: "diagnostic-only"`, `independentlyVerifiedApplication: false` and `accepted: false`,
with the archive hash, bounded event names and terminal outcome—never the claim capability, installation proof,
telemetry key, cookie, verification URL, project path or trace/span IDs. The runner installs and
executes the exact tarball; it does not establish hosted acceptance, registry publication or
production activation.

Hosted acceptance separately executes installed Express/npm, Express/Bun and Flask/uv fixture
coverage, with Agent JSONL and a real default-mode PTY. It independently verifies exact stored IDs,
the privacy disclosure, one handler invocation, verified-account adoption and owner transfer,
preserved project/data, replacement receipt access and old-key `401`. Browser orchestration opens
only the private local file and produces no secret-bearing screenshots, traces, logs or artifacts.
Publication under a candidate dist-tag, registry acceptance, production activation, promotion of
the same version to `latest`, and clean-project literal `@latest` smoke remain separate gates; see
[RELEASING.md](../../RELEASING.md).

## Evaluate an agent against a case

`hue eval` runs a developer's local agent against a published Hue case or a saved eval set
and prints Hue's verdicts. It is the command-line form of `runSimulation()` (one-shot) and
`runLocalAgent()` (worker): the agent, its prompts and its provider credentials stay in the local
process, Hue creates one isolated simulated world per case, and Hue-owned outcome checks grade
the sealed world. Hue never executes the agent. `HUE_API_KEY` must be a **Read and
write** project key (a **Read** or **Tracing only** key cannot read cases or create runs);
the CLI never prints it.

Run the agent's own start command with `--command`. `hue eval` spawns it once per case with the
world's environment (below) and `{"inputs", "config"}` on stdin, and stores its stdout as the
answer. The agent reaches each app through Hue's mirror with its own production client: the one
committed helper described in [Make your agent eval-ready](https://docs.hue.run/evaluations/eval-ready-agent)
reads `HUE_SIM_<SURFACE ID>_URL` and `HUE_WORLD_TOKEN` when `HUE_WORLD_TOKEN` is set, fails
closed when a needed variable is missing, and returns the production URL and credential
otherwise. Never hand the agent Hue-native tools (`context.tools`, `context.mcp`) or a tool its
production agent lacks. Pin the SDK, so the agent's repository gains no dependency:

```sh
npx -y @hue-run/sdk@0.25.0 eval --case "Refund an eligible charge" --command "node agent.js"
npx -y @hue-run/sdk@0.25.0 eval --case https://app.hue.run/projects/demo/scenarios/<id> --command "python agent.py" --timeout 120 --baseline <run id>
npx -y @hue-run/sdk@0.25.0 eval --set "Billing regressions" --scorer-version <id> --command "node agent.js" --save-version
npx -y @hue-run/sdk@0.25.0 eval --worker --command "node agent.js" --agent-key support-agent --revision <new-agent-revision>
```

One invocation creates one run holding every selected case; it prints the run URL
(`https://app.hue.run/runs/<id>`) once the run exists. Add `--check` to confirm the key, the
selection, the case kind and the agent first: it prints what the run would do and exits without
creating a run, a world or a checkpoint. An
unpinned `npx @hue-run/sdk` runs a local, possibly older, copy in a project that already
depends on it.

An adapter module is the in-process alternative for a TypeScript agent. It exports `default` or
`runMyAgent`; `context` is the SDK's `SimulationTargetContext` (`world`, `mcp`, `tools`, `config`,
`item`, `executionId`, `environmentRunId`, `files`, `outputDirectory`, `signal`; `world` carries
the provider mirror URLs, the world token, `env` and `mcpConfig` where Hue's simulation gateway
serves the world). An adapter runs inside `hue eval`'s own process, where `HUE_WORLD_TOKEN` and
`HUE_EXECUTION_ID` are not set, so a helper that reads the process environment would return
production values: throw when `context.world` is missing, then pass `context.world.env` as the
helper's environment argument or spawn the agent with `agentEnvironment(context.world)`. Never
set `process.env` yourself; with `--concurrency` above 1 that leaks one case's world into another.
When the case also pins input files, `files` holds verified copies of its agent-visible ones (see
[Evaluate a document eval set](#evaluate-a-document-eval-set)); return
`withFiles(output, files)` from `@hue-run/sdk/evals` to upload documents the agent produced:

```ts
// hue-agent.ts: erasable TypeScript only; Node.js 24 and Bun strip the types natively.
import type { JsonValue, SimulationTargetContext } from "@hue-run/sdk/evals";
import { runAgent } from "./src/agent.js"; // The application's existing entry point.

export default function runMyAgent(inputs: JsonValue, context: SimulationTargetContext) {
  if (!context.world) throw new Error("This case has no world handoff; refusing to run against the real app");
  // The agent's own app clients read the mirrors through the committed helper, given the
  // world's environment; never hand it context.tools or context.mcp. Pass context.signal for
  // cooperative cancellation.
  return runAgent({ inputs, config: context.config, env: context.world.env, signal: context.signal });
}
```

```sh
npx -y @hue-run/sdk@0.25.0 eval --case "Refund an eligible charge" ./hue-agent.ts --content
```

`--scenario` remains an alias for `--case` for existing scripts. Pass one selection flag.

The one-shot mode resolves the selection (`--case` by name, or by the ID or URL of the published
case or of the case conversion that published it, among the project's first 1,000 Scenarios;
`--set` by name, ID or URL with explicit `--scorer-version` pins; or `--dataset-version` with `--scorer-version`),
creates a fresh run from those immutable pins named `<agent key> @ <revision>` (a commit hash is
shortened to 7 characters)
(`--name` overrides), prints `Run: <url>` and `Experiment: <id>` as soon as the experiment exists,
one line per case event (world created, agent started, world sealed), then
`Waiting for Hue checks...` and a table with one row per case: boolean metrics as `PASS`/`FAIL`,
numbers as values, text and category metrics as-is, an overall result per case and a pass count.
Failing cases print the scorer explanation. An evaluator Hue records as not applicable to a case
(its outcome scoring has no outcome criteria or conversion rubric to grade there) shows `n/a` in
that case's columns and neither passes nor fails it, so in a mixed eval set a case is decided by
the evaluators that apply to it; the pass line counts the not-applicable results. A case that no
pinned evaluator applies to is an error that names what they need. A result of a pinned Hue judge
(an evaluator of kind `world_judge`) whose immutable version does not set `config.required: true`
and that Hue marks advisory is
shown in its column, marked `(advisory)`, but never decides a case or the exit code; the pass line
counts advisory failures as not counted, and a case only advisory results ran for is an error.
Applicable outcome evaluators and judge versions pinned with `config.required: true` need a
decision before a case can pass. A required result skipped without a decision is inconclusive;
missing results remain pending and evaluator errors remain errors. A recorded failure takes
precedence over an unavailable required evaluator. The Answer outcome evaluator uses its
required judge to decide answer-only cases. Any
other evaluator's result, an error, or a metric that carries `passed` is never advisory, whatever
its evidence says. A metric name that
several evaluators report, such as two judges' `verdict`, gets a column per evaluator, labelled
with the version's first eight characters. `--baseline <run id|url>` adds improvement,
regression and unchanged counts with per-case deltas. `--json` prints one JSON document
(`experimentId`, `runId`, `runUrl`, `complete`, `cases`, `totals`, optional `baseline`) on stdout
and sends progress to stderr; each case lists its not-applicable evaluator versions in
`notApplicable` and its advisory ones in `advisory`, and `totals.notApplicable` counts the
former; a case failed for its telemetry has `state: "error"`,
`passed: false` and
`telemetry: { code: "telemetry_not_accepted", issues: [{ signal, kind, status?, count }] }`. `--wait <seconds>` (default 300) bounds the verdict wait because
Hue-owned `world_outcome` checks are graded after the world seals. An experiment always covers
every case of the saved version; there is no case subset.

`hue eval` runs up to four cases at a time by default in one-shot and worker modes.
`--concurrency 1` runs cases serially. Any explicit `--concurrency` value from 1 to 100 takes precedence.
Each case keeps its own files, environment and checkpoint.

The CLI requests the run's pinned `llm_judge` evaluators by default after outputs upload,
before verdict polling, in direct, simulation and worker modes. `--no-judges` skips these requests;
`--judges` remains accepted for existing commands. Requests use Hue's hosted judge budget;
Hue applies its admission controls to new jobs. An accepted request remains replayable if the
budget is later disabled. Cases without stored output are excluded. `--no-output` skips judge
requests, and explicitly combining `--judges` with `--no-output` is refused. Without a pinned
`llm_judge`, the CLI requests no model jobs. Creating a judge alone does not start one.
`--check` creates no judge jobs.

With `--wait 0`, the CLI requests the jobs and returns their current verdict state;
pending jobs continue in Hue. Uploaded outputs are checkpointed before the attempt or worker
queue is marked completed. If this handoff or dispatch fails, or its acknowledgement is lost,
rerun the unchanged command with the same checkpoint directory. The CLI resumes judging the uploaded
outputs without invoking the agent, using the same idempotency keys. Changing to `--no-judges`
or `--no-output` while that handoff is pending stops before a new agent run. After dispatch succeeds,
the next ordinary invocation starts a new run as usual.

`--worker` discards cancelled or released judge handoffs. Once judge requests succeed, a
verdict-read failure is logged and the worker keeps accepting runs.

`--command "<shell command>"` spawns the command once per case with the world's environment
(`HUE_WORLD_ID`, `HUE_WORLD_TOKEN`, `HUE_WORLD_NOW` (the world's clock at creation, RFC 3339; `worldNow()` reads it and returns
`null` without it, so fall back explicitly with `worldNow() ?? new Date()`), one `HUE_SIM_<SURFACE ID>_URL` per provider
mirror,
`HUE_MCP_CONFIG` naming an owner-only `mcpServers` file that is removed after the case, and
`HUE_MCP_URL`, `HUE_MCP_TOKEN`, `HUE_MCP_EXPIRES_AT` for the first MCP mirror; these name the
world's simulated MCP server and replace a `HUE_MCP_URL` that `hue login` stored for Hue's project
MCP server), plus
`HUE_EXECUTION_ID`, `HUE_ENVIRONMENT_RUN_ID`, `HUE_CASE_ID` and `HUE_CASE_KEY`, and
`{"inputs": ..., "config": ...}` on stdin. The child does not receive `HUE_API_KEY`, `HUE_MCP_KEY`
or any other Hue control-plane credential unless `--allow-hue-credentials` is passed; the rest of
the parent environment (model keys, application settings) is inherited. `HUE_CASE_DIR`,
`HUE_CASE_INPUTS` and `HUE_CASE_OUTPUT_DIR` name a private case directory with the layout direct
cases use: the case inputs, verified copies of the case's agent-visible pinned files under
`files/<role>/`, and `output/`, whose files are uploaded after the world seals (the command still
starts in the current directory). The case directory never holds the world token and is removed
after the case. Its stdout is the answer
(JSON when it parses, otherwise trimmed text; empty means no output); a non-zero exit or the
per-case `--timeout` (default 600 seconds) is a target failure. A timed-out or interrupted command
is stopped as a whole process group on macOS and Linux: SIGTERM, then SIGKILL for anything still
running 5 seconds later, including an agent a compound command started after its shell exited;
the case settles only once nothing in the group is left. A command that exits normally but leaves
processes in its group has them stopped the same way before its answer and files are read. A
second Ctrl+C during that grace kills the group at once, removes the world case's files, the MCP
configuration file and the checkpoint locks, and exits with 130. The world token is never logged.
A world created while the deployment's simulation gateway is off gets the legacy `hue_sim_`
capability under the same `HUE_MCP_*` names. The agent key defaults to the slug of the command's
script name; `--revision` is sent to Hue as the agent revision of every world.

`--worker` registers the adapter through `runLocalAgent()` with key `--agent-key` (default: the
adapter filename slug), name `--agent-name` (default: the key), revision `--revision` (default:
`AGENT_REVISION`, then the Git `HEAD` short hash, then `dev`). Command workers register
`environment:v1`, `world-model-reference:v1` and `direct:v1`, plus any repeated `--capability <value>`: the same worker runs
world cases, answer-only cases and mixed eval sets launched from Hue. Commands keep the launch
directory for both case kinds, so relative application entry points and configuration work.
Direct cases receive the task/config on stdin and private files/output through `HUE_CASE_*`,
without a world token, MCP connection or `HUE_ENVIRONMENT_RUN_ID`. App calls that require a world
must stay disabled for this handoff; never fall back to live app credentials.

Adapter-file workers register `environment:v1` and `world-model-reference:v1` by default (the
second admits cases built from a trace and pinned to a user World). Add `--capability direct:v1` only when
the adapter also handles `context.mode === "direct"`; its direct context carries `config`, case
identity, `executionId`, `files`, `outputDirectory` and `signal`, with no world or tools. These
worker behaviors are added in TypeScript 0.13.2. Upgrading an existing worker requires a new
`--revision`, because adding a capability to a previously registered revision is refused; this
includes the upgrade to the SDK that declares `world-model-reference:v1`.

The worker prints the registration and each claimed run with its
URL, executes runs launched from Hue until Ctrl+C or `--max-runs <n>`, and prints the verdict table
after each run. Selection flags do not apply; Hue chooses the pinned experiment. The worker exits 0
when it stops normally. Hue offers a case whose world comes with agent-visible files only to a
registration that declares `environment-files:v1` and `input:<extension>` for each file type, for
example `--capability environment-files:v1 --capability input:pdf`; the adapter or command then
receives the files as described above. Hue keeps each registered revision's capabilities fixed,
so declare new ones under a new `--revision`. A world pinned to provider profiles, a Gmail world
for example, needs a reviewed `attemptBaselineV2` (see
[Pinned provider-profile preflight](ENVIRONMENTS.md#pinned-provider-profile-preflight)); `--worker`
registers none, so put `"attemptBaselineV2"` in the run's configuration JSON when you launch the
run from Hue.

`--trace-not-accepted pending` completes a case whose telemetry Hue did not accept in time in its
true state with the trace still to arrive, carrying the count of spans the case ended; Hue scores
the sealed world at once and attaches the trace once its export is complete. The default,
`fail_case`, completes such a case as failed with its evidence omitted.

A Scenario or eval set whose dataset version is not saved cannot back an experiment: the command
exits 1 and asks for **Save eval-set version** in Hue or `--save-version`, which freezes that
version at its current revision. Connection settings are `HUE_API_KEY` and `HUE_BASE_URL`
(default `https://app.hue.run`), loaded from `--env-file <path>` (or its alias `--env-path`) first when given, otherwise from
`./.env.hue` when the shell has no `HUE_API_KEY` (a key in the shell keeps its own origin); `--origin`
overrides the origin. Since TypeScript 0.14.0, telemetry content capture defaults on; `--no-content` opts out.
Earlier releases require `--content`; the examples include it for compatibility. Model and tool spans inside the agent come
only from the agent's own instrumentation. Case outputs, error messages and explanations are
stored in Hue independently of the telemetry capture setting, so a case's answer can be graded and read on
its run page. A `--command`'s stdout is its answer unless it writes a result file, and is stored,
so it must not print credentials or debug logs there; before storing, `hue eval` replaces the
credentials it handed the case (the world token and MCP headers, a legacy MCP token, attempt
bearers) and every Hue control-plane credential in its environment with `[redacted]`, in the
answer, an adapter's thrown message and name, generated file names and the local checkpoint.
`--no-output` keeps outputs, error messages and explanations out of a one-shot run's stored
results; captured telemetry still carries the output. Pass `--no-output --no-content` to omit both. `--worker` always stores them, because a run launched from Hue is read
on its run page (that is `runLocalAgent()`'s contract), and refuses `--no-output`. An interrupted
one-shot run keeps the choice it started with, so one run never mixes stored and unstored outputs:
rerunning it with another output or telemetry capture policy is refused with the flags that resume it.
To resume a metadata-only trace from an earlier release, add `--no-content` and keep its original `--no-output` choice.

Files the agent writes to `output/` are uploaded as generated documents with or without
`--no-output`, and they are not redacted the way the answer is: `hue eval` replaces the same
credentials only in the UTF-8 `.txt`, `.csv` and `.json` documents it collects, while PDF, Office
and image documents, and files an adapter returns by `path`, are uploaded as written. A direct
case also keeps the agent's raw `output/` files on disk under its checkpoint directory
(`.hue/eval/<agent-key>/<project>/direct/<experiment>/files/`). Never write credentials to
`output/`.

Trace evidence is required for every case: when Hue does not accept a case's traces or logs, the
case is completed as failed (error `TelemetryNotAccepted`, evidence omitted as
`telemetry_not_accepted`, no output or generated files attached) instead of being left started,
and the run goes on. Each export of the CLI's own telemetry may take 30 seconds, retries
included: a slow acknowledgement is waited for, and a 429, 502, 503, 504 or network error is
retried within that time, honouring `Retry-After`. A 429 whose `Retry-After` is longer than that
holds the case's records and sends them again once it has passed, for at most 60 seconds of holds
per export, so such a case can take that much longer; a longer wait fails the case as
`telemetry_not_accepted`. Any other response, or rejected records, fails the case at once. Stderr
names the case as it completes, with the export
issue counts, for example
`[refund] telemetry not accepted, case failed: telemetry_not_accepted: traces failed 1 (HTTP 400)`;
the case counts as an error in the table and JSON whatever its scores, and the command exits 1.
Counts carry signals, kinds, HTTP statuses and record numbers only, never content or credentials.
Resumable checkpoints live in `.hue/eval/<agent-key>/<project id>/` (a `.gitignore` is written
inside `.hue/eval/`); `--checkpoint-dir` overrides the root. Rerunning the same selection resumes
an interrupted run without invoking the agent again; a different selection is refused until the
unfinished one is resumed or its directory is removed.

Exit codes: `0` every case passed the evaluators that apply to it (advisory ones never count),
`1` a case failed, errored (including one no pinned evaluator applies to or decides), was skipped,
was inconclusive (a required judge could not run or answer; the table says `INCONCLUSIVE` and the
summary counts it apart from skipped cases) or Hue's checks were still pending at `--wait`, `2` usage or configuration error (including a missing key), `130`
interrupted. On Node.js 22, load TypeScript adapters with `NODE_OPTIONS=--experimental-strip-types`;
non-erasable syntax (enums, parameter properties, namespaces) needs a loader such as `--import tsx`
on any Node.js version.

## Evaluate a document eval set

Eval sets whose cases pin no simulated world — a task plus pinned input files, answered with
generated documents — run as **direct** cases through `runExperiment()`. `hue eval` reads this from the saved
version's cases: a case that pins a world (an immutable version, or a World model reference
whose World Hue prepares at execution) runs in a fresh world, one that pins none (an
answer-graded trace-to-case publication included) runs direct, and a version holding both runs
mixed. `--mode direct|simulation` forces one kind and is refused when a case cannot run that way. `--set` accepts the eval set's slug, name, ID or URL; `--set-version <n>` pins a
saved version other than the latest; `--scorer <slug|name|id>` pins an evaluator at its newest
published version, beside or instead of explicit `--scorer-version` IDs.

```sh
hue eval --set gia-d1-citation --scorer gia-d1-citation \
  --command "pnpm --filter @august/frontend run hue:gia-agent" \
  --revision prompt-v10 --wait 1800 --content --json
hue eval --set gia-d1-citation --set-version 1 --scorer gia-d1-citation ./hue-agent.ts --content --baseline <run id>
```

For each case the command is spawned once **inside a private case directory** with
`HUE_CASE_DIR`, `HUE_CASE_INPUTS`, `HUE_CASE_OUTPUT_DIR`, `HUE_CASE_ID`, `HUE_CASE_KEY` and
`HUE_EXECUTION_ID` in its environment (`{"inputs","config"}` is also written to stdin):

```text
<case dir>/inputs.json            the case inputs (for example {"query": "...", "tipo_diligencia": "Virtual"})
<case dir>/case.json              id, external key, execution id, run config, staged file list
<case dir>/files/<role>/<name>    verified copies of the agent-visible pinned files
<case dir>/output/                write the generated documents here
```

Hue verifies each generated document before the case completes. Once a document is reserved and
its bytes are uploaded, a verification that outlasts a request is waited out for up to three
minutes, so a completion that cannot reach Hue takes that long to fail; a reservation or upload
that cannot reach Hue still fails at once.

Every regular file the command leaves under `output/` is uploaded as a generated document
(accepted: `.pdf .docx .pptx .xlsx .json .txt .csv .png .jpg .jpeg .webp .gif .avif .mp3 .mpeg
.wav .ogg .m4a .flac .opus .aac .mp4 .webm`; another extension or an empty file is the case's
error). Optional helpers: `manifest.json` (`{"primary": "<filename>", "output": <json>,
"contentTypes": {"<path>": "<MIME>"}}`) names the primary document, the JSON output and declared
content types; `result.json` is the JSON
output; `summary.txt` or `summary.md` is recorded as `{"summary": "..."}`. When none is written,
the command's stdout is the output (JSON when it parses). A single generated file is the primary
document by default. Model and provider credentials stay in the command's own environment; the
scoped case files are copies under `--checkpoint-dir` (default `.hue/eval/<agent-key>/<project>/direct/<experiment>`).

For `.mp4` and `.webm` files, `manifest.json.contentTypes` must declare the matching audio or
video MIME type: `audio/mp4` or `video/mp4`, and `audio/webm` or `video/webm`. Each key must match
the actual relative path under `output/`, including case. For example,
`{"contentTypes":{"nested/clip.MP4":"video/mp4"}}` declares `output/nested/clip.MP4`.

The same collection serves world cases, and it does not trust paths the agent controls. `output/`
must be a real directory, and a helper name, when present, a regular file; a symlink, FIFO or
directory in either place is the case's error. Symlinks and other special files among the
documents are skipped, as are hidden and lock entries. Every file is opened without following a
final symlink or blocking, must be the regular file the listing saw and within its limit (4 MiB
for a helper, 25 MiB for a document, checked before reading), and its upload is staged from the
bytes read. A file or directory that vanished or changed while it was collected, more than 32
documents or more than 1024 entries is the case's error too. A hard link is an ordinary file and
is collected like one: an agent running as your user could copy the file just as well, so run an
agent that must not reach your files under another account or in a sandbox.

An adapter file works too: it is called with `(inputs, context)` where `context.mode` is
`"direct"` and `context` carries `config`, `item`, `executionId`, `files` (agent-visible pinned
files on disk), `outputDirectory` and `signal`. Return a JSON value, or `withFiles(output, files)`
from `@hue-run/sdk/evals` to attach generated documents.

Code evaluators pinned to the run are **not** executed on your machine: the CLI leaves them
deferred (`deferUnboundLocalScorers`) and Hue's grading executor scores the uploaded documents;
evaluator-only pinned files such as a legal corpus are never downloaded. `Waiting for Hue
checks...` then covers that grading, so size `--wait` to the evaluator's runtime. The
`--json` document gains `"mode": "direct"` and `"deferredScorerVersionIds"`. Exit codes, `--baseline`,
`--content`, `--no-output` and checkpoints behave as for Scenarios; generated documents are
uploaded with or without them.
