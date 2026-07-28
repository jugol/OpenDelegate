import { randomBytes } from "node:crypto";

import {
  DiscordApiError,
  DiscordForumAdapter,
  FetchDiscordApiPort,
  WsDiscordGatewayPort,
  assertResponseReference,
  createDiscordTaskPort,
  type DiscordApiPort,
  type DiscordBotCredentialProvider,
  type DiscordClock,
  type DiscordFetch,
  type DiscordForumAdapterConfig,
  type DiscordGatewayConnectOptions,
  type DiscordGatewayConnection,
  type DiscordGatewayPort,
  type DiscordInteractionTokenVault,
  type DiscordInteractionTokenVaultEntry,
  type DiscordStateRepository,
  type DiscordTaskServicePort,
  type DiscordTaskState,
  type TaskChannelProjection,
} from "@opendelegate/discord-adapter";
import type { ManagedSecretStore } from "@opendelegate/secrets";
import { SqlDiscordStateRepository, type SqlMigrationMode } from "@opendelegate/storage-sql";

const DEFAULT_SYNCHRONIZATION_INTERVAL_MS = 2_000;
const MAXIMUM_DIAGNOSTICS = 200;
const DISCORD_INTERACTION_REFERENCE_PREFIX = "discord-interaction-ref:";
const DISCORD_INTERACTION_SECRET_PREFIX = "discord-interaction.";
const DISCORD_INTERACTION_TOKEN_LIFETIME_MS = 15 * 60_000;
const DISCORD_INTERACTION_RECORD_MAGIC = Buffer.from("ODDI1", "ascii");

export interface DiscordRuntimeStatus {
  readonly status: "ready" | "unavailable";
  readonly code:
    | "DISCORD_READY"
    | "DISCORD_RECONNECTING"
    | "DISCORD_STARTING"
    | "DISCORD_STOPPED"
    | "DISCORD_UNAVAILABLE";
}

export interface DiscordRuntimeDiagnostic {
  readonly event: string;
  readonly atMs: number;
  readonly code: string;
}

export interface DiscordProjectionTask {
  readonly taskId: string;
  readonly state: DiscordTaskState;
  readonly objective: string;
  readonly updatedAt: string;
  readonly messages: readonly {
    readonly messageId: string;
    readonly role: "owner" | "agent";
    readonly content: string;
    readonly occurredAt: string;
  }[];
  readonly events: readonly {
    readonly eventId: string;
    readonly type: string;
    readonly occurredAt: string;
    readonly streamVersion: number;
  }[];
}

export interface DiscordProjectionTaskPort {
  get(taskId: string): Promise<DiscordProjectionTask>;
}

export interface DiscordArtifactPresentationPort {
  forTask(taskId: string): Promise<NonNullable<TaskChannelProjection["artifact"]> | undefined>;
}

export interface DiscordRuntimeTaskServicePort
  extends DiscordTaskServicePort, DiscordProjectionTaskPort {}

export interface DiscordRuntimeScheduler {
  setTimeout(callback: () => void, delayMs: number): object;
  clearTimeout(handle: object): void;
}

export interface DiscordMainRuntimeOptions {
  readonly adapter: Pick<
    DiscordForumAdapter,
    | "close"
    | "createTaskThread"
    | "flushOutbox"
    | "publishTaskProjection"
    | "reconcilePending"
    | "start"
  >;
  readonly repository: Pick<DiscordStateRepository, "getGatewayCursor" | "listBindings">;
  readonly tasks: DiscordProjectionTaskPort;
  readonly artifactPresentation?: DiscordArtifactPresentationPort;
  readonly clock: DiscordClock;
  readonly scheduler?: DiscordRuntimeScheduler;
  readonly synchronizationIntervalMs?: number;
  readonly closeResource?: () => Promise<void>;
  readonly onStatusChange?: (status: DiscordRuntimeStatus) => void;
}

export type DiscordRuntimeDatabase =
  | {
      readonly adapter: "sqlite";
      readonly filename: string;
      readonly migrationMode?: SqlMigrationMode;
    }
  | {
      readonly adapter: "postgresql";
      readonly connectionString: string;
      readonly schema?: string;
      readonly migrationMode?: SqlMigrationMode;
    };

