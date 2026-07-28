export type TaskState =
  | "intake"
  | "queued"
  | "waiting_user"
  | "waiting_resource"
  | "running"
  | "review"
  | "completed"
  | "failed"
  | "paused"
  | "cancelled";

export interface OwnerSession {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly createdAt: string;
  readonly authenticatedAt: string;
  readonly lastUsedAt: string;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
}

export interface DeviceSummary {
  readonly deviceId: string;
  readonly name: string;
  readonly osFamily: "macos" | "windows" | "linux";
  readonly platformRelease: string;
  readonly architecture: string;
  readonly role: "main" | "worker";
  readonly connection: "online" | "offline";
  readonly runtime: "healthy" | "degraded" | "unavailable";
  readonly serviceMode: "foreground" | "system-service" | "user-service";
  readonly lastObservation?: {
    readonly observedAtMs: number;
    readonly acceptedAtMs: number;
    readonly source: "authenticated-heartbeat" | "local-assessment";
  };
  readonly roles?: readonly string[];
  readonly instructions?: readonly string[];
  readonly facts?: readonly {
    readonly kind:
      | "os-family"
      | "platform-release"
      | "architecture"
      | "hostname"
      | "cpu-model"
      | "cpu-logical-cores"
      | "memory-total-bytes"
      | "gpu-model";
    readonly value: string;
    readonly source: "enrollment" | "authenticated-heartbeat" | "node-os" | "platform-probe";
    readonly observedAtMs: number;
    readonly verification: "observed" | "verified";
  }[];
  readonly capabilities?: readonly {
    readonly name: string;
    readonly verification: "detected" | "verified" | "degraded" | "unavailable" | "disabled";
    readonly observedAtMs?: number;
    readonly evidenceSource?: "agent-adapter" | "capability-probe" | "workspace-registry";
    readonly version?: string;
  }[];
  readonly policies?: readonly {
    readonly policyId: string;
    readonly actionCategory: string;
    readonly decision: "allow" | "require-approval" | "deny";
    readonly source: "built-in" | "configuration";
    readonly effectiveScope: "instance" | "main" | "device";
  }[];
  readonly agentAdapters?: readonly {
    readonly provider: "codex" | "claude" | "generic-command";
    readonly adapterId: string;
    readonly readiness: "ready" | "degraded" | "unavailable";
    readonly compatibility: "tested" | "compatible" | "untested" | "incompatible";
    readonly version?: string;
    readonly observedAtMs: number;
  }[];
  readonly routes?: readonly {
    readonly routeId: string;
    readonly label: string;
    readonly priority: number;
    readonly kind?: "https" | "wss";
    readonly profileRevision?: `sha256:${string}`;
    readonly health: "healthy" | "degraded" | "unhealthy" | "unknown";
    readonly lastAttempt?: {
      readonly probeSource: "cache" | "live" | "not-run";
      readonly outcome:
        | "authentication-rejected"
        | "connect-failed"
        | "connected"
        | "identity-rejected"
        | "probe-unhealthy"
        | "skipped-incompatible";
      readonly observedAtMs: number;
    };
  }[];
  readonly resourceLocks?: readonly {
    readonly resourceName: string;
    readonly capacity: number;
    readonly holders: readonly {
      readonly taskId: string;
      readonly runId: string;
      readonly expiresAtMs: number;
    }[];
  }[];
  readonly currentRuns?: readonly {
    readonly taskId: string;
    readonly workOrderId: string;
    readonly runId: string;
    readonly state: "starting" | "running" | "cancelling";
    readonly acceptedAtMs: number;
    readonly leaseExpiresAtMs: number;
  }[];
  readonly capacity?: {
    readonly activeRuns: number;
    readonly maximumConcurrentRuns: number;
    readonly acceptingWork: boolean;
    readonly maxOutboxEntries?: number;
    readonly outboxDepth?: number;
  };
  readonly knowledgeHealth?: "healthy" | "degraded" | "unavailable" | "unknown";
}

