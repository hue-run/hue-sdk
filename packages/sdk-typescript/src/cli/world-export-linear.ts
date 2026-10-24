import { ExportError } from "./world-export.js";
import {
  isObject,
  quote,
  retryAfterMs,
  send,
  type Answer,
  type Transport,
  type JsonObject,
} from "./world-http.js";

/**
 * `hue world create --export-from linear`: reads a Linear workspace with the user's own access and
 * keeps every object exactly as Linear returns it, `__typename` included. The queries are the
 * ones Hue's world-import guide (Hue MCP `load_hue_guide`, topic `world-import`) names. Linear is
 * reached directly with a Linear API key, or through Composio's `LINEAR_RUN_QUERY_OR_MUTATION`
 * tool on a connected account.
 */

/** Linear's GraphQL endpoint. */
export const LINEAR_API_URL = "https://api.linear.app/graphql";
/** Composio's tool execution route for Linear queries. */
export const COMPOSIO_LINEAR_URL =
  "https://backend.composio.dev/api/v3.1/tools/execute/LINEAR_RUN_QUERY_OR_MUTATION";
/** The wait for a rate limit that names no reset. */
const RATE_LIMIT_WAIT_MS = 60_000;
/** Fields dropped from one query before the export gives up on it. */
const MAX_DROPPED_FIELDS = 20;

