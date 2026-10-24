import { exchange, ExportError } from "./world-export.js";
import {
  isObject,
  quote,
  retryAfterMs,
  send,
  type Transport,
  type JsonObject,
} from "./world-http.js";

/**
 * `hue world create --export-from slack`: reads a Slack workspace through the Web API with the
 * user's own token (a user token reads the most) and records each call as an exchange
 * (`{request: {method, url, body}, response: {status, headers, body}}`), the answer exactly as
 * Slack gave it. Each list is paged until `response_metadata.next_cursor` is empty or `has_more`
 * is false. The token travels only in the `Authorization` header and is never recorded.
 */

export const SLACK_API_URL = "https://slack.com/api/";
const TYPES = "public_channel,private_channel,mpim,im";
/** A 429 without `Retry-After` waits this long. */
const RATE_LIMIT_WAIT_MS = 30_000;
/** Slack's answers that mean the token itself is refused: the export cannot go on. */
const REFUSED_TOKEN = new Set([
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "token_expired",
  "account_inactive",
]);

export async function exportSlack(
  token: string,
  transport: Transport,
  progress: (line: string) => void,
): Promise<JsonObject[]> {
  const exchanges: JsonObject[] = [];
  /** The calls Slack refused, by method and error: kept as Slack answered them, and named. */
  const refused = new Map<string, number>();
  /** One call with only the arguments named, recorded as sent and answered. */
  const call = async (method: string, args: Record<string, string> = {}): Promise<JsonObject> => {
    const query = new URLSearchParams(args).toString();
    const url = `${SLACK_API_URL}${method}${query ? `?${query}` : ""}`;
    const answer = await send(
      "Slack",
      { method: "GET", url, headers: { authorization: `Bearer ${token}` } },
      transport,
      ({ status, headers }) =>
        status === 429 ? (retryAfterMs(headers) ?? RATE_LIMIT_WAIT_MS) : undefined,
    );
    exchanges.push(exchange(url, answer));
    const body = isObject(answer.body) ? answer.body : {};
    if (answer.status === 401 || (typeof body.error === "string" && REFUSED_TOKEN.has(body.error)))
      throw new ExportError(
        `Slack refused the token (${typeof body.error === "string" ? quote(body.error) : `HTTP ${answer.status}`})`,
      );
    if (body.ok !== true) {
      const reason = `${method} ${typeof body.error === "string" ? quote(body.error) : `HTTP ${answer.status}`}`;
      refused.set(reason, (refused.get(reason) ?? 0) + 1);
    }
    return body;
  };
  /** Every page of a cursor list, each with the same arguments: Hue serves a four-kind
   * `conversations.list` page only at the page size the export used. */
  const pages = async (method: string, args: Record<string, string> = {}) => {
    const answers: JsonObject[] = [];
    for (let cursor = ""; ; ) {
      const body = await call(method, cursor ? { ...args, cursor } : args);
      answers.push(body);
      const next =
        isObject(body.response_metadata) && typeof body.response_metadata.next_cursor === "string"
          ? body.response_metadata.next_cursor
          : "";
      if (body.ok !== true || !next || body.has_more === false) return answers;
      if (next === cursor) throw new ExportError(`Slack answered the same ${method} cursor twice`);
      cursor = next;
    }
  };
  const items = (answers: JsonObject[], key: string) =>
    answers.flatMap((answer) => (Array.isArray(answer[key]) ? answer[key].filter(isObject) : []));

  const auth = await call("auth.test");
  if (auth.ok !== true || typeof auth.user_id !== "string")
    throw new ExportError(
      `Slack's auth.test failed${typeof auth.error === "string" ? `: ${quote(auth.error)}` : ""}`,
    );
  await call("team.info");
  const users = items(await pages("users.list", { limit: "200" }), "members");
  progress(`Slack: ${users.length} users`);
  const lists = { types: TYPES, exclude_archived: "false", limit: "200" };
  const conversations = new Map<string, JsonObject>();
  for (const list of ["conversations.list", "users.conversations"])
    for (const channel of items(await pages(list, lists), "channels"))
      if (typeof channel.id === "string" && !conversations.has(channel.id))
        conversations.set(channel.id, channel);
  progress(`Slack: ${conversations.size} conversations`);

  let messages = 0;
  for (const [channel, conversation] of conversations) {
    await call("conversations.info", { channel });
    if (conversation.is_im !== true)
      await pages("conversations.members", { channel, limit: "1000" });
    // A conversation the token cannot read answers `ok: false`, recorded as Slack gave it.
    const history = items(
      await pages("conversations.history", { channel, limit: "999" }),
      "messages",
    );
    messages += history.length;
    for (const message of history)
      if (
        typeof message.reply_count === "number" &&
        message.reply_count > 0 &&
        typeof message.ts === "string"
      )
        await pages("conversations.replies", { channel, ts: message.ts, limit: "999" });
    if (conversation.is_im !== true && conversation.is_mpim !== true) {
      await call("pins.list", { channel });
      await call("bookmarks.list", { channel_id: channel });
    }
  }
  progress(`Slack: ${messages} messages`);

  let files = 0;
  for (let page = 1; ; page++) {
    const answer = await call("files.list", { count: "100", page: String(page) });
    if (Array.isArray(answer.files)) files += answer.files.length;
    const paging = isObject(answer.paging) ? answer.paging : {};
    if (answer.ok !== true || typeof paging.pages !== "number" || page >= paging.pages) break;
  }
  progress(`Slack: ${files} files`);

  // reactions.list hands out a cursor or, without one, numbered pages (`paging`): follow either.
  const reactions = await pages("reactions.list");
  const paging =
    reactions.length === 1 && isObject(reactions[0]!.paging) ? reactions[0]!.paging : {};
  if (reactions.length === 1 && reactions[0]!.ok === true && typeof paging.pages === "number")
    for (let page = 2; page <= paging.pages; page++)
      if ((await call("reactions.list", { page: String(page) })).ok !== true) break;
  await call("users.profile.get", { user: auth.user_id });
  await call("dnd.teamInfo");
  if (refused.size) {
    const total = [...refused.values()].reduce((sum, count) => sum + count, 0);
    const reasons = [...refused].map(([reason, count]) => `${reason} ×${count}`);
    progress(
      `Slack: ${total} ${total === 1 ? "call" : "calls"} answered ok: false, kept as Slack answered them (${reasons.slice(0, 5).join(", ")}${reasons.length > 5 ? ", ..." : ""}).`,
    );
  }
  return exchanges;
}
