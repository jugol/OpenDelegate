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

export interface TaskDetail extends TaskSummary {
  readonly completionCriteria: readonly string[];
  readonly constraints: readonly string[];
  readonly selectedInputRefs: readonly string[];
  readonly events: readonly TaskEventSummary[];
}

export interface CreateTaskInput {
  readonly objective: string;
  readonly completionCriteria: readonly string[];
  readonly constraints: readonly string[];
  readonly mode: "auto" | "manual";
}

export interface RecoveryResult {
  readonly ownerId: string;
  readonly recoveryCodes: readonly string[];
}

export interface RuntimeFeatures {
  readonly releaseChannel: "development" | "internal-preview" | "release-candidate" | "released";
  readonly taskExecution: RuntimeFeature;
  readonly configurationAgent: RuntimeFeature;
  readonly discord: RuntimeFeature;
}

export interface RuntimeFeature {
  readonly status: "ready" | "unavailable";
  readonly code: string;
}

export interface AdminApi {
  session(): Promise<OwnerSession>;
  login(passphrase: string): Promise<OwnerSession>;
  beginRecovery(recoveryCode: string): Promise<{ readonly recoveryToken: string }>;
  completeRecovery(recoveryToken: string, newPassphrase: string): Promise<RecoveryResult>;
  listDevices(): Promise<readonly DeviceSummary[]>;
  runtimeFeatures(): Promise<RuntimeFeatures>;
  listTasks(): Promise<readonly TaskSummary[]>;
  getTask(taskId: string): Promise<TaskDetail>;
  createTask(input: CreateTaskInput): Promise<TaskDetail>;
  commandTask(
    taskId: string,
    command: "pause" | "resume" | "cancel" | "retry",
  ): Promise<TaskDetail>;
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

  async runtimeFeatures(): Promise<RuntimeFeatures> {
    return this.#request("/api/v1/runtime/features");
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