export interface CreateProductionDiscordRuntimeOptions {
  readonly config: DiscordForumAdapterConfig;
  readonly productVersion: string;
  readonly mainDeviceId: string;
  readonly botTokenAlias: string;
  readonly secretStore: ManagedSecretStore;
  readonly database: DiscordRuntimeDatabase;
  readonly tasks: DiscordRuntimeTaskServicePort;
  readonly clock?: DiscordClock;
  readonly scheduler?: DiscordRuntimeScheduler;
  readonly synchronizationIntervalMs?: number;
  readonly artifactPresentation?: DiscordArtifactPresentationPort;
  readonly interactionTokenVault?: DiscordInteractionTokenVault;
  readonly api?: DiscordApiPort;
  readonly gateway?: DiscordGatewayPort;
  readonly fetch?: DiscordFetch;
  readonly requestTimeoutMs?: number;
  readonly maximumResponseBytes?: number;
  readonly onStatusChange?: (status: DiscordRuntimeStatus) => void;
}

/**
 * Main-owned Discord supervisor.
 *
 * It deliberately treats Discord as a repairable external dependency: an
 * unavailable installation does not take down Admin Web or the durable Task
 * service. Every retry reuses the adapter's durable cursor/inbox/binding/outbox
 * state, and Task projections remain idempotent across process restart.
 */
export class DiscordMainRuntime {
  readonly #adapter: DiscordMainRuntimeOptions["adapter"];
  readonly #repository: DiscordMainRuntimeOptions["repository"];
  readonly #tasks: DiscordProjectionTaskPort;
  readonly #artifactPresentation: DiscordArtifactPresentationPort | undefined;
  readonly #clock: DiscordClock;
  readonly #scheduler: DiscordRuntimeScheduler;
  readonly #synchronizationIntervalMs: number;
  readonly #closeResource: (() => Promise<void>) | undefined;
  readonly #onStatusChange: ((status: DiscordRuntimeStatus) => void) | undefined;
  readonly #diagnostics: DiscordRuntimeDiagnostic[] = [];
  #status: DiscordRuntimeStatus = frozenStatus("unavailable", "DISCORD_STOPPED");
  #adapterStarted = false;
  #started = false;
  #closed = false;
  #requiresExplicitGatewayReady = false;
  #cursorAtConnectionStart: string | undefined;
  #cycle: Promise<void> | undefined;
  #timer: object | undefined;
  #closePromise: Promise<void> | undefined;

  public constructor(options: DiscordMainRuntimeOptions) {
    const synchronizationIntervalMs =
      options.synchronizationIntervalMs ?? DEFAULT_SYNCHRONIZATION_INTERVAL_MS;
    assertBoundedInteger(
      synchronizationIntervalMs,
      250,
      60_000,
      "Discord synchronization interval",
    );
    this.#adapter = options.adapter;
    this.#repository = options.repository;
    this.#tasks = options.tasks;
    this.#artifactPresentation = options.artifactPresentation;
    this.#clock = options.clock;
    this.#scheduler = options.scheduler ?? new NodeDiscordRuntimeScheduler();
    this.#synchronizationIntervalMs = synchronizationIntervalMs;
    this.#closeResource = options.closeResource;
    this.#onStatusChange = options.onStatusChange;
  }

  public get status(): DiscordRuntimeStatus {
    return this.#status;
  }

