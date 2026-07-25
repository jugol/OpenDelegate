import { createHash } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import {
  type ArtifactAdminPort,
  AdminOperationsPortError,
  type AuditAdminPort,
  type DeviceEnrollmentAdminPort,
} from "@opendelegate/control-plane";
import {
  ArtifactStoreError,
  type ArtifactAuditEvent,
  type ArtifactStore,
  type StoredArtifactMetadata,
} from "@opendelegate/artifact-store";
import type { ConfigurationAudit } from "@opendelegate/configuration";
import type {
  DeviceIdentityAuditRecord,
  PersistedEnrollmentGrant,
} from "@opendelegate/device-identity";
import type { EventStore, StoredEvent } from "@opendelegate/event-store";
import type { OwnerAuthAuditRecord } from "@opendelegate/owner-auth";
import type { ApprovalAuditEvent } from "@opendelegate/policy";
import type {
  ArtifactDetailV1,
  ArtifactOpenInstructionV1,
  AuditEventSummaryV1,
  DeviceEnrollmentOverviewV1,
  EnrollmentGrantSummaryV1,
  IssueEnrollmentGrantResponseV1,
} from "@opendelegate/protocol";

import type {
  MainDeviceChannelConfiguration,
  ProductionMainDeviceChannelRuntime,
} from "./device-channel-runtime.ts";
import type { MainActionAuthorizationAuditRecord } from "./action-authorization-runtime.ts";
import type { MainArtifactRuntime } from "./artifact-runtime.ts";
import {
  ROUTE_INCIDENT_DIAGNOSIS_COMPLETED_EVENT_TYPE,
  parseStoredRouteIncidentDiagnosisResult,
} from "./route-incident-diagnosis.ts";
import { readStableRegularFile } from "./stable-file.ts";

const PROTOCOL_VERSION = 1;
const DEFAULT_BROWSER_GRANT_TTL_MS = 5 * 60 * 1_000;
const MAXIMUM_LEDGER_RECORD_BYTES = 256 * 1_024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const SAFE_CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_AUDIT_TYPE = /^[a-z][a-z0-9.-]{2,159}$/u;

interface EnrollmentGrantIssuer {
  createEnrollmentGrant(input: {
    readonly deviceId: string;
    readonly allowedBootstrapRoles: readonly string[];
    readonly expiresInMs: number;
    readonly protocolRange: { readonly minimum: number; readonly maximum: number };
  }): Promise<{
    readonly grantId: string;
    readonly deviceId: string;
    readonly allowedBootstrapRoles: readonly string[];
    readonly protocolRange: { readonly minimum: number; readonly maximum: number };
    readonly createdAt: number;
    readonly expiresAt: number;
    readonly expectedMainSpkiSha256: string;
    readonly secret: { reveal(): string };
  }>;
}

export interface AdminDeviceChannelSource {
  readonly authority?: EnrollmentGrantIssuer;
  readonly certificateAuthorityPem?: string;
  readonly certificateAuthoritySpkiSha256?: string;
  readonly enrollmentAddress?: ProductionMainDeviceChannelRuntime["enrollmentAddress"];
  readonly workerChannel?: Pick<ProductionMainDeviceChannelRuntime["workerChannel"], "address">;
  listEnrollmentGrants?(): Promise<readonly PersistedEnrollmentGrant[]>;
  listIdentityAuditRecords?(): Promise<readonly DeviceIdentityAuditRecord[]>;
}

export interface AdminArtifactSource {
  readonly configuration?: {
    readonly listeners: {
      readonly static: Pick<MainArtifactRuntime["configuration"]["listeners"]["static"], "origin">;
      readonly interactive: Pick<
        MainArtifactRuntime["configuration"]["listeners"]["interactive"],
        "origin"
      >;
    };
  };
  readonly store?: Partial<
    Pick<
      ArtifactStore,
      | "getAvailableMetadata"
      | "getMetadata"
      | "issueSignedToken"
      | "listAuditEvents"
      | "listMetadata"
    >
  >;
  issueBrowserAccessGrant?: MainArtifactRuntime["issueBrowserAccessGrant"];
}

