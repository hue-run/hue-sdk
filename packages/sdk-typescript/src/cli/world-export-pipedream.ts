import { isObject, RequestError, retryAfterMs, send, type Transport } from "./world-http.js";

/**
 * `hue world create --export-from <app>` through a Pipedream Connect account: every request the
 * app's reader makes goes through the project's Connect proxy, which adds the account's own
 * credential upstream. The reader is unchanged; only its fetch is.
 */

export const PIPEDREAM_API_URL = "https://api.pipedream.com/v1";
/** A token is renewed this long before Pipedream says it expires. */
const RENEW_EARLY_MS = 60_000;
/** The lifetime assumed for a token whose answer names none. */
const DEFAULT_TOKEN_LIFETIME_MS = 60 * 60_000;
/** Headers a reader sets for the app's credential: the proxy supplies the account's instead. */
const CREDENTIAL_HEADERS = new Set(["authorization", "x-api-key"]);

/** A Pipedream project's OAuth client and the Connect account an export reads through. */
export interface PipedreamAccount {
  clientId: string;
  clientSecret: string;
  projectId: string;
  environment: "development" | "production";
  externalUserId: string;
  accountId: string;
}

/**
 * The account's Connect proxy as a transport. Each request goes to
 * `/v1/connect/{project_id}/proxy/{base64url(url)}?external_user_id=…&account_id=…` with the
 * `x-pd-environment` header and a token from the project's client credentials, renewed before it
 * expires. The request's credential headers are dropped and its other headers are forwarded with
 * the `x-pd-proxy-` prefix, as Pipedream's SDK sends them. `ready` gets the first token, so
 * refused client credentials stop the export before it reads anything. A renewal that fails,
 * after its own retries, ends the export with Pipedream's error rather than being retried as the
 * app's connection.
 */
export function pipedreamTransport(
  account: PipedreamAccount,
  transport: Transport,
  onToken: (token: string) => void,
): { transport: Transport; ready: () => Promise<void> } {
  let token: { value: string; renewAt: number } | undefined;
  /** The token request in flight, shared by the requests waiting for it. */
  let renewing: Promise<string> | undefined;
  const accessToken = (): Promise<string> => {
    if (token && performance.now() < token.renewAt) return Promise.resolve(token.value);
    renewing ??= renew().finally(() => (renewing = undefined));
    return renewing;
  };
  const renew = async (): Promise<string> => {
    const answer = await send(
      "Pipedream",
      {
        method: "POST",
        url: `${PIPEDREAM_API_URL}/oauth/token`,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "client_credentials",
          client_id: account.clientId,
          client_secret: account.clientSecret,
        }),
      },
      transport,
      ({ status, headers }) => (status === 429 ? (retryAfterMs(headers) ?? 1000) : undefined),
    );
    const body = isObject(answer.body) ? answer.body : {};
    if (answer.status !== 200 || typeof body.access_token !== "string" || !body.access_token)
      throw new RequestError(`Pipedream refused the client credentials (HTTP ${answer.status})`);
    onToken(body.access_token);
    const lifetime =
      typeof body.expires_in === "number" && body.expires_in > 0
        ? body.expires_in * 1000
        : DEFAULT_TOKEN_LIFETIME_MS;
    token = {
      value: body.access_token,
      renewAt: performance.now() + Math.max(lifetime - RENEW_EARLY_MS, 0),
    };
    return token.value;
  };
  const query = new URLSearchParams({
    external_user_id: account.externalUserId,
    account_id: account.accountId,
  });
  const proxied = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const target =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers({
      authorization: `Bearer ${await accessToken()}`,
      "x-pd-environment": account.environment,
    });
    new Headers(init.headers).forEach((value, name) => {
      if (CREDENTIAL_HEADERS.has(name)) return;
      headers.set(`x-pd-proxy-${name}`, value);
      if (name === "content-type") headers.set(name, value);
    });
    return transport.fetch(
      `${PIPEDREAM_API_URL}/connect/${encodeURIComponent(account.projectId)}/proxy/${Buffer.from(target).toString("base64url")}?${query}`,
      { ...init, headers },
    );
  }) as typeof fetch;
  return {
    transport: { ...transport, fetch: proxied },
    ready: async () => void (await accessToken()),
  };
}