/** Each list the guide exports, by its root field, in the guide's order. */
const QUERIES: [root: string, query: string][] = [
  [
    "organization",
    "query { organization { __typename aiDiscussionSummariesEnabled aiThreadSummariesEnabled allowMembersToInvite allowedAuthServices allowedFileUploadContentTypes archivedAt authSettings createdAt createdIssueCount customerCount customersConfiguration customersEnabled defaultFeedSummarySchedule defaultHomeView defaultHomeViewTargetId deletionRequestedAt feedEnabled fiscalYearStartMonth gitBranchFormat gitLinkbackDescriptionsEnabled gitLinkbackMessagesEnabled gitPublicLinkbackMessagesEnabled hideNonPrimaryOrganizations hipaaComplianceEnabled id initiativeUpdateReminderFrequencyInWeeks initiativeUpdateRemindersDay initiativeUpdateRemindersHour logoUrl name periodUploadVolume previousUrlKeys projectUpdateReminderFrequencyInWeeks projectUpdateRemindersDay projectUpdateRemindersHour projectUpdatesReminderFrequency pullRequestIssueMode pullRequestTourEnabled releaseChannel releasesEnabled restrictLabelManagementToAdmins restrictTeamCreationToAdmins roadmapEnabled samlEnabled scimEnabled securitySettings slackProjectChannelPrefix trialEndsAt trialStartsAt updatedAt urlKey } }",
  ],
  [
    "users",
    "query ($after: String) { users(first: 100, after: $after, includeArchived: true, includeDisabled: true) { nodes { __typename active admin app archivedAt avatarBackgroundColor avatarUrl calendarHash createdAt createdIssueCount description disableReason displayName email gitHubUserId guest hasGitHubCodeAccess id initials isAssignable isMe lastSeen name owner statusEmoji statusLabel statusUntilAt supportsAgentSessions timezone title updatedAt } pageInfo { hasNextPage endCursor } } }",
  ],
  [
    "teams",
    "query ($after: String) { teams(first: 100, after: $after, includeArchived: true) { nodes { __typename aiDiscussionSummariesEnabled aiThreadSummariesEnabled allMembersCanJoin archivedAt autoArchivePeriod autoCloseChildIssues autoCloseParentIssues autoClosePeriod autoCloseStateId color createdAt cycleCalenderUrl cycleCooldownTime cycleDuration cycleIssueAutoAssignCompleted cycleIssueAutoAssignStarted cycleLockToActive cycleStartDay cyclesEnabled defaultIssueEstimate defaultTemplateForMembersId defaultTemplateForNonMembersId description groupIssueHistory icon id inheritIssueEstimation inheritProjectStatuses inheritSlackAutoCreateProjectChannel inheritWorkflowStatuses initiativesEnabled issueCount issueEstimationAllowZero issueEstimationExtended issueEstimationType issueOrderingNoPriorityFirst issueSortOrderDefaultToBottom joinByDefault key name private protectedById requirePriorityToLeaveTriage restrictedById retiredAt scimGroupName scimManaged securitySettings setIssueSortOrderOnStateChange slackAutoCreateProjectChannel slackIssueComments slackIssueStatuses slackNewIssue timezone triageEnabled upcomingCycleCount updatedAt visibility parent { id } activeCycle { id } defaultIssueState { id } triageIssueState { id } markedAsDuplicateWorkflowState { id } members(first: 50) { nodes { id } pageInfo { hasNextPage endCursor } } } pageInfo { hasNextPage endCursor } } }",
  ],
  [
    "workflowStates",
    "query ($after: String) { workflowStates(first: 100, after: $after, includeArchived: true) { nodes { __typename archivedAt color createdAt description id name position type updatedAt team { id } } pageInfo { hasNextPage endCursor } } }",
  ],
  [
    "issueLabels",
    "query ($after: String) { issueLabels(first: 100, after: $after, includeArchived: true) { nodes { __typename archivedAt color createdAt description groupType id isGroup lastAppliedAt name retiredAt updatedAt team { id } parent { id } creator { id } retiredBy { id } } pageInfo { hasNextPage endCursor } } }",
  ],
  [
    "projectStatuses",
    "query ($after: String) { projectStatuses(first: 100, after: $after, includeArchived: true) { nodes { __typename archivedAt color createdAt description id indefinite name position type updatedAt } pageInfo { hasNextPage endCursor } } }",
  ],
  [
    "projects",
    "query ($after: String) { projects(first: 40, after: $after, includeArchived: true) { nodes { __typename archivedAt canceledAt color completedAt completedIssueCountHistory completedScopeHistory content createdAt description health healthUpdatedAt icon id identifier inProgressScopeHistory issueCountHistory leadTeamId name priority prioritySortOrder resourceCount scopeHistory slugId sortOrder startDate startDateResolution startedAt targetDate targetDateResolution trashed updatedAt creator { id } lead { id } leadTeam { id } status { id } teams(first: 50) { nodes { id } pageInfo { hasNextPage endCursor } } members(first: 50) { nodes { id } pageInfo { hasNextPage endCursor } } labels(first: 50) { nodes { id } pageInfo { hasNextPage endCursor } } } pageInfo { hasNextPage endCursor } } }",
  ],
  [
    "projectMilestones",
    "query ($after: String) { projectMilestones(first: 100, after: $after, includeArchived: true) { nodes { __typename archivedAt createdAt description id name sortOrder targetDate updatedAt project { id } } pageInfo { hasNextPage endCursor } } }",
  ],
  [
    "projectUpdates",
    "query ($after: String) { projectUpdates(first: 100, after: $after, includeArchived: true) { nodes { __typename archivedAt body commentCount createdAt diffMarkdown editedAt health id isDiffHidden slugId updatedAt project { id } user { id } } pageInfo { hasNextPage endCursor } } }",
  ],
  [
    "cycles",
    "query ($after: String) { cycles(first: 100, after: $after, includeArchived: true) { nodes { __typename archivedAt completedAt completedIssueCountHistory completedScopeHistory createdAt description endsAt id inProgressScopeHistory issueCountHistory name number scopeHistory startsAt updatedAt team { id } } pageInfo { hasNextPage endCursor } } }",
  ],
  [
    "initiatives",
    "query ($after: String) { initiatives(first: 60, after: $after, includeArchived: true) { nodes { __typename archivedAt canceledAt color completedAt content createdAt description health healthUpdatedAt icon id name priority prioritySortOrder slugId sortOrder startedAt status targetDate targetDateResolution trashed updatedAt creator { id } owner { id } parentInitiative { id } projects(first: 50) { nodes { id } pageInfo { hasNextPage endCursor } } labels(first: 50) { nodes { id } pageInfo { hasNextPage endCursor } } } pageInfo { hasNextPage endCursor } } }",
  ],
  [
    "issues",
    "query ($after: String) { issues(first: 60, after: $after, includeArchived: true) { nodes { __typename addedToCycleAt addedToProjectAt addedToTeamAt archivedAt branchName canceledAt completedAt createdAt customerTicketCount description dueDate estimate id identifier labelIds number previousIdentifiers priority prioritySortOrder sortOrder startedAt startedTriageAt subIssueSortOrder title trashed triagedAt updatedAt url team { id } state { id } assignee { id } creator { id } delegate { id } cycle { id } project { id } projectMilestone { id } parent { id } sourceComment { id } labels(first: 50) { nodes { id } pageInfo { hasNextPage endCursor } } subscribers(first: 50) { nodes { id } pageInfo { hasNextPage endCursor } } } pageInfo { hasNextPage endCursor } } }",
  ],
  [
    "issueRelations",
    "query ($after: String) { issueRelations(first: 100, after: $after, includeArchived: true) { nodes { __typename archivedAt createdAt id type updatedAt issue { id } relatedIssue { id } } pageInfo { hasNextPage endCursor } } }",
  ],
  [
    "comments",
    "query ($after: String) { comments(first: 100, after: $after, includeArchived: true) { nodes { __typename archivedAt body createdAt documentContentId editedAt id initiativeId initiativeUpdateId issueId parentId projectId projectUpdateId quotedText resolvedAt resolvingCommentId updatedAt url issue { id } parent { id } user { id } resolvingUser { id } project { id } projectUpdate { id } initiativeUpdate { id } initiative { id } } pageInfo { hasNextPage endCursor } } }",
  ],
  [
    "attachments",
    "query ($after: String) { attachments(first: 100, after: $after, includeArchived: true) { nodes { __typename archivedAt createdAt groupBySource id metadata source sourceType subtitle title updatedAt url creator { id } issue { id } } pageInfo { hasNextPage endCursor } } }",
  ],
  [
    "documents",
    "query ($after: String) { documents(first: 100, after: $after, includeArchived: true) { nodes { __typename archivedAt color content createdAt documentContentId icon id slugId sortOrder title trashed updatedAt creator { id } owner { id } updatedBy { id } project { id } initiative { id } team { id } issue { id } cycle { id } } pageInfo { hasNextPage endCursor } } }",
  ],
  [
    "customerStatuses",
    "query ($after: String) { customerStatuses(first: 100, after: $after, includeArchived: true) { nodes { __typename archivedAt color createdAt description displayName id name position updatedAt } pageInfo { hasNextPage endCursor } } }",
  ],
  [
    "customerTiers",
    "query ($after: String) { customerTiers(first: 100, after: $after, includeArchived: true) { nodes { __typename archivedAt color createdAt description displayName id name position updatedAt } pageInfo { hasNextPage endCursor } } }",
  ],
  [
    "customers",
    "query ($after: String) { customers(first: 100, after: $after, includeArchived: true) { nodes { __typename approximateNeedCount archivedAt createdAt domains externalIds id logoUrl mainSourceId name revenue size slackChannelId slugId updatedAt url owner { id } status { id } tier { id } } pageInfo { hasNextPage endCursor } } }",
  ],
  [
    "customerNeeds",
    "query ($after: String) { customerNeeds(first: 100, after: $after, includeArchived: true) { nodes { __typename archivedAt body content createdAt id priority updatedAt url customer { id } issue { id } project { id } creator { id } comment { id } attachment { id } originalIssue { id } } pageInfo { hasNextPage endCursor } } }",
  ],
];

