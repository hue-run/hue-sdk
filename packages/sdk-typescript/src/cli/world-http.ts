/**
 * The one HTTP exchange `hue world` makes with Hue, the upload store and the apps it exports
 * from: bounded answers, rate-limit waits and retries of transient failures.
 */

/** Each request's own deadline unless it names another. */
const REQUEST_TIMEOUT_MS = 60_000;
/** Waits between attempts of a request that failed for its connection or a 5xx. */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000];
/** The longest rate-limit wait: the apps' windows are an hour at most. */
const MAX_RATE_LIMIT_WAIT_MS = 60 * 60_000;
/** Rate-limit answers waited out in a row before a request is given up. */
const MAX_RATE_LIMITED = 20;
/** The largest answer read. */
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

export type JsonObject = Record<string, unknown>;
export const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A request that could not be answered; its message names no credential. */
export class RequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestError";
  }
}

/** The fetch to use, a wait that ends early when the command is stopped, and a progress line. */
export interface Transport {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  signal: AbortSignal;
  warn: (line: string) => void;
}

/** An answer's status, headers and body: its JSON when it parses, else its text. */
export interface Answer {
  status: number;
  headers: Headers;
  body: unknown;
}

/** External text on one bounded line, for a message. */
export function quote(text: string): string {
  const line = text.replace(/[^\P{Cc}]|\p{Cf}/gu, " ").trim();
  return line.length > 300 ? `${line.slice(0, 297)}...` : line;
}

/** Whole seconds of `Retry-After`, or undefined. */
export function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get("retry-after")?.trim();
  return value && /^\d{1,6}$/.test(value) ? Number(value) * 1000 : undefined;
}

async function readBody(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new RequestError("An answer is too large to read");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * One request with retries. When `rateLimit` names a wait for an answer, the request is sent
 * again after it; a connection failure or a 5xx is tried again after 1, 2, 4 and 8 seconds.
 * Every attempt sends the same bytes. Resolves to any other answer.
 */
export async function send(
  service: string,
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string | Uint8Array<ArrayBuffer>;
    timeoutMs?: number;
  },
  transport: Transport,
  rateLimit: (answer: Answer) => number | undefined,
): Promise<Answer> {
  for (let failures = 0, limited = 0; ; ) {
    if (transport.signal.aborted) throw new RequestError("Stopped");
    let response: Response | undefined;
    try {
      response = await transport.fetch(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        redirect: "error",
        signal: AbortSignal.any([
          transport.signal,
          AbortSignal.timeout(request.timeoutMs ?? REQUEST_TIMEOUT_MS),
        ]),
      });
    } catch {
      response = undefined;
    }
    let answer: Answer | undefined;
    if (response && response.status < 500) {
      try {
        answer = {
          status: response.status,
          headers: response.headers,
          body: await readBody(response),
        };
      } catch (error) {
        // An answer too large to read fails at once; one that broke off is asked for again.
        if (error instanceof RequestError) throw error;
      }
    }
    if (answer) {
      const wait = rateLimit(answer);
      if (wait === undefined) return answer;
      if (++limited > MAX_RATE_LIMITED)
        throw new RequestError(`${service} kept refusing requests for their rate`);
      const ms = Math.min(Math.max(wait, 1000), MAX_RATE_LIMIT_WAIT_MS);
      transport.warn(`${service} asked to slow down; waiting ${Math.ceil(ms / 1000)} s.`);
      await transport.sleep(ms);
      continue;
    }
    await response?.body?.cancel().catch(() => {});
    if (transport.signal.aborted) throw new RequestError("Stopped");
    if (failures >= RETRY_DELAYS_MS.length)
      throw new RequestError(
        response
          ? `${service} answered HTTP ${response.status}`
          : `${service} could not be reached`,
      );
    await transport.sleep(RETRY_DELAYS_MS[failures++]!);
  }
}

/** The longest `Retry-After` honoured from Hue or the upload store: they ask for seconds. */
const MAX_SLOW_DOWN_MS = 30_000;

/** A wait for an answer that asks to slow down (429) or timed out waiting for the request
 * (408): its `Retry-After`, at most 30 seconds, else a second. */
export const slowDown = ({ status, headers }: Answer): number | undefined =>
  status === 429 || status === 408
    ? Math.min(retryAfterMs(headers) ?? 1000, MAX_SLOW_DOWN_MS)
    : undefined;
