export const DISCORD_API_VERSION = 10;

export const DISCORD_GATEWAY_INTENTS = (1 << 0) | (1 << 9) | (1 << 15);

export const DISCORD_COMPONENTS_V2_FLAG = 1 << 15;

export type DiscordIntent = "GUILDS" | "GUILD_MESSAGES" | "MESSAGE_CONTENT";

export type DiscordPermission =
  | "VIEW_CHANNEL"
  | "READ_MESSAGE_HISTORY"
  | "SEND_MESSAGES"
  | "SEND_MESSAGES_IN_THREADS"
  | "ATTACH_FILES"
  | "MANAGE_THREADS";

export type DiscordWorkflowStatus = "intake" | "running" | "waiting" | "review" | "done" | "failed";

export type DiscordTaskState =
  | "intake"
  | "queued"
  | "running"
  | "waiting_user"
  | "waiting_resource"
  | "review"
  | "completed"
  | "failed"
  | "paused"
  | "cancelled";

export interface DiscordForumBindingConfig {
  readonly channelId: string;
  readonly workflowTagIds: Readonly<Record<DiscordWorkflowStatus, string>>;
}

export interface DiscordForumAdapterConfig {
  readonly applicationId: string;
  readonly botUserId: string;
  readonly guildId: string;
  readonly forumBindings: readonly DiscordForumBindingConfig[];
  readonly ownerUserIds: readonly string[];
  readonly allowedRoleIds: readonly string[];
}

export interface DiscordAuthor {
  readonly id: string;
  readonly bot: boolean;
  readonly roleIds: readonly string[];
}

export interface DiscordAttachmentReference {
  readonly id: string;
  readonly filename: string;
  readonly size: number;
  readonly mediaType?: string;
}

export interface DiscordMessage {
  readonly id: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly author: DiscordAuthor;
  readonly content: string;
  readonly attachments: readonly DiscordAttachmentReference[];
  readonly createdAtMs: number;
}

export interface DiscordThread {
  readonly id: string;
  readonly guildId: string;
  readonly parentId: string;
  readonly type: 11;
  readonly name: string;
  readonly ownerId: string;
  readonly appliedTagIds: readonly string[];
  readonly archived: boolean;
  readonly locked: boolean;
}

export interface DiscordInteraction {
  readonly id: string;
  readonly token: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly customId: string;
  readonly author: DiscordAuthor;
  readonly receivedAtMs: number;
}

interface DiscordGatewayDispatchBase {
  readonly sessionId: string;
  readonly resumeGatewayUrl: string;
  readonly sequence: number;
}

export type DiscordGatewayDispatch =
  | (DiscordGatewayDispatchBase & {
      readonly type: "MESSAGE_CREATE";
      readonly message: DiscordMessage;
    })
  | (DiscordGatewayDispatchBase & {
      readonly type: "THREAD_CREATE" | "THREAD_UPDATE";
      readonly thread: DiscordThread;
    })
  | (DiscordGatewayDispatchBase & {
      readonly type: "THREAD_DELETE";
      readonly threadId: string;
      readonly guildId: string;
      readonly parentId: string;
    })
  | (DiscordGatewayDispatchBase & {
      readonly type: "INTERACTION_CREATE";
      readonly interaction: DiscordInteraction;
    });

export interface DiscordGatewayCursor {
  readonly sessionId: string;
  readonly resumeGatewayUrl: string;
  readonly sequence: number;
  readonly updatedAtMs: number;
}

export interface DiscordGatewayConnectOptions {
  readonly apiVersion: typeof DISCORD_API_VERSION;
  readonly intentBitfield: typeof DISCORD_GATEWAY_INTENTS;
  readonly resume: DiscordGatewayCursor | undefined;
  readonly onDispatch: (dispatch: DiscordGatewayDispatch) => Promise<void>;
  readonly onSessionEstablished: (input: {
    sessionId: string;
    resumeGatewayUrl: string;
    sequence: number;
  }) => Promise<void>;
  /**
   * Called after a non-resumable reconnect/new Identify so HTTP reconciliation
   * closes the delivery gap that Gateway history cannot.
   */
  readonly onReconcileRequired: () => Promise<void>;
}