/** The nested lists cut at 50 records, by record kind, and the root field that reads one record. */
const NESTED: Record<string, { owner: string; lists: string[] }> = {
  Team: { owner: "team", lists: ["members"] },
  Project: { owner: "project", lists: ["teams", "members", "labels"] },
  Initiative: { owner: "initiative", lists: ["projects", "labels"] },
  Issue: { owner: "issue", lists: ["labels", "subscribers"] },
};
const nestedQuery = (owner: string, list: string) =>
  `query ($id: String!, $after: String) { ${owner}(id: $id) { ${list}(first: 50, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } } }`;

/** Names the export never drops: the query's own structure. */
const STRUCTURE = new Set(["id", "__typename", "nodes", "pageInfo", "hasNextPage", "endCursor"]);
const GRAPHQL_NAME = /^[_A-Za-z][_0-9A-Za-z]{0,127}$/;

/** Linear's answer to one GraphQL request: its response body. */
export interface LinearAnswer {
  data?: unknown;
  errors?: unknown;
}
/** Sends one GraphQL request, waiting out rate limits and transient failures. */
export type LinearRequest = (
  query: string,
  variables: Record<string, string | null>,
) => Promise<LinearAnswer>;

function firstMessage(errors: unknown): string {
  const first: unknown = Array.isArray(errors) ? errors[0] : undefined;
  return isObject(first) && typeof first.message === "string" ? quote(first.message) : "an error";
}

function rateLimited(answer: unknown): boolean {
  return (
    isObject(answer) &&
    Array.isArray(answer.errors) &&
    answer.errors.some(
      (error) =>
        isObject(error) && isObject(error.extensions) && error.extensions.code === "RATELIMITED",
    )
  );
}