  public get diagnostics(): readonly DiscordRuntimeDiagnostic[] {
    return Object.freeze(this.#diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic })));
  }

  public async presentTask(taskId: string): Promise<void> {
    if (this.#status.code !== "DISCORD_READY") {
      throw new DiscordApiError("OFFLINE", "Discord is not ready to present a new Task.");
    }
    const task = await this.#tasks.get(taskId);
    let artifact: NonNullable<TaskChannelProjection["artifact"]> | undefined;
    if (this.#artifactPresentation !== undefined) {
      artifact = await this.#artifactPresentation.forTask(task.taskId);
    }
    await this.#adapter.createTaskThread(projectTask(task, artifact));
    await this.#adapter.flushOutbox();
  }

  public async start(): Promise<DiscordRuntimeStatus> {
    if (this.#closed) {
      return this.#status;
    }
    if (!this.#started) {
      this.#started = true;
      this.#setStatus("unavailable", "DISCORD_STARTING");
      await this.synchronizeNow();
      this.#schedule();
    }
    return this.#status;
  }

  public async synchronizeNow(): Promise<void> {
    if (this.#closed) {
      return;
    }
    if (this.#cycle === undefined) {
      this.#cycle = this.#synchronize().finally(() => {
        this.#cycle = undefined;
      });
    }
    await this.#cycle;
  }

  public close(): Promise<void> {
    if (this.#closePromise === undefined) {
      this.#closePromise = this.#close();
    }
    return this.#closePromise;
  }

  /**
   * Receives the redacted lifecycle signal emitted after a READY or RESUMED
   * dispatch has been durably checkpointed.
   */
  public observeGatewaySessionEstablished(): void {
    if (this.#closed) {
      return;
    }
    this.#requiresExplicitGatewayReady = false;
    this.#setStatus("ready", "DISCORD_READY");
  }

  /**
   * Receives event names only; Gateway fields can contain deployment metadata
   * and are deliberately not retained by the Main runtime.
   */
  public observeGatewayDiagnostic(event: string): void {
    if (this.#closed || !isGatewayUnavailableEvent(event)) {
      return;
    }
    this.#requiresExplicitGatewayReady = true;
    this.#recordDiagnostic(event, "GATEWAY_UNAVAILABLE");
    this.#setStatus(
      "unavailable",
      event === "discord.gateway.closed_terminal" ? "DISCORD_UNAVAILABLE" : "DISCORD_RECONNECTING",
    );
  }

  async #synchronize(): Promise<void> {
    try {
      if (!this.#adapterStarted) {
        const before = await this.#repository.getGatewayCursor();
        this.#cursorAtConnectionStart = cursorFingerprint(before);
        await this.#adapter.start();
        this.#adapterStarted = true;
      } else {
        await this.#adapter.reconcilePending();
      }

      const cursor = await this.#repository.getGatewayCursor();
      if (
        !this.#requiresExplicitGatewayReady &&
        cursor !== undefined &&
        cursorFingerprint(cursor) !== this.#cursorAtConnectionStart
      ) {
        this.#setStatus("ready", "DISCORD_READY");
      } else if (!this.#requiresExplicitGatewayReady && this.#status.code !== "DISCORD_READY") {
        this.#setStatus("unavailable", "DISCORD_STARTING");
      }

      await this.#publishCurrentTaskState();
      await this.#adapter.flushOutbox();
    } catch (error) {
      this.#adapterStarted = false;
      this.#recordDiagnostic("discord.runtime.synchronization_failed", errorCode(error));
      this.#setStatus("unavailable", "DISCORD_UNAVAILABLE");
      try {
        await this.#adapter.close();
      } catch {
        this.#recordDiagnostic("discord.runtime.failed_start_cleanup_failed", "CLOSE_FAILED");
      }
    }
  }

  async #publishCurrentTaskState(): Promise<void> {
    for (const binding of await this.#repository.listBindings()) {
      if (binding.externalState !== "available") {
        continue;
      }
      try {
        const task = await this.#tasks.get(binding.taskId);
        let artifact: NonNullable<TaskChannelProjection["artifact"]> | undefined;
        if (this.#artifactPresentation !== undefined) {
          try {
            artifact = await this.#artifactPresentation.forTask(task.taskId);
          } catch (error) {
            this.#recordDiagnostic("discord.runtime.artifact_projection_failed", errorCode(error));
          }
        }
        await this.#adapter.publishTaskProjection(projectTask(task, artifact));
      } catch (error) {
        this.#recordDiagnostic("discord.runtime.task_projection_failed", errorCode(error));
      }
    }
  }

  #schedule(): void {
    if (this.#closed || this.#timer !== undefined) {
      return;
    }
    this.#timer = this.#scheduler.setTimeout(() => {
      this.#timer = undefined;
      void this.synchronizeNow().finally(() => {
        this.#schedule();
      });
    }, this.#synchronizationIntervalMs);
  }

  async #close(): Promise<void> {
    this.#closed = true;
    if (this.#timer !== undefined) {
      this.#scheduler.clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    await this.#cycle?.catch(() => undefined);
    const failures: unknown[] = [];
    try {
      await this.#adapter.close();
    } catch (error) {
      failures.push(error);
    }
    if (this.#closeResource !== undefined) {
      try {
        await this.#closeResource();
      } catch (error) {
        failures.push(error);
      }
    }
    this.#setStatus("unavailable", "DISCORD_STOPPED");
    if (failures.length > 0) {
      throw new AggregateError(failures, "Discord runtime shutdown did not complete cleanly.");
    }
  }

  #setStatus(status: DiscordRuntimeStatus["status"], code: DiscordRuntimeStatus["code"]): void {
    if (this.#status.status === status && this.#status.code === code) {
      return;
    }
    this.#status = frozenStatus(status, code);
    try {
      this.#onStatusChange?.(this.#status);
    } catch {
      this.#recordDiagnostic("discord.runtime.status_observer_failed", "OBSERVER_FAILED");
    }
  }

  #recordDiagnostic(event: string, code: string): void {
    this.#diagnostics.push(
      Object.freeze({
        event,
        atMs: this.#clock.nowMs(),
        code,
      }),
    );
    if (this.#diagnostics.length > MAXIMUM_DIAGNOSTICS) {
      this.#diagnostics.shift();
    }
  }
}