export interface DiscordGatewayConnection {
  close(): Promise<void>;
}

/**
 * Owns the Discord credential, WebSocket HELLO/heartbeat/ACK handling, Identify or
 * Resume exchange, reconnect backoff, and bounded JSON framing. The adapter supplies only
 * the persisted resume cursor and validated intents.
 */
export interface DiscordGatewayPort {
  connect(options: DiscordGatewayConnectOptions): Promise<DiscordGatewayConnection>;
}

export interface DiscordInstallationProbe {
  readonly applicationId: string;
  readonly botUserId: string;
  readonly guildId: string;
  readonly guildFeatures: readonly string[];
  readonly enabledIntents: readonly DiscordIntent[];
  readonly forums: readonly {
    readonly channelId: string;
    readonly channelType: number;
    readonly permissions: readonly DiscordPermission[];
    readonly availableTagIds: readonly string[];
  }[];
}

export interface DiscordInstallationStatus {
  readonly ready: boolean;
  readonly apiVersion: typeof DISCORD_API_VERSION;
  readonly gatewayIntentBitfield: typeof DISCORD_GATEWAY_INTENTS;
  readonly issues: readonly string[];
}

export interface DiscordTextDisplay {
  readonly type: 10;
  readonly content: string;
}

export interface DiscordSeparator {
  readonly type: 14;
  readonly divider: boolean;
  readonly spacing: 1 | 2;
}

export interface DiscordButton {
  readonly type: 2;
  readonly style: 1 | 2 | 3 | 4 | 5;
  readonly label: string;
  readonly custom_id?: string;
  readonly url?: string;
  readonly disabled?: boolean;
}

export interface DiscordActionRow {
  readonly type: 1;
  readonly components: readonly DiscordButton[];
}

export interface DiscordContainer {
  readonly type: 17;
  readonly accent_color: number;
  readonly components: readonly (DiscordTextDisplay | DiscordSeparator | DiscordActionRow)[];
}

export interface DiscordMessagePayload {
  readonly flags: typeof DISCORD_COMPONENTS_V2_FLAG;
  readonly components: readonly (DiscordContainer | DiscordTextDisplay | DiscordActionRow)[];
  readonly allowed_mentions: {
    readonly parse: readonly string[];
  };
}

export interface DiscordApiPort {
  /**
   * The implementation owns and retrieves the bot credential. Returned diagnostics
   * must contain capabilities only, never the credential.
   */
  probeInstallation(input: {
    applicationId: string;
    guildId: string;
    forumChannelIds: readonly string[];
  }): Promise<DiscordInstallationProbe>;
  getThread(threadId: string): Promise<DiscordThread>;
  getMessage(threadId: string, messageId: string): Promise<DiscordMessage>;
  listActiveThreads(guildId: string): Promise<readonly DiscordThread[]>;
  listArchivedPublicThreads(
    forumChannelId: string,
    before?: string,
  ): Promise<{
    readonly threads: readonly DiscordThread[];
    readonly hasMore: boolean;
    readonly nextBefore?: string;
  }>;
  /**
   * Results must be oldest-first. `after` and `nextAfter` are Discord message
   * snowflakes, never attachment CDN URLs.
   */
  listMessages(
    threadId: string,
    after?: string,
  ): Promise<{
    readonly messages: readonly DiscordMessage[];
    readonly hasMore: boolean;
    readonly nextAfter?: string;
  }>;
  updateThreadTags(threadId: string, appliedTagIds: readonly string[]): Promise<void>;
  /**
   * A production implementation uses `requestKey` as a Discord nonce/reconciliation
   * marker so a retry cannot create a second status panel.
   */
  upsertStatusPanel(input: {
    threadId: string;
    requestKey: string;
    payload: DiscordMessagePayload;
    messageId?: string;
  }): Promise<{ readonly messageId: string }>;
  createMessage(input: {
    threadId: string;
    requestKey: string;
    payload: DiscordMessagePayload;
  }): Promise<{ readonly messageId: string }>;
  /**
   * Consumes the raw interaction token immediately and returns an opaque local
   * response reference. The raw token must never be persisted by the adapter.
   */
  deferInteraction(input: {
    interactionId: string;
    interactionToken: string;
    ephemeral: boolean;
  }): Promise<{ readonly responseRef: string }>;
  editDeferredInteraction(input: {
    responseRef: string;
    payload: DiscordMessagePayload;
  }): Promise<void>;
}