/** The wait a rate-limited answer asks for: Linear's reset instants (epoch milliseconds), else
 * `Retry-After`, else a minute. */
function linearWait(answer: Answer): number | undefined {
  if (answer.status !== 429 && !rateLimited(answer.body)) return undefined;
  const now = Date.now();
  const resets = ["x-ratelimit-requests-reset", "x-ratelimit-complexity-reset"]
    .map((name) => Number(answer.headers.get(name)))
    .filter((value) => Number.isFinite(value) && value > now);
  return resets.length
    ? Math.max(...resets) - now
    : (retryAfterMs(answer.headers) ?? RATE_LIMIT_WAIT_MS);
}

/** Linear's GraphQL API with the user's API key in the `Authorization` header. */
export function linearApi(apiKey: string, transport: Transport): LinearRequest {
  return async (query, variables) => {
    const { status, body } = await send(
      "Linear",
      {
        method: "POST",
        url: LINEAR_API_URL,
        headers: { authorization: apiKey, "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
      },
      transport,
      linearWait,
    );
    if (isObject(body) && ("data" in body || "errors" in body)) return body;
    throw new ExportError(
      status === 401 || status === 403
        ? `Linear refused the API key (HTTP ${status})`
        : `Linear answered HTTP ${status} without a GraphQL answer`,
    );
  };
}

/** The Linear connection a Composio connected account holds, through Composio's
 * `LINEAR_RUN_QUERY_OR_MUTATION` tool; the tool's `data` is Linear's response body. */
export function composioLinear(
  connection: { apiKey: string; userId: string; connectedAccountId: string },
  transport: Transport,
): LinearRequest {
  return async (query, variables) => {
    const { status, body } = await send(
      "Composio",
      {
        method: "POST",
        url: COMPOSIO_LINEAR_URL,
        headers: { "x-api-key": connection.apiKey, "content-type": "application/json" },
        body: JSON.stringify({
          connected_account_id: connection.connectedAccountId,
          user_id: connection.userId,
          version: "latest",
          arguments: { query_or_mutation: query, variables },
        }),
      },
      transport,
      (answer) =>
        answer.status === 429 || (isObject(answer.body) && rateLimited(answer.body.data))
          ? (retryAfterMs(answer.headers) ?? RATE_LIMIT_WAIT_MS)
          : undefined,
    );
    if (!isObject(body))
      throw new ExportError(`Composio answered HTTP ${status} without a tool result`);
    if (isObject(body.data) && ("data" in body.data || "errors" in body.data)) return body.data;
    if (status === 401 || status === 403)
      throw new ExportError(`Composio refused the API key (HTTP ${status})`);
    // A failed execution names its reason in `error`; the export reads it as Linear's.
    const reason = isObject(body.error) ? body.error.message : body.error;
    return {
      errors: [
        { message: typeof reason === "string" ? reason : `Composio answered HTTP ${status}` },
      ],
    };
  };
}

/** The fields a refusal names that the query holds and may lose: a field Linear does not know
 * (`Cannot query field "x"`), or the field an error's `path` ends at. */
function refusedFields(errors: unknown, query: string, root: string): string[] {
  if (!Array.isArray(errors)) return [];
  const names = new Set<string>();
  for (const error of errors) {
    if (!isObject(error)) continue;
    const unknown =
      typeof error.message === "string"
        ? /Cannot query field "([^"]+)"/.exec(error.message)?.[1]
        : undefined;
    const path = Array.isArray(error.path) ? error.path : [];
    const last: unknown = path.at(-1);
    for (const name of [unknown, path.length > 1 ? last : undefined])
      if (
        typeof name === "string" &&
        GRAPHQL_NAME.test(name) &&
        !STRUCTURE.has(name) &&
        name !== root
      )
        names.add(name);
  }
  return [...names].filter((name) => dropField(query, name) !== query);
}

/** The query without every selection of `name`: its arguments and sub-selection go with it. */
export function dropField(query: string, name: string): string {
  const field = new RegExp(`(?<=[\\s{])${name}(?=[\\s({}])`, "g");
  let out = "";
  let from = 0;
  for (const match of query.matchAll(field)) {
    if (match.index < from) continue;
    let end = match.index + name.length;
    for (const [open, close] of [
      ["(", ")"],
      ["{", "}"],
    ] as const) {
      let next = end;
      while (query[next] === " ") next++;
      if (query[next] !== open) continue;
      let depth = 0;
      for (; next < query.length; next++) {
        if (query[next] === open) depth++;
        else if (query[next] === close && --depth === 0) break;
      }
      end = next + 1;
    }
    out += query.slice(from, match.index).replace(/ $/, "");
    from = end;
  }
  return out + query.slice(from);
}

