import { exchange, ExportError, fitsOneFile } from "./world-export.js";
import {
  isObject,
  retryAfterMs,
  send,
  type Answer,
  type JsonObject,
  type Transport,
} from "./world-http.js";

/**
 * `hue world create --export-from gmail`: reads a mailbox through Gmail's REST API with an access
 * token that has `gmail.readonly`, and records each call as an exchange
 * (`{request: {method, url, body}, response: {status, headers, body}}`), the answer exactly as
 * Gmail gave it. Every message, spam and trash included, is read in `full` format, and again in
 * `raw` format when it has an attachment and is small enough for the World to serve the
 * attachment's bytes. The token travels only in the `Authorization` header and is never recorded.
 */

export const GMAIL_API_URL = "https://gmail.googleapis.com/gmail/v1/users/me";
/** The largest message read again in `raw` format for its attachments. */
const MAX_RAW_BYTES = 190_000;
/** Messages read at once: four reads of 5 units each stay well within Gmail's 250 units per user
 * per second. */
const CONCURRENCY = 4;
/** A rate limit without `Retry-After` waits this long. */
const RATE_LIMIT_WAIT_MS = 5_000;
const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);

/** A 429, or a 403 whose reason is a rate limit, waits and is sent again. */
function gmailWait(answer: Answer): number | undefined {
  const error = isObject(answer.body) && isObject(answer.body.error) ? answer.body.error : {};
  const limited =
    answer.status === 429 ||
    (answer.status === 403 &&
      Array.isArray(error.errors) &&
      error.errors.some((item) => isObject(item) && RATE_LIMIT_REASONS.has(String(item.reason))));
  return limited ? (retryAfterMs(answer.headers) ?? RATE_LIMIT_WAIT_MS) : undefined;
}

/** Whether a message's payload holds a part whose body is an attachment. */
function hasAttachment(part: unknown, depth = 0): boolean {
  if (!isObject(part) || depth > 32) return false;
  if (isObject(part.body) && typeof part.body.attachmentId === "string") return true;
  return Array.isArray(part.parts) && part.parts.some((child) => hasAttachment(child, depth + 1));
}

export async function exportGmail(
  token: string,
  transport: Transport,
  progress: (line: string) => void,
): Promise<JsonObject[]> {
  const exchanges: JsonObject[] = [];
  /** One call, recorded by the caller in the order the calls were made. */
  const get = async (path: string) => {
    const url = `${GMAIL_API_URL}${path}`;
    const answer = await send(
      "Gmail",
      { method: "GET", url, headers: { authorization: `Bearer ${token}` } },
      transport,
      gmailWait,
    );
    if (answer.status === 401) throw new ExportError("Gmail refused the access token (HTTP 401)");
    return { answer, recorded: exchange(url, answer) };
  };
  const call = async (path: string) => {
    const { answer, recorded } = await get(path);
    exchanges.push(recorded);
    return answer;
  };
  /** Every page of a list; resolves to each page's answer. */
  const pages = async (path: string) => {
    const answers: Answer[] = [];
    for (let pageToken = ""; ; ) {
      const answer = await call(
        pageToken ? `${path}&pageToken=${encodeURIComponent(pageToken)}` : path,
      );
      answers.push(answer);
      if (answer.status !== 200) {
        progress(`Gmail: listing ${path} answered HTTP ${answer.status}; the list is incomplete.`);
        return answers;
      }
      const next = isObject(answer.body) ? answer.body.nextPageToken : undefined;
      if (typeof next !== "string" || !next) return answers;
      if (next === pageToken) throw new ExportError("Gmail answered the same page token twice");
      pageToken = next;
    }
  };

  const profile = await call("/profile");
  if (profile.status !== 200)
    throw new ExportError(`Gmail answered HTTP ${profile.status} for the mailbox's profile`);
  const labels = await call("/labels");
  if (labels.status !== 200) progress(`Gmail: listing labels answered HTTP ${labels.status}.`);
  const ids = (await pages("/messages?includeSpamTrash=true&maxResults=500")).flatMap((page) =>
    isObject(page.body) && Array.isArray(page.body.messages)
      ? page.body.messages.flatMap((message) =>
          isObject(message) && typeof message.id === "string" ? [message.id] : [],
        )
      : [],
  );
  progress(`Gmail: ${ids.length} messages`);
  let raw = 0;
  let batches = 0;
  let failed = 0;
  /** Messages too large for one file, named in the summary. */
  const tooLarge: string[] = [];
  for (let index = 0; index < ids.length; index += CONCURRENCY) {
    const batch = ids.slice(index, index + CONCURRENCY);
    const full = await Promise.all(
      batch.map((id) => get(`/messages/${encodeURIComponent(id)}?format=full`)),
    );
    for (const [at, { answer, recorded }] of full.entries()) {
      if (!fitsOneFile(recorded)) tooLarge.push(batch[at]!);
      else exchanges.push(recorded);
      if (answer.status !== 200) failed++;
    }
    const withAttachments = batch.filter((_, at) => {
      const message = full[at]!.answer.body;
      return (
        isObject(message) &&
        typeof message.sizeEstimate === "number" &&
        message.sizeEstimate <= MAX_RAW_BYTES &&
        hasAttachment(message.payload)
      );
    });
    const raws = await Promise.all(
      withAttachments.map((id) => get(`/messages/${encodeURIComponent(id)}?format=raw`)),
    );
    for (const { answer, recorded } of raws) {
      exchanges.push(recorded);
      if (answer.status !== 200) failed++;
    }
    raw += raws.length;
    if (++batches % 250 === 0)
      progress(`Gmail: read ${index + batch.length} of ${ids.length} messages`);
  }
  if (raw) progress(`Gmail: ${raw} messages read again for their attachments`);
  // A failed read is kept as Gmail answered it; that message is missing from the World.
  if (failed) progress(`Gmail: ${failed} message reads failed; those messages are incomplete.`);
  if (tooLarge.length)
    progress(
      `Gmail: skipped ${tooLarge.length} ${tooLarge.length === 1 ? "message" : "messages"} larger than one file: ${tooLarge.slice(0, 10).join(", ")}${tooLarge.length > 10 ? ", ..." : ""}.`,
    );
  await pages("/drafts?maxResults=500");
  return exchanges;
}
