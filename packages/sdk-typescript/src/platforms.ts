import type { HueClient } from "./client.js";
import type { ToolOptions } from "./types.js";

// Tool spans for connector platform SDK calls. An agent usually wraps `composio.tools.execute`
// or `pipedream.actions.run` inside its own tool function and traces only the wrapper, so the
// platform call that ran the app operation never becomes a span. These helpers patch the
// method on the client instance the application already holds; the SDK takes no dependency on
// `@composio/core` or `@pipedream/sdk`. Arguments are recorded under the field names of the
// platform's REST request (what fixtures and translators read); the result is recorded as the
// SDK returned it.

type Describe = (
  args: unknown[],
) => { name: string; input: unknown; options: ToolOptions } | undefined;

const COMPOSIO_URL = "https://backend.composio.dev";
const PIPEDREAM_URL = "https://api.pipedream.com";
const instrumented = new WeakSet<object>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function defined(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

/** Replaces `target[method]` with a version that records a tool span alongside the original call.
 * The caller receives the original return value, so a Pipedream `HttpResponsePromise` keeps
 * `withRawResponse()`; the span settles with it and a rejection stays the caller's to handle. */
function patch(hue: HueClient, target: unknown, method: string, describe: Describe): void {
  if (target === null || typeof target !== "object" || instrumented.has(target)) return;
  const original = Reflect.get(target, method);
  if (typeof original !== "function") return;
  instrumented.add(target);
  Reflect.set(target, method, function (this: unknown, ...args: unknown[]) {
    const call = describe(args);
    const result = Reflect.apply(original, this ?? target, args);
    if (call) hue.tool(call.name, call.input, () => result, call.options).catch(() => undefined);
    return result;
  });
}

/**
 * Records one `execute_tool <TOOL_SLUG>` span per `composio.tools.execute(slug, params)` call on
 * a `@composio/core` client, or per `session.execute(slug, arguments)` on a Tool Router session,
 * and returns the same client. The span records `hue.integration.platform` `composio`, the
 * pinned `version` as `hue.integration.version`, the REST body (`connected_account_id`,
 * `arguments`, `user_id`, `version`) as the tool arguments and the SDK's response as the result.
 * `customAuthParams` and other credential-bearing fields are not recorded. A disabled client
 * returns the client untouched.
 */
export function instrumentComposio<T>(hue: HueClient, composio: T): T {
  if (!hue.enabled) return composio;
  if (!isRecord(composio)) return composio;
  const client = composio;
  const base = text(isRecord(client.client) ? client.client.baseURL : undefined) ?? COMPOSIO_URL;
  patch(hue, client.tools, "execute", ([slug, params]) => {
    if (typeof slug !== "string") return undefined;
    const body = isRecord(params) ? params : {};
    return {
      name: slug,
      input: defined({
        connected_account_id: body.connectedAccountId,
        arguments: body.arguments,
        user_id: body.userId,
        version: body.version,
      }),
      options: {
        endpoint: {
          url: `${base}/api/v3.1/tools/execute/${encodeURIComponent(slug)}`,
          source: "client_config",
          method: "POST",
        },
        integration: { platform: "composio", version: text(body.version) },
      },
    };
  });
  const sessionId = text(client.sessionId);
  if (sessionId !== undefined)
    patch(hue, composio, "execute", ([slug, args]) => {
      if (typeof slug !== "string") return undefined;
      return {
        name: slug,
        input: defined({ tool_slug: slug, arguments: args }),
        options: {
          endpoint: {
            url: `${base}/api/v3.1/tool_router/session/${encodeURIComponent(sessionId)}/execute`,
            source: "client_config",
            method: "POST",
          },
          integration: { platform: "composio" },
        },
      };
    });
  return composio;
}

/**
 * Records one `execute_tool <component-key>` span per `client.actions.run({ id, externalUserId,
 * configuredProps, version })` call on a `@pipedream/sdk` Connect client and returns the same
 * client. The span records `hue.integration.platform` `pipedream`, the component `version` as
 * `hue.integration.version`, the REST body (`id`, `version`, `external_user_id`,
 * `configured_props`) as the tool arguments and the `{ exports, os, ret }` response as the
 * result. A disabled client returns the client untouched.
 */
export function instrumentPipedream<T>(hue: HueClient, pipedream: T): T {
  if (!hue.enabled) return pipedream;
  if (!isRecord(pipedream)) return pipedream;
  const client = pipedream;
  const config = isRecord(client._options) ? client._options : {};
  const base = config.baseUrl === undefined ? PIPEDREAM_URL : text(config.baseUrl);
  const projectId = text(config.projectId);
  patch(hue, client.actions, "run", ([request]) => {
    if (!isRecord(request)) return undefined;
    const body = request;
    const id = text(body.id);
    if (id === undefined) return undefined;
    return {
      name: id,
      input: defined({
        id,
        version: body.version,
        external_user_id: body.externalUserId,
        configured_props: body.configuredProps,
      }),
      options: {
        ...(base !== undefined && projectId !== undefined
          ? {
              endpoint: {
                url: `${base}/v1/connect/${encodeURIComponent(projectId)}/actions/run`,
                source: "client_config",
                method: "POST",
              },
            }
          : {}),
        integration: { platform: "pipedream", version: text(body.version) },
      },
    };
  });
  return pipedream;
}