/** Exports every list the guide names, then completes each nested list cut at 50 records. */
export async function exportLinear(
  request: LinearRequest,
  report: { progress: (line: string) => void; warn: (line: string) => void },
): Promise<JsonObject[]> {
  /** One query's answer at `root`. A field Linear refuses is dropped from `state.query`, so
   * every later page of the list goes without it, and named once. */
  const read = async (
    state: { query: string; dropped: number },
    root: string,
    variables: Record<string, string | null>,
  ): Promise<unknown> => {
    for (;;) {
      const answer = await request(state.query, variables);
      const errors = Array.isArray(answer.errors) ? answer.errors : [];
      const data = isObject(answer.data) ? answer.data[root] : undefined;
      if (!errors.length && data !== undefined) return data;
      const refused = refusedFields(errors, state.query, root);
      if (!errors.length || !refused.length || state.dropped + refused.length > MAX_DROPPED_FIELDS)
        throw new ExportError(
          errors.length
            ? `Linear refused the ${root} query: ${firstMessage(errors)}`
            : `Linear's answer holds no ${root}`,
        );
      for (const name of refused) {
        state.query = dropField(state.query, name);
        report.warn(`Linear refused ${root}.${name} for this key; exporting ${root} without it.`);
      }
      state.dropped += refused.length;
    }
  };
  const pageOf = (value: unknown, where: string) => {
    if (!isObject(value) || !Array.isArray(value.nodes) || !isObject(value.pageInfo))
      throw new ExportError(`Linear's answer for ${where} is not a page`);
    const { hasNextPage, endCursor } = value.pageInfo;
    if (hasNextPage === true && typeof endCursor !== "string")
      throw new ExportError(`Linear's answer for ${where} has no cursor`);
    return {
      nodes: value.nodes as unknown[],
      next: hasNextPage === true ? (endCursor as string) : null,
    };
  };

  const records: JsonObject[] = [];
  for (const [root, query] of QUERIES) {
    const state = { query, dropped: 0 };
    let count = 0;
    if (root === "organization") {
      const organization = await read(state, root, {});
      if (!isObject(organization)) throw new ExportError("Linear's answer holds no organization");
      records.push(organization);
      count = 1;
    } else
      for (let after: string | null = null; ; ) {
        const page = pageOf(await read(state, root, { after }), root);
        for (const node of page.nodes) {
          if (!isObject(node)) throw new ExportError(`Linear's ${root} page holds a non-object`);
          records.push(node);
        }
        count += page.nodes.length;
        if (page.next === null) break;
        if (page.next === after)
          throw new ExportError(`Linear answered the same ${root} cursor twice`);
        after = page.next;
      }
    report.progress(`Linear: ${count} ${root}`);
  }

  let completed = 0;
  for (const record of records) {
    const nested = typeof record.__typename === "string" ? NESTED[record.__typename] : undefined;
    if (!nested || typeof record.id !== "string") continue;
    for (const list of nested.lists) {
      const held = record[list];
      if (!isObject(held) || !isObject(held.pageInfo) || held.pageInfo.hasNextPage !== true)
        continue;
      const nodes = Array.isArray(held.nodes) ? [...(held.nodes as unknown[])] : [];
      // A nested query selects nothing but its list, so no field of it may be dropped.
      const state = { query: nestedQuery(nested.owner, list), dropped: MAX_DROPPED_FIELDS };
      let cursor = held.pageInfo.endCursor;
      for (;;) {
        if (typeof cursor !== "string")
          throw new ExportError(`Linear's ${nested.owner} ${list} have no cursor`);
        const owner = await read(state, nested.owner, { id: record.id, after: cursor });
        const where = `${nested.owner} ${list}`;
        const page = pageOf(isObject(owner) ? owner[list] : undefined, where);
        nodes.push(...page.nodes);
        if (page.next === null) break;
        if (page.next === cursor)
          throw new ExportError(`Linear answered the same ${where} cursor twice`);
        cursor = page.next;
      }
      record[list] = { ...held, nodes, pageInfo: { ...held.pageInfo, hasNextPage: false } };
      completed++;
    }
  }
  if (completed) report.progress(`Linear: completed ${completed} nested lists past 50 records`);
  return records;
}