export interface TaskSummary {
  readonly taskId: string;
  readonly state: TaskState;
  readonly mode: "auto" | "manual";
  readonly objective: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface TaskEventSummary {
  readonly eventId: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly streamVersion: number;
}

export interface TaskConversationMessage {
  readonly messageId: string;
  readonly role: "owner" | "agent";
  readonly content: string;
  readonly occurredAt: string;
}

export interface TaskDetail extends TaskSummary {
  readonly completionCriteria: readonly string[];
  readonly constraints: readonly string[];
  readonly selectedInputRefs: readonly string[];
  readonly messages: readonly TaskConversationMessage[];
  readonly events: readonly TaskEventSummary[];
}

export type TaskBudgetMetric =
  | "wallTimeMs"
  | "idleTimeMs"
  | "retries"
  | "childWorkOrders"
  | "concurrentRuns"
  | "nativeTurns"
  | "tokens"
  | "costUsdMicros";

export interface TaskBudgetLimit {
  readonly soft?: number;
  readonly hard: number;
}

export interface TaskBudgetLimits {
  readonly wallTimeMs: TaskBudgetLimit;
  readonly idleTimeMs: TaskBudgetLimit;
  readonly retries: TaskBudgetLimit;
  readonly childWorkOrders: TaskBudgetLimit;
  readonly concurrentRuns: TaskBudgetLimit;
  readonly nativeTurns: TaskBudgetLimit;
  readonly tokens: TaskBudgetLimit;
  readonly costUsdMicros: TaskBudgetLimit;
}

export type TaskBudgetUsage = Readonly<Partial<Record<TaskBudgetMetric, number>>>;

export interface TaskBudgetSnapshot {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly kind: "requested" | "autonomous";
  readonly revision: number;
  readonly createdAt: string;
  readonly lastActivityAt: string;
  readonly limits: TaskBudgetLimits;
  readonly usage: TaskBudgetUsage;
  readonly workOrders: readonly {
    readonly workOrderId: string;
    readonly limits: TaskBudgetLimits;
    readonly usage: TaskBudgetUsage;
  }[];
  readonly activeRunIds: readonly string[];
  readonly limitEvents: readonly {
    readonly eventId: string;
    readonly metric: TaskBudgetMetric;
    readonly state: "soft-limit" | "hard-limit";
    readonly current: number;
    readonly hard: number;
    readonly attempted: number;
    readonly occurredAt: string;
    readonly workOrderId?: string;
  }[];
  readonly extensions: readonly {
    readonly eventId: string;
    readonly baseRevision: number;
    readonly revision: number;
    readonly occurredAt: string;
    readonly actorId: string;
    readonly limits: TaskBudgetLimits;
  }[];
  readonly omitted: {
    readonly workOrders: number;
    readonly activeRunIds: number;
    readonly limitEvents: number;
    readonly extensions: number;
  };
}

export interface CreateTaskInput {
  readonly objective: string;
  readonly completionCriteria: readonly string[];
  readonly constraints: readonly string[];
  readonly mode: "auto" | "manual";
}

export type EnrollmentGrantStatus = "active" | "consumed" | "expired" | "revoked";

export interface EnrollmentChannelEndpoint {
  readonly endpointId: string;
  readonly label: string;
  readonly kind: "wss";
  readonly url: string;
}

export interface EnrollmentGrantSummary {
  readonly grantId: string;
  readonly deviceId: string;
  readonly status: EnrollmentGrantStatus;
  readonly allowedBootstrapRoles: readonly string[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly consumedAt?: string;
}

export interface DeviceEnrollmentOverview {
  readonly available: boolean;
  readonly mainDeviceId?: string;
  readonly expectedMainSpkiSha256?: string;
  readonly enrollmentUrl?: string;
  readonly channelEndpoints?: readonly EnrollmentChannelEndpoint[];
  readonly grants: readonly EnrollmentGrantSummary[];
}

export interface EnrollmentGrantDocument {
  readonly schemaVersion: 1;
  readonly grantId: string;
  readonly token: string;
  readonly deviceId: string;
  readonly mainDeviceId: string;
  readonly expectedMainSpkiSha256: string;
  readonly certificateAuthorityPem: string;
  readonly enrollmentUrl: string;
  readonly channelEndpoints: readonly EnrollmentChannelEndpoint[];
  readonly protocolRange: {
    readonly minimum: number;
    readonly maximum: number;
  };
  readonly expiresAt: number;
}

export interface IssueEnrollmentGrantResult {
  readonly summary: EnrollmentGrantSummary;
  readonly suggestedFilename: string;
  readonly document: EnrollmentGrantDocument;
}

export type ArtifactState = "available" | "expired" | "revoked";
export type ArtifactExposureMode =
  "private-network" | "authenticated" | "signed-link" | "public" | "custom";

export interface ArtifactDetail {
  readonly artifactId: string;
  readonly taskId: string;
  readonly producingRunId: string;
  readonly mediaType: string;
  readonly originalFilename: string;
  readonly sizeBytes: number;
  readonly checksum: {
    readonly algorithm: "sha256";
    readonly value: string;
  };
  readonly createdAt: string;
  readonly retentionPolicy:
    | { readonly kind: "temporary"; readonly expiresAt: string }
    | { readonly kind: "task" }
    | { readonly kind: "pinned" };
  readonly exposurePolicy:
    | {
        readonly mode: Exclude<ArtifactExposureMode, "custom">;
      }
    | {
        readonly mode: "custom";
        readonly customPolicyId: string;
      };
  readonly provenance: {
    readonly deviceId: string;
    readonly source: string;
    readonly workspaceId?: string;
  };
  readonly presentation: "inline" | "download" | "static-html" | "interactive-html";
  readonly state: ArtifactState;
  readonly pinnedAt?: string;
  readonly revokedAt?: string;
  readonly expiredAt?: string;
}

export type ArtifactOpenInstruction =
  | {
      readonly method: "GET";
      readonly href: string;
      readonly artifactId: string;
      readonly expiresAt?: string;
    }
  | {
      readonly method: "POST";
      readonly actionUrl: string;
      readonly fieldName: "grant";
      readonly fieldValue: string;
      readonly artifactId: string;
      readonly expiresAt: string;
    };

export interface AuditEventSummary {
  readonly auditId: string;
  readonly source:
    | "task"
    | "artifact"
    | "action-authorization"
    | "device-identity"
    | "owner-auth"
    | "configuration"
    | "approval"
    | "runtime";
  readonly type: string;
  readonly occurredAt: string;
  readonly outcome: "succeeded" | "denied" | "failed" | "recorded";
  readonly actorId?: string;
  readonly subjectId?: string;
  readonly correlationId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly deviceId?: string;
  readonly artifactId?: string;
  readonly reasonCode?: string;
  readonly routeIncident?: {
    readonly incidentId: string;
    readonly fingerprint: string;
    readonly profileRevision: string;
    readonly recommendation: string;
    readonly ownerQuestion: string;
    readonly source: "agent" | "deterministic-fallback";
    readonly reasonCode: "AGENT_COMPLETED" | "AGENT_UNAVAILABLE" | "DIAGNOSIS_INTERRUPTED";
  };
}

export interface Readiness {
  readonly status: "ready" | "not-ready";
  readonly checks: readonly {
    readonly status: "ready" | "not-ready";
    readonly code: string;
  }[];
}

export type ApprovalState = "pending" | "approved" | "denied" | "expired";

export type ApprovalExecutionStatus = "waiting" | "running" | "succeeded" | "failed" | "skipped";

export type ApprovalRisk = "low" | "medium" | "high" | "critical";

export type ApprovalGrantScope = "once" | "task" | "device" | "policy";

export type ApprovalActionCategory =
  | "read-only-observation"
  | "opendelegate-process-retry"
  | "opendelegate-process-restart"
  | "project-dependency-install"
  | "configured-official-package-install"
  | "computer-use-input"
  | "package-repository-addition"
  | "remote-installer-script"
  | "untrusted-installer"
  | "driver-installation"
  | "kernel-extension-installation"
  | "os-network-change"
  | "vpn-change"
  | "firewall-change"
  | "policy-relaxation"
  | "secret-export"
  | "cross-device-knowledge-transfer"
  | "policy-bypass-attempt";

export interface ApprovalValuePreview {
  readonly present: boolean;
  readonly valueJson?: string;
}

export interface ApprovalConfigurationChange {
  readonly key: string;
  readonly scope: {
    readonly kind:
      | "instance"
      | "main"
      | "device"
      | "agent-adapter"
      | "transport"
      | "channel-binding"
      | "task-default"
      | "artifact";
    readonly id: string;
  };
  readonly before: ApprovalValuePreview;
  readonly after: ApprovalValuePreview;
}

export interface ApprovalDetail {
  readonly approvalId: string;
  readonly state: ApprovalState;
  readonly executionStatus: ApprovalExecutionStatus;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly action: {
    readonly category: ApprovalActionCategory;
    readonly type: string;
    readonly fingerprint: string;
    readonly targetDeviceId?: string;
    readonly taskId?: string;
    readonly resource: string;
  };
  readonly reason: string;
  readonly target: string;
  readonly risk: ApprovalRisk;
  readonly evidence: readonly string[];
  readonly configuration?: {
    readonly proposalId: string;
    readonly baseRevision: number;
    readonly changes: readonly ApprovalConfigurationChange[];
  };
  readonly decision?:
    | {
        readonly decision: "approve";
        readonly scope: ApprovalGrantScope;
        readonly decidedBy: string;
        readonly decidedAt: string;
      }
    | {
        readonly decision: "deny";
        readonly reason: string;
        readonly decidedBy: string;
        readonly decidedAt: string;
      };
  readonly executionErrorCode?: string;
}

export type ApprovalDecisionInput =
  | {
      readonly decision: "approve";
      readonly scope: ApprovalGrantScope;
    }
  | {
      readonly decision: "deny";
      readonly reason: string;
    };

export interface RecoveryResult {
  readonly ownerId: string;
  readonly recoveryCodes: readonly string[];
}

export type RuntimeReleaseIdentity =
  | {
      readonly declaredReleaseChannel: "development";
      readonly releaseChannel: "development";
      readonly releaseVerification: { readonly status: "not-applicable" };
    }
  | {
      readonly declaredReleaseChannel: "internal-preview";
      readonly releaseChannel: "internal-preview";
      readonly releaseVerification: { readonly status: "not-applicable" };
    }
  | {
      readonly declaredReleaseChannel: "release-candidate";
      readonly releaseChannel: "release-candidate";
      readonly releaseVerification:
        | { readonly status: "absent" | "publisher-verified" }
        | {
            readonly status: "invalid" | "promotion-invalid" | "revoked";
            readonly code: string;
          };
    }
  | {
      readonly declaredReleaseChannel: "release-candidate";
      readonly releaseChannel: "released";
      readonly releaseVerification: { readonly status: "released" };
    };

export type RuntimeFeatures = RuntimeReleaseIdentity & {
  readonly taskExecution: RuntimeFeature;
  readonly configurationAgent: RuntimeFeature;
  readonly discord: RuntimeFeature;
};

export interface RuntimeFeature {
  readonly status: "ready" | "unavailable";
  readonly code: string;
}

export type SecureSecretIngestPurpose =
  "api-token" | "database-uri" | "discord-bot-token" | "private-key" | "service-credential";

declare const mainSecretReferenceBrand: unique symbol;
declare const mainSecretAliasBrand: unique symbol;

export type MainSecretReference = string & {
  readonly [mainSecretReferenceBrand]: true;
};

export type MainSecretAlias = string & {
  readonly [mainSecretAliasBrand]: true;
};

export interface SecureSecretIngestReceipt {
  readonly schemaVersion: 1;
  readonly secretRef: MainSecretReference;
  readonly availability: "ready";
}

export function parseMainSecretReference(input: unknown): MainSecretReference {
  if (
    typeof input !== "string" ||
    !/^secret:\/\/main\/[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u.test(input)
  ) {
    throw invalidSecretIngestResponse();
  }
  return input as MainSecretReference;
}

export function mainSecretAlias(reference: MainSecretReference): MainSecretAlias {
  const match = /^secret:\/\/main\/([A-Za-z0-9][A-Za-z0-9._~-]{0,127})$/u.exec(reference);
  if (match?.[1] === undefined) {
    throw invalidSecretIngestResponse();
  }
  return match[1] as MainSecretAlias;
}

export interface AdminApi {
  session(): Promise<OwnerSession>;
  login(passphrase: string): Promise<OwnerSession>;
  beginRecovery(recoveryCode: string): Promise<{ readonly recoveryToken: string }>;
  completeRecovery(recoveryToken: string, newPassphrase: string): Promise<RecoveryResult>;
  listDevices(): Promise<readonly DeviceSummary[]>;
  assessDevice(deviceId: string): Promise<DeviceSummary>;
  runtimeFeatures(): Promise<RuntimeFeatures>;
  sendConfigurationMessage(deviceId: string, message: string): Promise<string>;
  ingestSecret(
    purpose: SecureSecretIngestPurpose,
    secret: Uint8Array,
  ): Promise<SecureSecretIngestReceipt>;
  listTasks(): Promise<readonly TaskSummary[]>;
  getTask(taskId: string): Promise<TaskDetail>;
  getTaskBudget(taskId: string): Promise<TaskBudgetSnapshot>;
  extendTaskBudget(
    taskId: string,
    baseRevision: number,
    limits: TaskBudgetLimits,
  ): Promise<TaskBudgetSnapshot>;
  createTask(input: CreateTaskInput): Promise<TaskDetail>;
  commandTask(
    taskId: string,
    command: "pause" | "resume" | "cancel" | "retry",
  ): Promise<TaskDetail>;
  listApprovals(): Promise<readonly ApprovalDetail[]>;
  getApproval(approvalId: string): Promise<ApprovalDetail>;
  decideApproval(approvalId: string, decision: ApprovalDecisionInput): Promise<ApprovalDetail>;
  deviceEnrollment(): Promise<DeviceEnrollmentOverview>;
  issueEnrollmentGrant(input: {
    readonly deviceId: string;
    readonly expiresInSeconds: number;
  }): Promise<IssueEnrollmentGrantResult>;
  listArtifacts(): Promise<readonly ArtifactDetail[]>;
  getArtifact(artifactId: string): Promise<ArtifactDetail>;
  openArtifact(artifactId: string): Promise<ArtifactOpenInstruction>;
  listAuditEvents(): Promise<readonly AuditEventSummary[]>;
  readiness(): Promise<Readiness>;
}

export class AdminApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AdminApiError";
    this.code = code;
    this.status = status;
  }
}

interface SessionResponse {
  readonly csrfToken: string;
  readonly session: OwnerSession;
}

export class BrowserAdminApi implements AdminApi {
  #csrfToken: string | undefined;