export interface DiscordTaskSource {
  readonly kind: "discord-forum";
  readonly guildId: string;
  readonly forumChannelId: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly authorId: string;
}

export interface DiscordTaskPort {
  /**
   * Every mutating callback must be durable and idempotent by `idempotencyKey`.
   * Adapter inbox completion is intentionally retried across process boundaries.
   */
  createTask(input: {
    readonly principalId: string;
    readonly idempotencyKey: string;
    readonly objective: string;
    readonly completionCriteria: readonly string[];
    readonly constraints: readonly string[];
    readonly selectedInputRefs: readonly string[];
    readonly source: DiscordTaskSource;
  }): Promise<{ readonly taskId: string }>;
  appendTaskInput(input: {
    readonly taskId: string;
    readonly principalId: string;
    readonly idempotencyKey: string;
    readonly message: string;
    readonly selectedInputRefs: readonly string[];
    readonly source: DiscordTaskSource;
  }): Promise<void>;
  commandTask(input: {
    readonly taskId: string;
    readonly principalId: string;
    readonly idempotencyKey: string;
    readonly command: "pause" | "resume" | "cancel" | "retry";
  }): Promise<void>;
  resolveApproval(input: {
    readonly taskId: string;
    readonly approvalId: string;
    readonly principalId: string;
    readonly idempotencyKey: string;
    readonly decision: "approve" | "reject";
  }): Promise<void>;
}

export interface TaskChannelProjection {
  readonly taskId: string;
  /**
   * Stable canonical event identity for this projection. It keeps two distinct
   * Task updates idempotent without collapsing equal user-visible text.
   */
  readonly sourceEventId?: string;
  readonly state: DiscordTaskState;
  readonly objective: string;
  readonly summary: string;
  readonly significance: "status" | "question" | "decision" | "failure" | "final";
  readonly progress?: {
    readonly completed: number;
    readonly total: number;
  };
  readonly approval?: {
    readonly approvalId: string;
    readonly description: string;
  };
  readonly artifact?: {
    readonly label: string;
    readonly url: string;
  };
  readonly inspectUrl?: string;
}

export interface DiscordTaskBinding {
  readonly guildId: string;
  readonly forumChannelId: string;
  readonly threadId: string;
  readonly starterMessageId: string;
  readonly taskId: string;
  readonly statusPanelMessageId?: string;
  readonly lastReconciledMessageId?: string;
  readonly externalState: "available" | "deleted" | "inaccessible";
  readonly archived: boolean;
  readonly locked: boolean;
  readonly revision: number;
}