export interface CreateMainAdminOperationsOptions {
  readonly mainDeviceId: string;
  readonly idempotencyDirectory: string;
  readonly deviceChannel?: AdminDeviceChannelSource;
  readonly deviceChannelConfiguration?: MainDeviceChannelConfiguration;
  readonly artifacts?: AdminArtifactSource;
  readonly configurationAudits?: {
    listAudit(): Promise<readonly ConfigurationAudit[]>;
  };
  readonly approvalAudits?: {
    audit(): Promise<readonly ApprovalAuditEvent[]>;
  };
  readonly ownerAuthAudits?: {
    listAuditRecords(): Promise<readonly OwnerAuthAuditRecord[]>;
  };
  readonly actionAuthorizationAudits?: {
    listAudit(): Promise<readonly MainActionAuthorizationAuditRecord[]>;
  };
  readonly eventStore: Pick<EventStore, "readAll">;
  readonly clock?: { now(): number };
}

export interface MainAdminOperations {
  readonly enrollment: DeviceEnrollmentAdminPort;
  readonly artifacts: ArtifactAdminPort;
  readonly audit: AuditAdminPort;
}

export function createMainAdminOperations(
  options: CreateMainAdminOperationsOptions,
): MainAdminOperations {
  requireSafeId(options.mainDeviceId, "Main Device ID");
  const clock = options.clock ?? { now: () => Date.now() };
  const ledger = new RestrictedIdempotencyLedger(options.idempotencyDirectory);

  return Object.freeze({
    enrollment: new MainDeviceEnrollmentAdminPort(options, ledger, clock),
    artifacts: new MainArtifactAdminPort(options.artifacts, ledger, clock),
    audit: new MainAuditAdminPort(options),
  });
}

class MainDeviceEnrollmentAdminPort implements DeviceEnrollmentAdminPort {
  readonly #options: CreateMainAdminOperationsOptions;
  readonly #ledger: RestrictedIdempotencyLedger;
  readonly #clock: { now(): number };

  public constructor(
    options: CreateMainAdminOperationsOptions,
    ledger: RestrictedIdempotencyLedger,
    clock: { now(): number },
  ) {
    this.#options = options;
    this.#ledger = ledger;
    this.#clock = clock;
  }

