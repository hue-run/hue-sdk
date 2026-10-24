import { exchange, ExportError, fitsOneFile } from "./world-export.js";
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
/** Records a query page asks for, and the fewest Salesforce allows, which an object whose page
 * is too large for one file is read again at. */
const BATCH_SIZE = 2000;
const MIN_BATCH_SIZE = 200;
/** The longest query URL sent: Salesforce refuses a request URL past about 16 KB. */
const MAX_QUERY_URL = 12_000;
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
  /** One call, as sent and answered; a query page asks for `batchSize` records. */
  const request = async (path: string, batchSize?: number) => {
    const url = `${org.origin}${path}`;
    const answer = await send(
      "Salesforce",
      {
        method: "GET",
        url,
        headers: {
          authorization: `Bearer ${org.accessToken}`,
          ...(batchSize ? { "sforce-query-options": `batchSize=${batchSize}` } : {}),
        },
      },
      transport,
      () => undefined,
    );
    if (answer.status === 401)
      throw new ExportError("Salesforce refused the access token (HTTP 401)");
    const code =
      Array.isArray(answer.body) && isObject(answer.body[0]) ? answer.body[0].errorCode : undefined;
    if (code === "REQUEST_LIMIT_EXCEEDED")
      throw new ExportError(
        "The org has used its Salesforce API requests for today (REQUEST_LIMIT_EXCEEDED)",
      );
    return { answer, recorded: exchange(url, answer) };
  };
  const get = async (path: string) => {
    const { answer, recorded } = await request(path);
    exchanges.push(recorded);
    return answer;
  };
  /** Pages too large for one file even at the fewest records a page, named in the summary. */
  const missing: string[] = [];
  /**
   * One field group's full listing at a page size, followed through `nextRecordsUrl` and kept
   * only once it is complete. Undefined when a page is too large for one file and a smaller page
   * size is left; at the fewest records a page, such a page is left out and counted.
   */
  const readListing = async (name: string, path: string, batchSize: number) => {
    const recorded: JsonObject[] = [];
    let read = 0;
    let skipped = 0;
    let page = await request(path, batchSize);
    for (;;) {
      const body = isObject(page.answer.body) ? page.answer.body : {};
      const count = Array.isArray(body.records) ? body.records.length : 0;
      if (fitsOneFile(page.recorded)) {
        recorded.push(page.recorded);
        read += count;
      } else if (batchSize > MIN_BATCH_SIZE) return undefined;
      else skipped += count;
      const next = body.nextRecordsUrl;
      if (page.answer.status !== 200 || body.done !== false || typeof next !== "string")
        return { recorded, read, skipped, status: page.answer.status };
      if (!next.startsWith("/services/data/"))
        throw new ExportError(`Salesforce answered an unexpected next page for ${name}`);
      page = await request(next, batchSize);
    }
  };
  /** A listing at the usual page size, or from the start at the fewest records a page when one
   * of its pages is too large for one file. */
  const listing = async (name: string, path: string) => {
    for (let batchSize = BATCH_SIZE; ; batchSize = MIN_BATCH_SIZE) {
      const result = await readListing(name, path, batchSize);
      if (result) return result;
      progress(
        `Salesforce: a page of ${name} is larger than one file; reading it again ${MIN_BATCH_SIZE} records a page.`,
      );
    }
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

  /** Objects read in field groups, with their group counts, for the summary. */
  const split: string[] = [];
  for (const name of new Set(names)) {
    const describe = await get(`${API}/sobjects/${name}/describe`);
    if (describe.status !== 200) {
      progress(
        `Salesforce: describing ${name} answered HTTP ${describe.status}; ${name} is not exported.`,
      );
      continue;
    }
    const fields =
      isObject(describe.body) && Array.isArray(describe.body.fields)
        ? describe.body.fields.filter(isObject)
        : [];
    const selected = fields
      .filter((field) => typeof field.name === "string" && !SKIPPED_TYPES.has(String(field.type)))
      .map((field) => field.name as string);
    if (!selected.length) continue;
    // Live records only (`query`, not `queryAll`): deleted rows are not exported for now.
    const queryPath = (group: string[]) =>
      `${API}/query?${new URLSearchParams({ q: `SELECT ${group.join(",")} FROM ${name}` })}`;
    // An object whose query would pass the URL budget is read in field groups, each the same full
    // listing with Id, so the import merges their fields by record.
    const keys: string[] = selected.filter((field) => field === "Id");
    const fits = (group: string[]) => `${org.origin}${queryPath(group)}`.length <= MAX_QUERY_URL;
    const groups: string[][] = [];
    if (fits(selected)) groups.push(selected);
    else {
      let group = [...keys];
      for (const field of selected) {
        if (keys.includes(field)) continue;
        if (group.length > keys.length && !fits([...group, field])) {
          groups.push(group);
          group = [...keys];
        }
        group.push(field);
      }
      groups.push(group);
    }
    let records = 0;
    let failed: string | undefined;
    for (const [index, fieldGroup] of groups.entries()) {
      const { recorded, read, skipped, status } = await listing(name, queryPath(fieldGroup));
      exchanges.push(...recorded);
      if (skipped) missing.push(`${name} (${skipped} records)`);
      // Every group lists the same records; the first group's count is the object's.
      if (index === 0) records = read;
      // A failed page is kept as Salesforce answered it; the records after it are missing.
      if (status !== 200)
        failed ??= `Salesforce: reading ${name}${groups.length > 1 ? ` (field group ${index + 1} of ${groups.length})` : ""} answered HTTP ${status} after ${read} records; the rest of ${name} is missing.`;
    }
    if (groups.length > 1) split.push(`${name} (${groups.length})`);
    progress(
      failed ??
        `Salesforce: ${records} ${name}${groups.length > 1 ? ` in ${groups.length} field groups` : ""}`,
    );
  }
  if (missing.length)
    progress(
      `Salesforce: pages larger than one file even at ${MIN_BATCH_SIZE} records a page are missing: ${missing.join(", ")}.`,
    );
  if (split.length)
    progress(
      `Salesforce: read ${split.length === 1 ? "1 wide object" : `${split.length} wide objects`} in field groups to stay within the URL limit: ${split.join(", ")}.`,
    );
  return exchanges;
}