export interface ManagedDiscordBotCredentialProviderOptions {
  readonly alias: string;
  readonly deviceId: string;
  readonly secretStore: ManagedSecretStore;
}

export interface ManagedDiscordInteractionTokenVaultOptions {
  readonly deviceId: string;
  readonly secretStore: ManagedSecretStore;
  readonly nowMs?: () => number;
  readonly createReference?: () => string;
}

interface StoredInteractionCredential {
  readonly applicationId: string;
  interactionToken: string;
  readonly expiresAtMs: number;
}

/**
 * Adapts the Device-local managed Secret Store to Discord's callback-scoped
 * credential contract. The token is never accepted from configuration or an
 * environment variable and never becomes a field on the HTTP/Gateway drivers.
 */
export class ManagedDiscordBotCredentialProvider implements DiscordBotCredentialProvider {
  readonly #alias: string;
  readonly #secretStore: ManagedSecretStore;

  public constructor(options: ManagedDiscordBotCredentialProviderOptions) {
    assertOpaqueIdentifier(options.alias, "Discord bot Secret alias");
    assertOpaqueIdentifier(options.deviceId, "Main Device ID");
    if (options.secretStore.deviceId !== options.deviceId) {
      throw new TypeError("The Discord bot Secret Store belongs to another Device.");
    }
    this.#alias = options.alias;
    this.#secretStore = options.secretStore;
  }

  public async withBotToken<TResult>(
    operation: (botToken: string) => Promise<TResult>,
  ): Promise<TResult> {
    let invoked = false;
    let result: TResult | undefined;
    let operationError: unknown;
    let operationFailed = false;
    let invalidCredential = false;
    try {
      await this.#secretStore.executeWithSecretBytes(this.#alias, async (material) => {
        try {
          const token = new TextDecoder("utf-8", { fatal: true }).decode(material);
          if (!isDiscordCredential(token)) {
            invalidCredential = true;
            return;
          }
          invoked = true;
          try {
            result = await operation(token);
          } catch (error) {
            operationFailed = true;
            operationError = error;
          }
        } catch {
          invalidCredential = true;
        }
      });
    } catch {
      if (operationFailed) {
        throw operationError;
      }
      throw credentialUnavailable();
    }
    if (operationFailed) {
      throw operationError;
    }
    if (!invoked || invalidCredential) {
      throw credentialUnavailable();
    }
    return result as TResult;
  }
}

/**
 * Keeps the short-lived interaction follow-up credential in the Main Device's
 * managed Secret Store. Only the opaque response reference enters SQL state, so a
 * Main restart can finish an already-deferred interaction without persisting its
 * raw token in the database.
 */