export interface DiscordInboundRecord {
  readonly key: string;
  readonly digest: string;
  readonly state: "pending" | "completed";
  readonly acknowledged: boolean;
  readonly responseRef?: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export type DiscordOutboxAction =
  | {
      readonly kind: "sync-tags";
      readonly taskId: string;
      readonly state: DiscordTaskState;
    }
  | {
      readonly kind: "upsert-status-panel";
      readonly taskId: string;
      readonly projection: TaskChannelProjection;
    }
  | {
      readonly kind: "post-task-update";
      readonly taskId: string;
      readonly projection: TaskChannelProjection;
    }
  | {
      readonly kind: "task-command";
      readonly taskId: string;
      readonly principalId: string;
      readonly command: "pause" | "resume" | "cancel" | "retry";
      readonly idempotencyKey: string;
      readonly responseRef: string;
    }
  | {
      readonly kind: "approval-decision";
      readonly taskId: string;
      readonly principalId: string;
      readonly approvalId: string;
      readonly decision: "approve" | "reject";
      readonly idempotencyKey: string;
      readonly responseRef: string;
    };

export interface DiscordOutboxItem {
  readonly id: string;
  readonly action: DiscordOutboxAction;
  readonly createdAtMs: number;
  readonly notBeforeMs: number;
  readonly attempts: number;
  readonly delivered: boolean;
  readonly leaseOwner?: string;
  readonly leaseExpiresAtMs?: number;
  readonly lastErrorCode?: string;
}

export interface DiscordRepositorySnapshot {
  readonly version: 1;
  readonly cursor?: DiscordGatewayCursor;
  readonly bindings: readonly DiscordTaskBinding[];
  readonly inbound: readonly DiscordInboundRecord[];
  readonly outbox: readonly DiscordOutboxItem[];
}

/**
 * Production implementations must make every method atomic and persist these
 * records in Main's database. Claim operations provide the crash boundary around
 * channel callbacks and external Discord side effects.
 */
export interface DiscordStateRepository {
  getGatewayCursor(): Promise<DiscordGatewayCursor | undefined>;
  saveGatewayCursor(cursor: DiscordGatewayCursor): Promise<void>;
  claimInbound(input: { key: string; digest: string; nowMs: number }): Promise<{
    readonly outcome: "new" | "pending" | "completed";
    readonly record: DiscordInboundRecord;
  }>;
  acknowledgeInbound(input: {
    key: string;
    responseRef: string;
    nowMs: number;
  }): Promise<DiscordInboundRecord>;
  completeInbound(input: { key: string; nowMs: number }): Promise<void>;
  getBindingByThread(threadId: string): Promise<DiscordTaskBinding | undefined>;
  getBindingByTask(taskId: string): Promise<DiscordTaskBinding | undefined>;
  listBindings(): Promise<readonly DiscordTaskBinding[]>;
  bindTask(binding: Omit<DiscordTaskBinding, "revision">): Promise<DiscordTaskBinding>;
  updateBinding(
    threadId: string,
    patch: Partial<
      Pick<
        DiscordTaskBinding,
        "statusPanelMessageId" | "lastReconciledMessageId" | "externalState" | "archived" | "locked"
      >
    >,
  ): Promise<DiscordTaskBinding>;
  enqueueOutbox(item: Omit<DiscordOutboxItem, "attempts" | "delivered">): Promise<void>;
  claimReadyOutbox(input: {
    owner: string;
    nowMs: number;
    leaseMs: number;
    limit: number;
  }): Promise<readonly DiscordOutboxItem[]>;
  completeOutbox(input: { id: string; owner: string }): Promise<void>;
  retryOutbox(input: {
    id: string;
    owner: string;
    notBeforeMs: number;
    errorCode: string;
  }): Promise<void>;
  listOutbox(): Promise<readonly DiscordOutboxItem[]>;
}

export interface DiscordClock {
  nowMs(): number;
}

export interface DiscordDiagnostic {
  readonly event: string;
  readonly atMs: number;
  readonly fields: Readonly<Record<string, string | number | boolean>>;
}

export interface DiscordForumAdapterOptions {
  readonly config: DiscordForumAdapterConfig;
  readonly repository: DiscordStateRepository;
  readonly api: DiscordApiPort;
  readonly tasks: DiscordTaskPort;
  readonly clock: DiscordClock;
  readonly gateway?: DiscordGatewayPort;
}