  async session(): Promise<OwnerSession> {
    const response = await this.#request<SessionResponse>("/api/v1/auth/session");
    this.#csrfToken = response.csrfToken;
    return response.session;
  }

  async login(passphrase: string): Promise<OwnerSession> {
    const response = await this.#request<SessionResponse>("/api/v1/auth/login", {
      body: { passphrase },
      method: "POST",
    });
    this.#csrfToken = response.csrfToken;
    return response.session;
  }

  async beginRecovery(recoveryCode: string): Promise<{ readonly recoveryToken: string }> {
    return this.#request("/api/v1/auth/recovery/begin", {
      body: { recoveryCode },
      method: "POST",
    });
  }

  async completeRecovery(recoveryToken: string, newPassphrase: string): Promise<RecoveryResult> {
    return this.#request("/api/v1/auth/recovery/complete", {
      body: { recoveryToken, newPassphrase },
      method: "POST",
    });
  }

  async listDevices(): Promise<readonly DeviceSummary[]> {
    const response = await this.#request<{ readonly devices: readonly DeviceSummary[] }>(
      "/api/v1/devices",
    );
    return response.devices;
  }

  async assessDevice(deviceId: string): Promise<DeviceSummary> {
    const response = await this.#authenticatedRequest<{ readonly device: DeviceSummary }>(
      `/api/v1/devices/${encodeURIComponent(deviceId)}/assessment`,
      {
        body: {},
        method: "POST",
      },
    );
    return response.device;
  }

  async runtimeFeatures(): Promise<RuntimeFeatures> {
    return this.#request("/api/v1/runtime/features");
  }

  async sendConfigurationMessage(deviceId: string, message: string): Promise<string> {
    const response = await this.#authenticatedRequest<{ readonly content: string }>(
      `/api/v1/devices/${encodeURIComponent(deviceId)}/configuration/messages`,
      {
        body: { message },
        method: "POST",
      },
    );
    return response.content;
  }

  async ingestSecret(
    purpose: SecureSecretIngestPurpose,
    secret: Uint8Array,
  ): Promise<SecureSecretIngestReceipt> {
    const maximumBytes = secureSecretMaximumBytes(purpose);
    if (
      !ArrayBuffer.isView(secret) ||
      !("BYTES_PER_ELEMENT" in secret) ||
      secret.BYTES_PER_ELEMENT !== 1 ||
      secret.byteLength === 0 ||
      secret.byteLength > maximumBytes
    ) {
      throw new AdminApiError(
        400,
        "SECRET_INGEST_INVALID",
        "The Secret material does not satisfy the selected secure-ingest purpose.",
      );
    }
    const material = new Uint8Array(secret.buffer, secret.byteOffset, secret.byteLength).slice();
    try {
      const receipt = await this.#authenticatedRequest<unknown>("/api/v1/secrets/ingest", {
        body: {
          purpose,
          secretBase64: encodeBase64(material),
        },
        method: "POST",
      });
      return asSecureSecretIngestReceipt(receipt);
    } finally {
      material.fill(0);
    }
  }

  async listTasks(): Promise<readonly TaskSummary[]> {
    const response = await this.#request<{ readonly tasks: readonly TaskSummary[] }>(
      "/api/v1/tasks",
    );
    return response.tasks;
  }

  async getTask(taskId: string): Promise<TaskDetail> {
    return this.#request(`/api/v1/tasks/${encodeURIComponent(taskId)}`);
  }

  async getTaskBudget(taskId: string): Promise<TaskBudgetSnapshot> {
    return this.#request(`/api/v1/tasks/${encodeURIComponent(taskId)}/budget`);
  }

  async extendTaskBudget(
    taskId: string,
    baseRevision: number,
    limits: TaskBudgetLimits,
  ): Promise<TaskBudgetSnapshot> {
    return this.#authenticatedRequest(
      `/api/v1/tasks/${encodeURIComponent(taskId)}/budget/extensions`,
      {
        body: {
          baseRevision,
          limits,
        },
        method: "POST",
      },
    );
  }

  async createTask(input: CreateTaskInput): Promise<TaskDetail> {
    return this.#authenticatedRequest("/api/v1/tasks", {
      body: {
        ...input,
        completionCriteria: [...input.completionCriteria],
        constraints: [...input.constraints],
        selectedInputRefs: [],
      },
      method: "POST",
    });
  }

  async commandTask(
    taskId: string,
    command: "pause" | "resume" | "cancel" | "retry",
  ): Promise<TaskDetail> {
    return this.#authenticatedRequest(`/api/v1/tasks/${encodeURIComponent(taskId)}/actions`, {
      body: { command },
      method: "POST",
    });
  }

  async listApprovals(): Promise<readonly ApprovalDetail[]> {
    const response = await this.#request<{ readonly approvals: readonly ApprovalDetail[] }>(
      "/api/v1/approvals",
    );
    return response.approvals;
  }

  async getApproval(approvalId: string): Promise<ApprovalDetail> {
    return this.#request(`/api/v1/approvals/${encodeURIComponent(approvalId)}`);
  }

  async decideApproval(
    approvalId: string,
    decision: ApprovalDecisionInput,
  ): Promise<ApprovalDetail> {
    return this.#authenticatedRequest(
      `/api/v1/approvals/${encodeURIComponent(approvalId)}/decision`,
      {
        body: decision,
        method: "POST",
      },
    );
  }

  async deviceEnrollment(): Promise<DeviceEnrollmentOverview> {
    return this.#request("/api/v1/device-enrollment");
  }

  async issueEnrollmentGrant(input: {
    readonly deviceId: string;
    readonly expiresInSeconds: number;
  }): Promise<IssueEnrollmentGrantResult> {
    return this.#authenticatedRequest("/api/v1/device-enrollment/grants", {
      body: input,
      method: "POST",
    });
  }

  async listArtifacts(): Promise<readonly ArtifactDetail[]> {
    const response = await this.#request<{ readonly artifacts: readonly ArtifactDetail[] }>(
      "/api/v1/artifacts",
    );
    return response.artifacts;
  }

  async getArtifact(artifactId: string): Promise<ArtifactDetail> {
    return this.#request(`/api/v1/artifacts/${encodeURIComponent(artifactId)}`);
  }

  async openArtifact(artifactId: string): Promise<ArtifactOpenInstruction> {
    return this.#authenticatedRequest(`/api/v1/artifacts/${encodeURIComponent(artifactId)}/open`, {
      body: {},
      method: "POST",
    });
  }

  async listAuditEvents(): Promise<readonly AuditEventSummary[]> {
    const response = await this.#request<{ readonly events: readonly AuditEventSummary[] }>(
      "/api/v1/audit-events",
    );
    return response.events;
  }

  async readiness(): Promise<Readiness> {
    return this.#request("/api/v1/readiness");
  }

  async #authenticatedRequest<TValue>(
    path: string,
    options: {
      readonly body: unknown;
      readonly method: "POST";
    },
  ): Promise<TValue> {
    if (this.#csrfToken === undefined) {
      await this.session();
    }
    const csrfToken = this.#csrfToken;
    if (csrfToken === undefined) {
      throw new AdminApiError(401, "AUTHENTICATION_REQUIRED", "Owner authentication is required.");
    }

    return this.#request(path, {
      ...options,
      csrfToken,
      idempotencyKey: createIdempotencyKey(),
    });
  }

  async #request<TValue>(
    path: string,
    options: {
      readonly body?: unknown;
      readonly csrfToken?: string;
      readonly idempotencyKey?: string;
      readonly method?: "GET" | "POST";
    } = {},
  ): Promise<TValue> {
    const headers = new Headers({
      Accept: "application/json",
      "Accept-Language":
        typeof document === "undefined" || document.documentElement.lang === ""
          ? "en"
          : document.documentElement.lang,
    });
    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    if (options.csrfToken !== undefined) {
      headers.set("x-opendelegate-csrf", options.csrfToken);
    }
    if (options.idempotencyKey !== undefined) {
      headers.set("Idempotency-Key", options.idempotencyKey);
    }

    const response = await fetch(path, {
      credentials: "same-origin",
      headers,
      method: options.method ?? "GET",
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    if (response.status === 401) {
      this.#csrfToken = undefined;
    }
    const payload = (await readJson(response)) as unknown;
    if (!response.ok) {
      const problem = asProblem(payload);
      throw new AdminApiError(
        response.status,
        problem.code,
        problem.detail ?? problem.title ?? "OpenDelegate could not complete this request.",
      );
    }
    return payload as TValue;
  }
}

function createIdempotencyKey(): string {
  return `admin-${crypto.randomUUID()}`;
}

function secureSecretMaximumBytes(purpose: SecureSecretIngestPurpose): number {
  switch (purpose) {
    case "database-uri":
      return 8 * 1024;
    case "api-token":
      return 16 * 1024;
    case "discord-bot-token":
      return 4 * 1024;
    case "private-key":
    case "service-credential":
      return 64 * 1024;
  }
}

function encodeBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  const maximumChunkBytes = 8 * 1024;
  for (let offset = 0; offset < bytes.byteLength; offset += maximumChunkBytes) {
    const chunk = bytes.subarray(offset, Math.min(offset + maximumChunkBytes, bytes.byteLength));
    chunks.push(String.fromCharCode(...chunk));
  }
  return btoa(chunks.join(""));
}