export class ManagedDiscordInteractionTokenVault implements DiscordInteractionTokenVault {
  readonly #secretStore: ManagedSecretStore;
  readonly #nowMs: () => number;
  readonly #createReference: () => string;

  public constructor(options: ManagedDiscordInteractionTokenVaultOptions) {
    assertOpaqueIdentifier(options.deviceId, "Main Device ID");
    if (options.secretStore.deviceId !== options.deviceId) {
      throw new TypeError("The Discord interaction Secret Store belongs to another Device.");
    }
    this.#secretStore = options.secretStore;
    this.#nowMs = options.nowMs ?? Date.now;
    this.#createReference =
      options.createReference ??
      (() => `${DISCORD_INTERACTION_REFERENCE_PREFIX}${randomBytes(24).toString("base64url")}`);
  }

  public async store(
    input: DiscordInteractionTokenVaultEntry & { readonly lifetimeMs: number },
  ): Promise<{ readonly responseRef: string }> {
    assertSnowflake(input.applicationId, "Discord Application ID");
    if (!isDiscordCredential(input.interactionToken)) {
      throw credentialUnavailable();
    }
    if (
      !Number.isSafeInteger(input.lifetimeMs) ||
      input.lifetimeMs < 1 ||
      input.lifetimeMs > DISCORD_INTERACTION_TOKEN_LIFETIME_MS
    ) {
      throw new DiscordApiError(
        "INVALID_RESPONSE",
        "The Discord interaction credential lifetime is invalid.",
      );
    }
    const nowMs = this.#nowMs();
    assertTimestamp(nowMs, "Discord interaction Secret clock");
    const expiresAtMs = nowMs + input.lifetimeMs;
    if (!Number.isSafeInteger(expiresAtMs)) {
      throw new DiscordApiError(
        "INVALID_RESPONSE",
        "The Discord interaction credential expiry is invalid.",
      );
    }
    const responseRef = this.#createReference();
    assertResponseReference(responseRef);
    const material = encodeInteractionCredential({
      applicationId: input.applicationId,
      interactionToken: input.interactionToken,
      expiresAtMs,
    });
    try {
      await this.#secretStore.store(interactionSecretAlias(responseRef), material);
    } finally {
      material.fill(0);
    }
    return Object.freeze({ responseRef });
  }

  public async use<TResult>(
    responseRef: string,
    operation: (entry: DiscordInteractionTokenVaultEntry) => Promise<TResult>,
  ): Promise<{ readonly found: false } | { readonly found: true; readonly value: TResult }> {
    assertResponseReference(responseRef);
    const alias = interactionSecretAlias(responseRef);
    if (!(await this.#secretStore.availability(alias)).ready) {
      return Object.freeze({ found: false as const });
    }
    const nowMs = this.#nowMs();
    assertTimestamp(nowMs, "Discord interaction Secret clock");
    let invoked = false;
    let expired = false;
    let result: TResult | undefined;
    let operationError: unknown;
    let operationFailed = false;
    let invalidRecord = false;
    try {
      await this.#secretStore.executeWithSecretBytes(alias, async (material) => {
        let entry: StoredInteractionCredential;
        try {
          entry = decodeInteractionCredential(material);
        } catch {
          invalidRecord = true;
          return;
        }
        if (entry.expiresAtMs <= nowMs) {
          expired = true;
          return;
        }
        invoked = true;
        try {
          result = await operation({
            applicationId: entry.applicationId,
            interactionToken: entry.interactionToken,
          });
        } catch (error) {
          operationFailed = true;
          operationError = error;
        } finally {
          entry.interactionToken = "";
        }
      });
    } catch {
      if (operationFailed) {
        throw operationError;
      }
      throw new DiscordApiError("OFFLINE", "The Discord interaction credential is unavailable.");
    }
    if (operationFailed) {
      throw operationError;
    }
    if (invalidRecord) {
      throw new DiscordApiError(
        "INVALID_RESPONSE",
        "The Discord interaction credential record is invalid.",
      );
    }
    if (expired) {
      await this.#secretStore.delete(alias);
      return Object.freeze({ found: false as const });
    }
    if (!invoked) {
      throw new DiscordApiError("OFFLINE", "The Discord interaction credential is unavailable.");
    }
    await this.#secretStore.delete(alias);
    return Object.freeze({ found: true as const, value: result as TResult });
  }
}