  public async overview(): Promise<DeviceEnrollmentOverviewV1> {
    const source = this.#options.deviceChannel;
    const endpoints = enrollmentEndpoints(this.#options);
    if (
      source?.authority === undefined ||
      source.certificateAuthorityPem === undefined ||
      source.certificateAuthoritySpkiSha256 === undefined ||
      endpoints === undefined
    ) {
      return Object.freeze({ available: false, grants: [] });
    }
    const now = readClock(this.#clock);
    const grants =
      source.listEnrollmentGrants === undefined ? [] : await source.listEnrollmentGrants();
    return Object.freeze({
      available: true,
      mainDeviceId: this.#options.mainDeviceId,
      expectedMainSpkiSha256: source.certificateAuthoritySpkiSha256,
      enrollmentUrl: endpoints.enrollmentUrl,
      channelEndpoints: [...endpoints.channelEndpoints],
      grants: grants
        .map((grant) => enrollmentSummary(grant, now))
        .sort(
          (left, right) =>
            Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
            left.grantId.localeCompare(right.grantId),
        ),
    });
  }

  public async issue(input: {
    readonly deviceId: string;
    readonly expiresInSeconds: number;
    readonly principalId: string;
    readonly idempotencyKey: string;
  }): Promise<IssueEnrollmentGrantResponseV1> {
    const source = this.#options.deviceChannel;
    const endpoints = enrollmentEndpoints(this.#options);
    if (
      source?.authority === undefined ||
      source.certificateAuthorityPem === undefined ||
      source.certificateAuthoritySpkiSha256 === undefined ||
      endpoints === undefined
    ) {
      throw new AdminOperationsPortError(
        "ENROLLMENT_UNAVAILABLE",
        "Device enrollment is not configured on Main.",
      );
    }
    const fingerprint = fingerprintOf({
      deviceId: input.deviceId,
      expiresInSeconds: input.expiresInSeconds,
    });
    return this.#ledger.execute(
      "device-enrollment",
      input.principalId,
      input.idempotencyKey,
      fingerprint,
      {
        conflictCode: "ENROLLMENT_IDEMPOTENCY_CONFLICT",
        indeterminateCode: "ENROLLMENT_IDEMPOTENCY_INDETERMINATE",
      },
      async () => {
        const grant = await source.authority!.createEnrollmentGrant({
          deviceId: input.deviceId,
          allowedBootstrapRoles: ["worker"],
          expiresInMs: input.expiresInSeconds * 1_000,
          protocolRange: { minimum: PROTOCOL_VERSION, maximum: PROTOCOL_VERSION },
        });
        const summary: EnrollmentGrantSummaryV1 = {
          grantId: grant.grantId,
          deviceId: grant.deviceId,
          status: "active",
          allowedBootstrapRoles: [...grant.allowedBootstrapRoles],
          createdAt: instant(grant.createdAt),
          expiresAt: instant(grant.expiresAt),
        };
        return Object.freeze({
          summary: Object.freeze(summary),
          suggestedFilename: suggestedGrantFilename(grant.deviceId),
          document: Object.freeze({
            schemaVersion: 1 as const,
            grantId: grant.grantId,
            token: grant.secret.reveal(),
            deviceId: grant.deviceId,
            mainDeviceId: this.#options.mainDeviceId,
            expectedMainSpkiSha256: grant.expectedMainSpkiSha256,
            certificateAuthorityPem: source.certificateAuthorityPem!,
            enrollmentUrl: endpoints.enrollmentUrl,
            channelEndpoints: [...endpoints.channelEndpoints],
            protocolRange: Object.freeze({ ...grant.protocolRange }),
            expiresAt: grant.expiresAt,
          }),
        });
      },
    );
  }
}

class MainArtifactAdminPort implements ArtifactAdminPort {
  readonly #source: AdminArtifactSource | undefined;
  readonly #ledger: RestrictedIdempotencyLedger;
  readonly #clock: { now(): number };

  public constructor(
    source: AdminArtifactSource | undefined,
    ledger: RestrictedIdempotencyLedger,
    clock: { now(): number },
  ) {
    this.#source = source;
    this.#ledger = ledger;
    this.#clock = clock;
  }

  public async list(): Promise<readonly ArtifactDetailV1[]> {
    const store = this.#source?.store;
    if (store?.listMetadata === undefined) {
      return Object.freeze([]);
    }
    try {
      return Object.freeze((await store.listMetadata()).map(artifactDetail));
    } catch (error) {
      throw artifactUnavailable(error);
    }
  }

  public async get(artifactId: string): Promise<ArtifactDetailV1> {
    const store = this.#source?.store;
    if (store?.getMetadata === undefined) {
      throw artifactNotFound();
    }
    try {
      return artifactDetail(await store.getMetadata(artifactId));
    } catch (error) {
      if (error instanceof ArtifactStoreError && error.code === "ARTIFACT_NOT_FOUND") {
        throw artifactNotFound();
      }
      throw artifactUnavailable(error);
    }
  }

  public async open(input: {
    readonly artifactId: string;
    readonly principalId: string;
    readonly idempotencyKey: string;
  }): Promise<ArtifactOpenInstructionV1> {
    const source = this.#source;
    const store = source?.store;
    if (source?.configuration === undefined || store?.getAvailableMetadata === undefined) {
      throw artifactNotFound();
    }
    const fingerprint = fingerprintOf({ artifactId: input.artifactId });
    return this.#ledger.execute(
      "artifact-open",
      input.principalId,
      input.idempotencyKey,
      fingerprint,
      {
        conflictCode: "ARTIFACT_IDEMPOTENCY_CONFLICT",
        indeterminateCode: "ARTIFACT_OPEN_UNAVAILABLE",
      },
      async () => {
        let metadata: StoredArtifactMetadata;
        try {
          metadata = await store.getAvailableMetadata!(input.artifactId);
        } catch (error) {
          if (
            error instanceof ArtifactStoreError &&
            (error.code === "ARTIFACT_NOT_FOUND" || error.code === "ARTIFACT_UNAVAILABLE")
          ) {
            throw artifactNotFound();
          }
          throw artifactUnavailable(error);
        }
        const origin = artifactOrigin(source.configuration!, metadata);
        const artifactUrl = new URL(
          `/artifacts/${encodeURIComponent(metadata.artifactId)}`,
          origin,
        );
        const expiresAtMs = browserGrantExpiry(metadata, readClock(this.#clock));
        const context = {
          actor: { type: "owner" as const, id: input.principalId },
          correlationId: `admin-artifact-open:${fingerprint.slice(0, 32)}`,
        };
        switch (metadata.exposurePolicy.mode) {
          case "public":
          case "private-network":
            return Object.freeze({
              method: "GET" as const,
              href: artifactUrl.href,
              artifactId: metadata.artifactId,
            });
          case "signed-link": {
            if (store.issueSignedToken === undefined) {
              throw artifactUnavailable();
            }
            const issued = await store.issueSignedToken({
              artifactId: metadata.artifactId,
              expiresAtMs,
              context,
            });
            artifactUrl.searchParams.set("token", issued.token);
            return Object.freeze({
              method: "GET" as const,
              href: artifactUrl.href,
              artifactId: metadata.artifactId,
              expiresAt: instant(issued.expiresAtMs),
            });
          }
          case "authenticated": {
            if (source.issueBrowserAccessGrant === undefined) {
              throw artifactUnavailable();
            }
            const issued = await source.issueBrowserAccessGrant({
              artifactId: metadata.artifactId,
              expiresAtMs,
              context,
            });
            return Object.freeze({
              method: issued.method,
              actionUrl: issued.actionUrl,
              fieldName: issued.fieldName,
              fieldValue: issued.fieldValue,
              artifactId: issued.artifactId,
              expiresAt: instant(issued.expiresAtMs),
            });
          }
          case "custom":
            throw new AdminOperationsPortError(
              "ARTIFACT_POLICY_UNAVAILABLE",
              "This Artifact's custom exposure policy cannot be opened from Admin.",
            );
        }
      },
    );
  }
}

class MainAuditAdminPort implements AuditAdminPort {
  readonly #options: CreateMainAdminOperationsOptions;

  public constructor(options: CreateMainAdminOperationsOptions) {
    this.#options = options;
  }

  public async list(): Promise<readonly AuditEventSummaryV1[]> {
    try {
      const [
        events,
        artifactEvents,
        identityEvents,
        ownerAuthEvents,
        actionAuthorizationEvents,
        configurationEvents,
        approvalEvents,
      ] = await Promise.all([
        this.#options.eventStore.readAll(),
        this.#options.artifacts?.store?.listAuditEvents?.() ?? Promise.resolve([]),
        this.#options.deviceChannel?.listIdentityAuditRecords?.() ?? Promise.resolve([]),
        this.#options.ownerAuthAudits?.listAuditRecords() ?? Promise.resolve([]),
        this.#options.actionAuthorizationAudits?.listAudit() ?? Promise.resolve([]),
        this.#options.configurationAudits?.listAudit() ?? Promise.resolve([]),
        this.#options.approvalAudits?.audit() ?? Promise.resolve([]),
      ]);
      return Object.freeze(
        [
          ...events.map(projectStoredEvent),
          ...artifactEvents.map(projectArtifactAudit),
          ...identityEvents.map(projectIdentityAudit),
          ...ownerAuthEvents.map(projectOwnerAuthAudit),
          ...actionAuthorizationEvents.map(projectActionAuthorizationAudit),
          ...configurationEvents.map(projectConfigurationAudit),
          ...approvalEvents.map(projectApprovalAudit),
        ].sort(
          (left, right) =>
            Date.parse(right.occurredAt) - Date.parse(left.occurredAt) ||
            left.auditId.localeCompare(right.auditId),
        ),
      );
    } catch (error) {
      throw new AdminOperationsPortError(
        "AUDIT_UNAVAILABLE",
        "The bounded Admin audit projection is unavailable.",
        { cause: error },
      );
    }
  }
}

class RestrictedIdempotencyLedger {
  readonly #directory: string;

  public constructor(directory: string) {
    if (!isAbsolute(directory) || directory.includes("\0")) {
      throw new Error("The Admin operation idempotency directory must be absolute.");
    }
    this.#directory = resolve(directory);
  }

  public async execute<TResult>(
    scope: string,
    principalId: string,
    idempotencyKey: string,
    fingerprint: string,
    codes: {
      readonly conflictCode: "ARTIFACT_IDEMPOTENCY_CONFLICT" | "ENROLLMENT_IDEMPOTENCY_CONFLICT";
      readonly indeterminateCode:
        "ARTIFACT_OPEN_UNAVAILABLE" | "ENROLLMENT_IDEMPOTENCY_INDETERMINATE";
    },
    operation: () => Promise<TResult>,
  ): Promise<TResult> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const identity = fingerprintOf({ scope, principalId, idempotencyKey });
    const path = join(this.#directory, `${identity}.json`);
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(
        path,
        fileConstants.O_CREAT | fileConstants.O_EXCL | fileConstants.O_RDWR,
        0o600,
      );
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) {
        throw indeterminate(codes.indeterminateCode, error);
      }
      return this.#replay<TResult>(path, fingerprint, codes);
    }

    try {
      await writeLedgerRecord(handle, {
        schemaVersion: 1,
        state: "pending",
        fingerprint,
      });
      const result = await operation();
      await writeLedgerRecord(handle, {
        schemaVersion: 1,
        state: "completed",
        fingerprint,
        result,
      });
      return result;
    } catch (error) {
      if (error instanceof AdminOperationsPortError) {
        throw error;
      }
      throw indeterminate(codes.indeterminateCode, error);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async #replay<TResult>(
    path: string,
    fingerprint: string,
    codes: {
      readonly conflictCode: "ARTIFACT_IDEMPOTENCY_CONFLICT" | "ENROLLMENT_IDEMPOTENCY_CONFLICT";
      readonly indeterminateCode:
        "ARTIFACT_OPEN_UNAVAILABLE" | "ENROLLMENT_IDEMPOTENCY_INDETERMINATE";
    },
  ): Promise<TResult> {
    let bytes: Buffer | undefined;
    try {
      const metadata = await lstat(path);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.nlink !== 1 ||
        (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
      ) {
        throw new Error("The Admin operation idempotency record is unsafe.");
      }
      bytes = await readStableRegularFile(path, MAXIMUM_LEDGER_RECORD_BYTES);
      const record = JSON.parse(bytes.toString("utf8")) as unknown;
      if (!isRecord(record) || record["schemaVersion"] !== 1) {
        throw new Error("The Admin operation idempotency record is invalid.");
      }
      if (record["fingerprint"] !== fingerprint) {
        throw new AdminOperationsPortError(
          codes.conflictCode,
          "The idempotency key was already used for different Admin operation input.",
        );
      }
      if (record["state"] !== "completed" || !Object.hasOwn(record, "result")) {
        throw indeterminate(codes.indeterminateCode);
      }
      return structuredClone(record["result"]) as TResult;
    } catch (error) {
      if (error instanceof AdminOperationsPortError) {
        throw error;
      }
      throw indeterminate(codes.indeterminateCode, error);
    } finally {
      bytes?.fill(0);
    }
  }
}

function enrollmentEndpoints(options: CreateMainAdminOperationsOptions):
  | {
      readonly enrollmentUrl: string;
      readonly channelEndpoints: Array<{
        readonly endpointId: "main-worker-channel";
        readonly label: "Main Worker channel";
        readonly kind: "wss";
        readonly url: string;
      }>;
    }
  | undefined {
  const source = options.deviceChannel;
  const enrollmentUrl =
    options.deviceChannelConfiguration?.enrollment.advertisedUrl ?? source?.enrollmentAddress?.url;
  const workerUrl =
    options.deviceChannelConfiguration?.workerChannel.advertisedUrl ??
    source?.workerChannel?.address().url;
  if (enrollmentUrl === undefined || workerUrl === undefined) {
    return undefined;
  }
  return Object.freeze({
    enrollmentUrl,
    channelEndpoints: [
      {
        endpointId: "main-worker-channel" as const,
        label: "Main Worker channel" as const,
        kind: "wss" as const,
        url: workerUrl,
      },
    ],
  });
}

function enrollmentSummary(grant: PersistedEnrollmentGrant, now: number): EnrollmentGrantSummaryV1 {
  return Object.freeze({
    grantId: grant.grantId,
    deviceId: grant.deviceId,
    status: grant.status === "active" && grant.expiresAt <= now ? "expired" : grant.status,
    allowedBootstrapRoles: [...grant.allowedBootstrapRoles],
    createdAt: instant(grant.createdAt),
    expiresAt: instant(grant.expiresAt),
    ...(grant.consumedAt === undefined ? {} : { consumedAt: instant(grant.consumedAt) }),
  });
}

function artifactDetail(metadata: StoredArtifactMetadata): ArtifactDetailV1 {
  return Object.freeze({
    artifactId: metadata.artifactId,
    taskId: metadata.taskId,
    producingRunId: metadata.producingRunId,
    mediaType: metadata.mediaType,
    originalFilename: metadata.originalFilename,
    sizeBytes: metadata.sizeBytes,
    checksum: Object.freeze({ ...metadata.checksum }),
    createdAt: instant(metadata.createdAtMs),
    retentionPolicy:
      metadata.retentionPolicy.kind === "temporary"
        ? Object.freeze({
            kind: "temporary" as const,
            expiresAt: instant(metadata.retentionPolicy.expiresAtMs),
          })
        : Object.freeze({ kind: metadata.retentionPolicy.kind }),
    exposurePolicy:
      metadata.exposurePolicy.mode === "custom"
        ? Object.freeze({
            mode: "custom" as const,
            customPolicyId: metadata.exposurePolicy.customPolicyId,
          })
        : Object.freeze({ mode: metadata.exposurePolicy.mode }),
    provenance: Object.freeze({ ...metadata.provenance }),
    presentation: metadata.presentation,
    state: metadata.state,
    ...(metadata.pinnedAtMs === undefined ? {} : { pinnedAt: instant(metadata.pinnedAtMs) }),
    ...(metadata.revokedAtMs === undefined ? {} : { revokedAt: instant(metadata.revokedAtMs) }),
    ...(metadata.expiredAtMs === undefined ? {} : { expiredAt: instant(metadata.expiredAtMs) }),
  });
}

function artifactOrigin(
  configuration: NonNullable<AdminArtifactSource["configuration"]>,
  metadata: StoredArtifactMetadata,
): string {
  return metadata.presentation === "interactive-html"
    ? configuration.listeners.interactive.origin
    : configuration.listeners.static.origin;
}

function browserGrantExpiry(metadata: StoredArtifactMetadata, now: number): number {
  const defaultExpiry = now + DEFAULT_BROWSER_GRANT_TTL_MS;
  const expiresAt =
    metadata.retentionPolicy.kind === "temporary"
      ? Math.min(defaultExpiry, metadata.retentionPolicy.expiresAtMs)
      : defaultExpiry;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
    throw artifactNotFound();
  }
  return expiresAt;
}

function projectStoredEvent(event: StoredEvent): AuditEventSummaryV1 {
  const streamSubject = subjectFromStream(event.streamId);
  const routeIncident =
    event.type === ROUTE_INCIDENT_DIAGNOSIS_COMPLETED_EVENT_TYPE
      ? parseStoredRouteIncidentDiagnosisResult(event.payload)
      : undefined;
  return Object.freeze({
    auditId: safeIdOrDigest(event.eventId, "runtime-event"),
    source: sourceForEvent(event.type),
    type: safeAuditType(event.type),
    occurredAt: event.occurredAt,
    outcome: outcomeForType(event.type),
    ...(routeIncident === undefined
      ? streamSubject === undefined
        ? {}
        : streamSubject
      : {
          subjectId: routeIncident.authenticatedDeviceId,
          deviceId: routeIncident.authenticatedDeviceId,
          routeIncident: Object.freeze({
            incidentId: routeIncident.incidentId,
            fingerprint: routeIncident.fingerprint,
            profileRevision: routeIncident.profileRevision,
            recommendation: routeIncident.recommendation,
            ownerQuestion: routeIncident.ownerQuestion,
            source: routeIncident.source,
            reasonCode: routeIncident.reasonCode,
          }),
        }),
  });
}

function projectArtifactAudit(event: ArtifactAuditEvent): AuditEventSummaryV1 {
  return Object.freeze({
    auditId: `artifact-audit:${event.sequence}`,
    source: "artifact",
    type: event.eventType,
    occurredAt: instant(event.occurredAtMs),
    outcome: outcomeForType(event.eventType),
    ...(safeOptionalId(event.actor.id) === undefined ? {} : { actorId: event.actor.id }),
    artifactId: event.artifactId,
    ...(SAFE_CORRELATION_ID.test(event.correlationId)
      ? { correlationId: event.correlationId }
      : {}),
  });
}

function projectIdentityAudit(event: DeviceIdentityAuditRecord): AuditEventSummaryV1 {
  return Object.freeze({
    auditId: safeIdOrDigest(event.auditId, "identity-audit"),
    source: "device-identity",
    type: event.event,
    occurredAt: instant(event.occurredAt),
    outcome: outcomeForType(event.event),
    subjectId: event.deviceId,
    deviceId: event.deviceId,
  });
}

function projectOwnerAuthAudit(event: OwnerAuthAuditRecord): AuditEventSummaryV1 {
  const subjectId = event.targetSessionId ?? event.sessionId ?? event.ownerId;
  const safeActorId = event.ownerId === undefined ? undefined : safeOptionalId(event.ownerId);
  const safeSubjectId = subjectId === undefined ? undefined : safeOptionalId(subjectId);
  return Object.freeze({
    auditId: safeIdOrDigest(event.auditId, "owner-auth-audit"),
    source: "owner-auth",
    type: event.event,
    occurredAt: instant(event.occurredAt),
    outcome: outcomeForType(event.event),
    ...(safeActorId === undefined ? {} : { actorId: safeActorId }),
    ...(safeSubjectId === undefined ? {} : { subjectId: safeSubjectId }),
  });
}

function projectActionAuthorizationAudit(
  event: MainActionAuthorizationAuditRecord,
): AuditEventSummaryV1 {
  return Object.freeze({
    auditId: safeIdOrDigest(event.auditId, "action-authorization-audit"),
    source: "action-authorization",
    type: safeAuditType(event.event),
    occurredAt: instant(event.occurredAtMs),
    outcome:
      event.consumed || event.decision === "allow"
        ? "succeeded"
        : event.decision === "deny"
          ? "denied"
          : "recorded",
    actorId: event.deviceId,
    subjectId: safeIdOrDigest(event.authorizationId, "action-authorization"),
    taskId: event.taskId,
    runId: event.runId,
    deviceId: event.deviceId,
    ...(event.reasonCode === undefined ? {} : { reasonCode: event.reasonCode }),
  });
}

function projectConfigurationAudit(event: ConfigurationAudit): AuditEventSummaryV1 {
  return Object.freeze({
    auditId: safeIdOrDigest(event.id, "configuration-audit"),
    source: "configuration",
    type: event.action,
    occurredAt: event.occurredAt,
    outcome: "succeeded",
    ...(safeOptionalId(event.actor) === undefined ? {} : { actorId: event.actor }),
    ...(safeOptionalId(event.changeSetId) === undefined ? {} : { subjectId: event.changeSetId }),
  });
}

function projectApprovalAudit(event: ApprovalAuditEvent): AuditEventSummaryV1 {
  return Object.freeze({
    auditId: safeIdOrDigest(event.auditId, "approval-audit"),
    source: "approval",
    type: event.event,
    occurredAt: instant(event.occurredAtMs),
    outcome: outcomeForType(event.event),
    ...(safeOptionalId(event.actor) === undefined ? {} : { actorId: event.actor }),
    ...(safeOptionalId(event.approvalId) === undefined ? {} : { subjectId: event.approvalId }),
  });
}

function subjectFromStream(
  streamId: string,
): Pick<AuditEventSummaryV1, "subjectId" | "taskId" | "runId" | "artifactId"> | undefined {
  const separator = streamId.indexOf(":");
  if (separator < 1) {
    return undefined;
  }
  const kind = streamId.slice(0, separator);
  const identifier = streamId.slice(separator + 1);
  if (!SAFE_ID.test(identifier)) {
    return undefined;
  }
  switch (kind) {
    case "task":
      return { subjectId: identifier, taskId: identifier };
    case "run":
      return { subjectId: identifier, runId: identifier };
    case "artifact":
      return { subjectId: identifier, artifactId: identifier };
    default:
      return { subjectId: identifier };
  }
}

function sourceForEvent(type: string): AuditEventSummaryV1["source"] {
  if (type.startsWith("artifact.")) return "artifact";
  if (type.startsWith("device.")) return "device-identity";
  if (type.startsWith("configuration.")) return "configuration";
  if (type.startsWith("approval.")) return "approval";
  if (type.startsWith("task.") || type.startsWith("run.") || type.startsWith("work-order.")) {
    return "task";
  }
  return "runtime";
}

function outcomeForType(type: string): AuditEventSummaryV1["outcome"] {
  if (/(?:denied|rejected|revoked|unauthorized)(?:$|[.-])/u.test(type)) return "denied";
  if (/(?:failed|failure|error|unavailable)(?:$|[.-])/u.test(type)) return "failed";
  if (/(?:created|completed|confirmed|enrolled|granted|issued|stored)(?:$|[.-])/u.test(type)) {
    return "succeeded";
  }
  return "recorded";
}

function safeAuditType(type: string): string {
  if (SAFE_AUDIT_TYPE.test(type)) {
    return type;
  }
  const normalized = type
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/gu, "-")
    .replace(/^[^a-z]+/u, "")
    .slice(0, 160);
  return SAFE_AUDIT_TYPE.test(normalized)
    ? normalized
    : `runtime.event-${fingerprintOf(type).slice(0, 16)}`;
}

