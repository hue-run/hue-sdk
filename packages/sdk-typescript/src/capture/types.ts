/** Portable JSON value; runtime validation rejects unsupported numbers, Unicode and structures. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
/** Immutable uploaded content reference. */
export type BlobRef = {
  /** Immutable artifact identity. */
  artifactId: string;
  /** SHA-256 digest of the source bytes. */
  sha256: string;
  /** Exact content size in bytes. */
  byteSize: number;
  /** Declared media type. */
  mimeType: string;
  /** Encoding of the referenced bytes. */
  encoding: "bytes" | "json" | "utf8";
};
/** Explicit content representation, including absent values and bounded streams. */
export type Payload =
  | {
      /** Discriminator for this record variant. */
      kind: "absent";
    }
  | {
      /** Discriminator for this record variant. */
      kind: "json";
      /** JSON content, including explicit null. */
      value: JsonValue;
    }
  | {
      /** Discriminator for this record variant. */
      kind: "bytes";
      /** Base64-encoded content bytes. */
      base64: string;
    }
  | {
      /** Discriminator for this record variant. */
      kind: "blob";
      /** Immutable blob reference. */
      ref: BlobRef;
    }
  | {
      /** Discriminator for this record variant. */
      kind: "stream";
      /** Ordered stream payloads. */
      items: Payload[];
    }
  | {
      /** Discriminator for this record variant. */
      kind: "http";
      /** HTTP response status code. */
      status: number;
      /** Optional HTTP status text. */
      statusText?: string;
      /** Selected headers permitted by capture policy. */
      headers: Record<string, string>;
      /** Credential-scrubbed HTTP URL. */
      url?: string;
      /** Captured response body. */
      body: Payload;
    };
/** Selected tool, MCP or HTTP boundary and its versioned contract. */
export type Binding = {
  /** Stable identity of this record. */
  id: string;
  /** Discriminator for this record variant. */
  kind: "tool" | "mcp" | "http";
  /** Declared operation contract version. */
  contractVersion: string;
  /** Explicitly selected operation contracts. */
  operations?: {
    /** Operation or source display name. */
    name: string;
    /** Human-readable operation description. */
    description?: string;
    /** Portable JSON Schema for operation arguments. */
    inputSchema: Record<string, JsonValue>;
    /** Discriminator for this record variant. */
    kind?: "tool" | "resource";
  }[];
  /** Selected HTTP origin, path and headers. */
  http?: {
    /** HTTP origin selected for capture. */
    origin: string;
    /** Selected path prefix. */
    pathPrefix: string;
    /** Selected headers permitted by capture policy. */
    headers?: string[];
  };
  /** Optional account scope for this binding. */
  accountScope?: string;
};
/** Provenance descriptor for an explicit artifact or tool source. */
export type Source = {
  /** Stable identity of this record. */
  id: string;
  /** Whether source evidence is complete, partial, a reference, or unavailable. */
  content: "complete" | "partial" | "reference_only" | "unavailable";
  /** Relationship between this source and the captured query or tool call. */
  relation: "query_attachment" | "tool_source";
  /** Immutable artifact identity. */
  artifactId?: string;
  /** Operation or source display name. */
  name?: string;
  /** Declared media type. */
  mimeType?: string;
  /** Exact content size in bytes. */
  byteSize?: number;
  /** SHA-256 digest of the source bytes. */
  sha256?: string;
  /** Source URI after capture redaction. */
  uri?: string;
  /** Identity linking this record to its observed call. */
  callId?: string;
  /** Caller-supplied source version. */
  sourceVersion?: string;
  /** Caller-owned portable source metadata. */
  metadata?: JsonValue;
};
/** One start or finish record for an observed live call. */
export type Observation = {
  /** Stable identity of this record. */
  id: string;
  /** Identity linking this record to its observed call. */
  callId: string;
  /** Identity of the producer that emitted this record. */
  producerId: string;
  /** Monotonically increasing producer sequence. */
  sequence: number;
  /** Boundary phase of the observation or state snapshot. */
  phase: "start" | "finish";
  /** Selected binding identity. */
  bindingId: string;
  /** Selected operation name. */
  operation: string;
  /** Declared operation contract version. */
  contractVersion: string;
  /** Canonical request hash binding arguments to their operation contract. */
  requestKey: string;
  /** Captured operation arguments. */
  arguments?: Payload;
  /** Optional causal parent call identity. */
  parentCallId?: string;
  /** Correlated OpenTelemetry span identity. */
  externalSpanId?: string;
  /** Observation timestamp in UTC. */
  at: string;
  /** Observed terminal outcome without retrying the live operation. */
  outcome?: "success" | "error" | "cancelled" | "incomplete";
  /** Captured live result. */
  result?: Payload;
  /** Bounded recorded error information. */
  error?: {
    /** Recorded error type. */
    type: string;
    /** Bounded human-readable explanation. */
    message?: string;
    /** Stable omission or error code. */
    code?: JsonValue;
  };
  /** Explicit source provenance records. */
  sources?: Source[];
  /** Whether the captured request/result remains eligible for reviewed replay. */
  replayable: boolean;
  /** Reason this evidence is incomplete or unsuitable for replay. */
  omissionReason?: string;
};
/** Producer sequence and incomplete-evidence counters at finalization. */
export type Producer = {
  /** Identity of the producer that emitted this record. */
  producerId: string;
  /** Last sequence emitted by this producer. */
  lastSequence: number;
  /** Number of queued records, open calls and uploads at the barrier. */
  pending: number;
  /** Cumulative records omitted or dropped by capture. */
  dropped: number;
};