/**
 * Builds the reviewed production Discord path: platform-managed credential scope,
 * API v10 HTTP, supervised Gateway WebSocket, durable SQL channel state, the
 * channel-neutral Task port, and the Main-owned runtime supervisor.
 *
 * The optional HTTP/Gateway ports are explicit external-boundary substitutions for
 * deterministic acceptance tests. Production callers omit them.
 */
export async function createProductionDiscordRuntime(
  options: CreateProductionDiscordRuntimeOptions,
): Promise<DiscordMainRuntime> {
  const clock = options.clock ?? new SystemDiscordClock();
  const repository =
    options.database.adapter === "sqlite"
      ? await SqlDiscordStateRepository.openSqlite({
          filename: options.database.filename,
          migrationMode: options.database.migrationMode ?? "verify",
        })
      : await SqlDiscordStateRepository.openPostgres({
          connectionString: options.database.connectionString,
          migrationMode: options.database.migrationMode ?? "verify",
          ...(options.database.schema === undefined ? {} : { schema: options.database.schema }),
        });
  try {
    const credentialProvider = new ManagedDiscordBotCredentialProvider({
      alias: options.botTokenAlias,
      deviceId: options.mainDeviceId,
      secretStore: options.secretStore,
    });
    const interactionTokenVault =
      options.interactionTokenVault ??
      new ManagedDiscordInteractionTokenVault({
        deviceId: options.mainDeviceId,
        secretStore: options.secretStore,
      });
    const api =
      options.api ??
      new FetchDiscordApiPort({
        applicationId: options.config.applicationId,
        productVersion: options.productVersion,
        credentialProvider,
        interactionTokenVault,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.requestTimeoutMs === undefined
          ? {}
          : { requestTimeoutMs: options.requestTimeoutMs }),
        ...(options.maximumResponseBytes === undefined
          ? {}
          : { maximumResponseBytes: options.maximumResponseBytes }),
      });
    const runtimeReference: { current?: DiscordMainRuntime } = {};
    const gatewayDriver =
      options.gateway ??
      new WsDiscordGatewayPort({
        credentialProvider,
        discovery:
          api instanceof FetchDiscordApiPort
            ? api
            : {
                getGatewayBotUrl: async () => {
                  throw new DiscordApiError(
                    "OFFLINE",
                    "The injected Discord API port has no Gateway discovery boundary.",
                  );
                },
              },
        onDiagnostic: (diagnostic) => {
          runtimeReference.current?.observeGatewayDiagnostic(diagnostic.event);
        },
      });
    const gateway = new ObservedDiscordGatewayPort(gatewayDriver, () => {
      runtimeReference.current?.observeGatewaySessionEstablished();
    });
    const adapter = new DiscordForumAdapter({
      config: options.config,
      repository,
      api,
      tasks: createDiscordTaskPort(options.tasks),
      clock,
      gateway,
    });
    const runtime = new DiscordMainRuntime({
      adapter,
      repository,
      tasks: options.tasks,
      ...(options.artifactPresentation === undefined
        ? {}
        : { artifactPresentation: options.artifactPresentation }),
      clock,
      closeResource: async () => repository.close(),
      ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
      ...(options.synchronizationIntervalMs === undefined
        ? {}
        : { synchronizationIntervalMs: options.synchronizationIntervalMs }),
      ...(options.onStatusChange === undefined ? {} : { onStatusChange: options.onStatusChange }),
    });
    runtimeReference.current = runtime;
    return runtime;
  } catch (error) {
    try {
      await repository.close();
    } catch {
      // Preserve the primary composition failure.
    }
    throw error;
  }
}