function safeIdOrDigest(value: string, prefix: string): string {
  return SAFE_ID.test(value) ? value : `${prefix}:${fingerprintOf(value).slice(0, 32)}`;
}

function safeOptionalId(value: string): string | undefined {
  return SAFE_ID.test(value) ? value : undefined;
}

function suggestedGrantFilename(deviceId: string): string {
  const slug = deviceId
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^[^A-Za-z0-9]+/u, "")
    .slice(0, 180);
  return `opendelegate-${slug || "device"}-grant.json`;
}

function instant(timestamp: number): string {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 8.64e15) {
    throw new Error("An Admin operation timestamp is invalid.");
  }
  return new Date(timestamp).toISOString();
}

function readClock(clock: { now(): number }): number {
  return Number(clock.now());
}

function fingerprintOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

async function writeLedgerRecord(
  handle: Awaited<ReturnType<typeof open>>,
  record: unknown,
): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  try {
    if (bytes.byteLength > MAXIMUM_LEDGER_RECORD_BYTES) {
      throw new Error("The Admin operation idempotency result exceeds its byte limit.");
    }
    await handle.truncate(0);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
      if (written.bytesWritten < 1) {
        throw new Error("The Admin operation idempotency result could not be persisted.");
      }
      offset += written.bytesWritten;
    }
    await handle.sync();
  } finally {
    bytes.fill(0);
  }
}

function requireSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
}

function artifactNotFound(): AdminOperationsPortError {
  return new AdminOperationsPortError(
    "ARTIFACT_NOT_FOUND",
    "The requested Artifact is not available.",
  );
}

function artifactUnavailable(cause?: unknown): AdminOperationsPortError {
  return new AdminOperationsPortError(
    "ARTIFACT_OPEN_UNAVAILABLE",
    "The Artifact operation is unavailable.",
    cause === undefined ? undefined : { cause },
  );
}

function indeterminate(
  code: "ARTIFACT_OPEN_UNAVAILABLE" | "ENROLLMENT_IDEMPOTENCY_INDETERMINATE",
  cause?: unknown,
): AdminOperationsPortError {
  return new AdminOperationsPortError(
    code,
    "The Admin operation may have completed; retry with the same idempotency key.",
    cause === undefined ? undefined : { cause },
  );
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