function asSecureSecretIngestReceipt(value: unknown): SecureSecretIngestReceipt {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 3
  ) {
    throw invalidSecretIngestResponse();
  }
  const record = value as Record<string, unknown>;
  if (record["schemaVersion"] !== 1 || record["availability"] !== "ready") {
    throw invalidSecretIngestResponse();
  }
  const secretRef = parseMainSecretReference(record["secretRef"]);
  return {
    schemaVersion: 1,
    secretRef: secretRef as MainSecretReference,
    availability: "ready",
  };
}

function invalidSecretIngestResponse(): AdminApiError {
  return new AdminApiError(
    502,
    "SECRET_INGEST_INVALID",
    "OpenDelegate returned an invalid secure-ingest receipt.",
  );
}

async function readJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!isJsonMediaType(contentType)) {
    throw unexpectedResponse(response.status);
  }
  try {
    return await response.json();
  } catch {
    throw unexpectedResponse(response.status);
  }
}

function isJsonMediaType(contentType: string): boolean {
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    mediaType === "application/json" ||
    /^application\/[!#$%&'*+\-.^_`|~0-9a-z]+\+json$/u.test(mediaType)
  );
}

function asProblem(value: unknown): {
  readonly code: string;
  readonly detail?: string;
  readonly title?: string;
} {
  if (typeof value !== "object" || value === null) {
    return { code: "REQUEST_FAILED" };
  }
  const record = value as Record<string, unknown>;
  const detail = asNonBlankString(record["detail"]);
  const title = asNonBlankString(record["title"]);
  return {
    code: typeof record["code"] === "string" ? record["code"] : "REQUEST_FAILED",
    ...(detail === undefined ? {} : { detail }),
    ...(title === undefined ? {} : { title }),
  };
}

function asNonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function unexpectedResponse(status: number): AdminApiError {
  return new AdminApiError(
    status,
    "UNEXPECTED_RESPONSE",
    "OpenDelegate returned an unexpected response.",
  );
}