function projectTask(
  task: DiscordProjectionTask,
  artifact?: NonNullable<TaskChannelProjection["artifact"]>,
): TaskChannelProjection {
  const latestEvent = task.events.at(-1);
  const latestMessage = task.messages.at(-1);
  const currentAgentMessage =
    latestMessage?.role === "agent" && latestMessage.messageId === latestEvent?.eventId
      ? latestMessage.content
      : undefined;
  const executionUpdate = latestEvent?.type === "task.execution-recorded";
  return Object.freeze({
    taskId: task.taskId,
    ...(latestEvent === undefined ? {} : { sourceEventId: latestEvent.eventId }),
    state: task.state,
    objective: task.objective,
    summary: currentAgentMessage ?? stateSummary(task.state),
    significance: executionUpdate ? significanceFor(task.state) : "status",
    ...(artifact === undefined ? {} : { artifact: Object.freeze({ ...artifact }) }),
  });
}

function significanceFor(state: DiscordTaskState): TaskChannelProjection["significance"] {
  switch (state) {
    case "waiting_user":
      return "question";
    case "failed":
      return "failure";
    case "completed":
      return "final";
    case "review":
      return "decision";
    default:
      return "status";
  }
}

function stateSummary(state: DiscordTaskState): string {
  switch (state) {
    case "intake":
      return "OpenDelegate is reading this Task.";
    case "queued":
      return "This Task is queued for eligible capacity.";
    case "running":
      return "OpenDelegate is working on this Task.";
    case "waiting_user":
      return "This Task is waiting for owner input.";
    case "waiting_resource":
      return "This Task is waiting for an eligible resource.";
    case "review":
      return "This Task is ready for review.";
    case "completed":
      return "This Task is complete.";
    case "failed":
      return "This Task needs attention before it can continue.";
    case "paused":
      return "This Task is paused.";
    case "cancelled":
      return "This Task was cancelled.";
  }
}

function cursorFingerprint(
  cursor:
    | {
        readonly sessionId: string;
        readonly resumeGatewayUrl: string;
        readonly sequence: number;
        readonly updatedAtMs: number;
      }
    | undefined,
): string | undefined {
  return cursor === undefined
    ? undefined
    : JSON.stringify([
        cursor.sessionId,
        cursor.resumeGatewayUrl,
        cursor.sequence,
        cursor.updatedAtMs,
      ]);
}

function encodeInteractionCredential(input: StoredInteractionCredential): Buffer {
  const applicationId = Buffer.from(input.applicationId, "ascii");
  const interactionToken = Buffer.from(input.interactionToken, "ascii");
  try {
    const material = Buffer.alloc(
      DISCORD_INTERACTION_RECORD_MAGIC.byteLength +
        8 +
        1 +
        2 +
        applicationId.byteLength +
        interactionToken.byteLength,
    );
    let offset = 0;
    DISCORD_INTERACTION_RECORD_MAGIC.copy(material, offset);
    offset += DISCORD_INTERACTION_RECORD_MAGIC.byteLength;
    material.writeBigUInt64BE(BigInt(input.expiresAtMs), offset);
    offset += 8;
    material.writeUInt8(applicationId.byteLength, offset);
    offset += 1;
    material.writeUInt16BE(interactionToken.byteLength, offset);
    offset += 2;
    applicationId.copy(material, offset);
    offset += applicationId.byteLength;
    interactionToken.copy(material, offset);
    return material;
  } finally {
    applicationId.fill(0);
    interactionToken.fill(0);
  }
}