/** Selected provider contracts and immutable world identity, without connection credentials. */
export type ProviderInterfaceEvidence = {
  /** Version of the captured provider interface. */
  schemaVersion: "gmail-provider/v1";
  /** Immutable provider configuration; never include runtime endpoints or bearers. */
  providerInstances: Record<string, JsonValue>[];
  /** Complete selected MCP tool contracts. */
  mcpTools: CaptureOperation[];
  /** Complete selected HTTP operation contracts. */
  restOperations: CaptureOperation[];
  /** Selected provider scopes. */
  scopes: string[];
  /** Immutable environment version. */
  environmentVersionId: string;
  /** Fresh world that was captured. */
  environmentRunId: string;
  /** Execution bound to that world. */
  executionId: string;
};
/** Portable operation schema recorded by an explicitly selected provider adapter. */
export type CaptureOperation = {
  /** Provider operation name. */
  name: string;
  /** Portable input JSON Schema. */
  inputSchema: Record<string, JsonValue>;
  /** Optional operation description. */
  description?: string;
  /** Portable output JSON Schema when supplied by the provider. */
  outputSchema?: Record<string, JsonValue>;
};
/** Explicit post-execution journal; never a substitute for an initial snapshot. */
export type ExecutionJournalEvidence = {
  /** Version of the environment journal. */
  schemaVersion: "hue.environment-journal/v1";
  /** Immutable environment version. */
  environmentVersionId: string;
  /** World whose acknowledged steps are recorded. */
  environmentRunId: string;
  /** Execution bound to that world. */
  executionId: string;
  /** Producer assertion that every committed step was captured. */
  complete: boolean;
  /** Authoritative world step count. */
  stepCount: number;
  /** Observed lifecycle status; open worlds remain incomplete evidence. */
  worldStatus: "open" | "completed" | "abandoned";
  /** Authoritative coverage assessment. */
  validity: "not_assessed" | "environment_incomplete";
  /** Authoritative gap record or explicit null. */
  coverageGap: JsonValue;
  /** Provider call inventory, separate from mutating world steps. */
  providerCalls: {
    /** Producer assertion that provider-call pagination was exhausted. */
    complete: boolean;
    /** Explicitly captured provider-call records after credential redaction. */
    items: Record<string, JsonValue>[];
  };
  /** Ordered acknowledged steps; their original ordinals and digests are preserved. */
  steps: {
    /** Immutable step identity. */
    id: string;
    /** Zero-based journal ordinal. */
    ordinal: number;
    /** Stable invocation identity. */
    invocationId: string;
    /** Executed action name. */
    action: string;
    /** Recorded action arguments. */
    args: Record<string, JsonValue>;
    /** Recorded world response. */
    observation: Record<string, JsonValue>;
    /** Committed entity effects. */
    effects: {
      /** Effect operation. */
      kind: "created" | "updated" | "deleted";
      /** Affected collection. */
      collection: string;
      /** Affected entity identity. */
      entityId: string;
      /** Affected field names. */
      fields: string[];
    }[];
    /** Whether this step changed world state. */
    mutated: boolean;
    /** Logical clock in nanoseconds. */
    clockNs: string;
    /** SHA-256 of the state after this step. */
    stateDigest: string;
  }[];
};
/** Explicit pre-execution state or a separately identified post-execution journal. */
export type StateEvidence = {
  /** Stable identity of this record. */
  id: string;
  /** Version of the portable capture protocol. */
  schemaVersion: "1";
  /** Versioned semantic adapter used to interpret state evidence. */
  adapter: "gmail@1" | "slack@1" | "gmail-provider@1";
  /** Discriminator for this record variant. */
  kind: "initial_snapshot" | "before_image" | "execution_journal";
  /** Service represented by this state evidence. */
  service: string;
  /** Captured account identity. */
  accountId: string;
  /** Actor identity within the captured service. */
  actorId: string;
  /** Optional resource identity for a before-image. */
  resourceId?: string;
  /** Causal boundary and completeness declaration. */
  boundary: {
    /** Boundary phase of the observation or state snapshot. */
    phase: "pre_execution" | "before_operation" | "after_execution";
    /** Identity linking this record to its observed call. */
    callId?: string;
    /** Collections declared complete at this boundary. */
    completeCollections: string[];
    /** Explicit gaps in this evidence. */
    omissions: string[];
  };
  /** Portable state captured before execution. */
  initialState?: JsonValue;
  /** Supported modeled action definitions. */
  actions?: JsonValue[];
  /** Required for a provider initial snapshot; runtime schema enforces the boundary. */
  providerInterface?: ProviderInterfaceEvidence;
  /** Required only for an execution_journal at the after_execution boundary. */
  journal?: ExecutionJournalEvidence;
  /** Other evidence identities required by this snapshot. */
  causalDependencies?: string[];
  /** Per-collection query coverage evidence. */
  coverage?: {
    /** Collection to which coverage applies. */
    collection: string;
    /** Portable query identifying the captured scope. */
    query?: JsonValue;
    /** Whether the declared query scope is complete. */
    complete: boolean;
    /** Unconsumed pagination cursor, or null when exhausted. */
    nextCursor?: string | null;
  }[];
};
/** A bounded explanation of missing or incomplete capture evidence. */
export type Omission = {
  /** Stable omission or error code. */
  code: string;
  /** Bounded human-readable explanation. */
  message: string;
};
/** Immutable finalized capture revision and its provenance. */
export type Manifest = {
  /** Version of the portable capture protocol. */
  schemaVersion: "1";
  /** Capture identity. */
  captureId: string;
  /** Owning project identity. */
  projectId: string;
  /** Immutable finalized capture revision. */
  revision: number;
  /** Correlated OpenTelemetry trace identity. */
  externalTraceId?: string;
  /** Optional application session identity. */
  sessionId?: string;
  /** Explicit captured task input. */
  input?: Payload;
  /** Source-content choice and redaction contract. */
  capturePolicy: {
    /** Explicit opt-in to source-content capture. */
    sourceContent: true;
    /** Version of the applied credential-redaction contract. */
    redactionVersion: string;
  };
  /** Selected versioned capture boundaries. */
  bindings: Binding[];
  /** Ordered call evidence included in this revision. */
  observations: Observation[];
  /** Explicit source provenance records. */
  sources: Source[];
  /** Producer sequence and completeness declarations. */
  producers: Producer[];
  /** Pre-execution snapshots and before-images. */
  stateEvidence: StateEvidence[];
  /** Explicit gaps in this evidence. */
  omissions: Omission[];
  /** Capture creation timestamp in UTC. */
  createdAt: string;
  /** Revision finalization timestamp in UTC. */
  finalizedAt: string;
};
