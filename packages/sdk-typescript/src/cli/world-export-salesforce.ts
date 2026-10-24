import { exchange, ExportError } from "./world-export.js";
import { isObject, send, type Transport, type JsonObject } from "./world-http.js";

/**
 * `hue world create --export-from salesforce`: reads the org as the exporting user sees it
 * through the REST API with that user's access token, and records each call as an exchange
 * (`{request: {method, url, body}, response: {status, headers, body}}`), one per page, the
 * answer exactly as Salesforce gave it. The token travels only in the `Authorization` header and
 * is never recorded.
 */

const API = "/services/data/v67.0";
/** The standard objects described and queried, when the org has them. */
const OBJECTS = [
  "Organization",
  "User",
  "Profile",
  "Group",
  "Account",
  "Contact",
  "Lead",
  "Opportunity",
  "OpportunityContactRole",
  "OpportunityLineItem",
  "OpportunityHistory",
  "Product2",
  "Pricebook2",
  "PricebookEntry",
  "Campaign",
  "CampaignMember",
  "Case",
  "CaseComment",
  "Task",
  "Event",
  "EventRelation",
  "Note",
  "Contract",
  "Order",
  "ContentDocument",
  "ContentVersion",
  "OpportunityStage",
  "LeadStatus",
  "CaseStatus",
  "TaskStatus",
];
/** Field types a query leaves out: their component fields carry the values. */
const SKIPPED_TYPES = new Set(["base64", "address", "location"]);

/** The org's My Domain origin (`https://<name>.my.salesforce.com`), or undefined. */
export function salesforceOrigin(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  return url.protocol === "https:" &&
    url.hostname.endsWith(".my.salesforce.com") &&
    !url.username &&
    !url.password &&
    url.pathname === "/" &&
    !url.search &&
    !url.hash
    ? url.origin
    : undefined;
}

export async function exportSalesforce(
  org: { origin: string; accessToken: string },
  transport: Transport,
  progress: (line: string) => void,
): Promise<JsonObject[]> {
  const exchanges: JsonObject[] = [];
  const get = async (path: string, query = false) => {
    const url = `${org.origin}${path}`;
    const answer = await send(
      "Salesforce",
      {
        method: "GET",
        url,
        headers: {
          authorization: `Bearer ${org.accessToken}`,
          ...(query ? { "sforce-query-options": "batchSize=2000" } : {}),
        },
      },
      transport,
      () => undefined,
    );
    exchanges.push(exchange(url, answer));
    if (answer.status === 401)
      throw new ExportError("Salesforce refused the access token (HTTP 401)");
    const code =
      Array.isArray(answer.body) && isObject(answer.body[0]) ? answer.body[0].errorCode : undefined;
    if (code === "REQUEST_LIMIT_EXCEEDED")
      throw new ExportError(
        "The org has used its Salesforce API requests for today (REQUEST_LIMIT_EXCEEDED)",
      );
    return answer;
  };

  const me = await get(`${API}/chatter/users/me`);
  if (me.status !== 200)
    throw new ExportError(`Salesforce answered HTTP ${me.status} for the user`);
  const global = await get(`${API}/sobjects`);
  const sobjects =
    global.status === 200 && isObject(global.body) && Array.isArray(global.body.sobjects)
      ? global.body.sobjects.filter(isObject)
      : undefined;
  if (!sobjects) throw new ExportError(`Salesforce answered HTTP ${global.status} for its objects`);
  const listed = new Set(sobjects.map((sobject) => sobject.name));
  const names = [
    ...OBJECTS.filter((name) => listed.has(name)),
    ...sobjects
      .filter(
        (sobject) =>
          sobject.custom === true &&
          sobject.queryable === true &&
          typeof sobject.name === "string" &&
          sobject.name.endsWith("__c"),
      )
      .map((sobject) => sobject.name as string),
  ];

  for (const name of new Set(names)) {
    const describe = await get(`${API}/sobjects/${name}/describe`);
    const fields =
      describe.status === 200 && isObject(describe.body) && Array.isArray(describe.body.fields)
        ? describe.body.fields.filter(isObject)
        : [];
    const selected = fields
      .filter((field) => typeof field.name === "string" && !SKIPPED_TYPES.has(String(field.type)))
      .map((field) => field.name as string);
    if (!selected.length) continue;
    const route = fields.some((field) => field.name === "IsDeleted") ? "queryAll" : "query";
    let page = await get(
      `${API}/${route}?${new URLSearchParams({ q: `SELECT ${selected.join(",")} FROM ${name}` })}`,
      true,
    );
    let records = 0;
    for (;;) {
      const body = isObject(page.body) ? page.body : {};
      if (Array.isArray(body.records)) records += body.records.length;
      const next = body.nextRecordsUrl;
      if (page.status !== 200 || body.done !== false || typeof next !== "string") break;
      if (!next.startsWith("/services/data/"))
        throw new ExportError(`Salesforce answered an unexpected next page for ${name}`);
      page = await get(next, true);
    }
    progress(`Salesforce: ${records} ${name}`);
  }
  return exchanges;
}