function decodeInteractionCredential(material: Uint8Array): StoredInteractionCredential {
  const minimumLength = DISCORD_INTERACTION_RECORD_MAGIC.byteLength + 8 + 1 + 2;
  const view = Buffer.from(material.buffer, material.byteOffset, material.byteLength);
  if (
    view.byteLength < minimumLength ||
    !view
      .subarray(0, DISCORD_INTERACTION_RECORD_MAGIC.byteLength)
      .equals(DISCORD_INTERACTION_RECORD_MAGIC)
  ) {
    throw new TypeError("Invalid Discord interaction credential record.");
  }
  let offset = DISCORD_INTERACTION_RECORD_MAGIC.byteLength;
  const expiresAtValue = view.readBigUInt64BE(offset);
  offset += 8;
  if (expiresAtValue > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError("Invalid Discord interaction credential expiry.");
  }
  const applicationIdLength = view.readUInt8(offset);
  offset += 1;
  const interactionTokenLength = view.readUInt16BE(offset);
  offset += 2;
  if (
    applicationIdLength < 17 ||
    applicationIdLength > 20 ||
    interactionTokenLength < 1 ||
    interactionTokenLength > 4_096 ||
    offset + applicationIdLength + interactionTokenLength !== view.byteLength
  ) {
    throw new TypeError("Invalid Discord interaction credential lengths.");
  }
  const applicationId = new TextDecoder("ascii", { fatal: true }).decode(
    view.subarray(offset, offset + applicationIdLength),
  );
  offset += applicationIdLength;
  const interactionToken = new TextDecoder("ascii", { fatal: true }).decode(
    view.subarray(offset, offset + interactionTokenLength),
  );
  assertSnowflake(applicationId, "Discord Application ID");
  if (!isDiscordCredential(interactionToken)) {
    throw new TypeError("Invalid Discord interaction credential.");
  }
  return {
    applicationId,
    interactionToken,
    expiresAtMs: Number(expiresAtValue),
  };
}

function interactionSecretAlias(responseRef: string): string {
  const suffix = responseRef.slice(DISCORD_INTERACTION_REFERENCE_PREFIX.length);
  if (suffix.length < 1 || suffix.length > 128 || !/^[A-Za-z0-9_-]+$/u.test(suffix)) {
    throw new TypeError("The Discord interaction response reference is invalid.");
  }
  return `${DISCORD_INTERACTION_SECRET_PREFIX}${suffix}`;
}

function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{1,95}$/u.test(error.code)
  ) {
    return error.code;
  }
  return "DEPENDENCY_UNAVAILABLE";
}

function isGatewayUnavailableEvent(event: string): boolean {
  return (
    event === "discord.gateway.closed_reconnecting" ||
    event === "discord.gateway.closed_terminal" ||
    event === "discord.gateway.credential_unavailable" ||
    event === "discord.gateway.dispatch_failed" ||
    event === "discord.gateway.frame_too_large" ||
    event === "discord.gateway.heartbeat_ack_timeout" ||
    event === "discord.gateway.invalid_payload" ||
    event === "discord.gateway.invalid_session_reconnect" ||
    event === "discord.gateway.reconnect_failed" ||
    event === "discord.gateway.server_requested_reconnect" ||
    event === "discord.gateway.socket_error"
  );
}

function frozenStatus(
  status: DiscordRuntimeStatus["status"],
  code: DiscordRuntimeStatus["code"],
): DiscordRuntimeStatus {
  return Object.freeze({ status, code });
}

function assertBoundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} is invalid.`);
  }
}

function assertOpaqueIdentifier(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 160 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
}

function assertSnowflake(value: string, label: string): void {
  if (!/^[0-9]{17,20}$/u.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
}

function assertTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} is invalid.`);
  }
}

function isDiscordCredential(value: string): boolean {
  return value.length >= 1 && value.length <= 4_096 && /^[\x21-\x7e]+$/u.test(value);
}

function credentialUnavailable(): DiscordApiError {
  return new DiscordApiError("OFFLINE", "The Discord bot credential is unavailable.");
}

class NodeDiscordRuntimeScheduler implements DiscordRuntimeScheduler {
  public setTimeout(callback: () => void, delayMs: number): object {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return timer;
  }

  public clearTimeout(handle: object): void {
    clearTimeout(handle as NodeJS.Timeout);
  }
}

class ObservedDiscordGatewayPort implements DiscordGatewayPort {
  readonly #delegate: DiscordGatewayPort;
  readonly #onSessionEstablished: () => void;

  public constructor(delegate: DiscordGatewayPort, onSessionEstablished: () => void) {
    this.#delegate = delegate;
    this.#onSessionEstablished = onSessionEstablished;
  }

  public connect(options: DiscordGatewayConnectOptions): Promise<DiscordGatewayConnection> {
    return this.#delegate.connect({
      ...options,
      onSessionEstablished: async (session) => {
        await options.onSessionEstablished(session);
        this.#onSessionEstablished();
      },
    });
  }
}

class SystemDiscordClock implements DiscordClock {
  public nowMs(): number {
    return Date.now();
  }
}
