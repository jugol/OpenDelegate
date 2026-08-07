import { createHash, createPrivateKey, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { TLSSocket } from "node:tls";
import { isDeepStrictEqual } from "node:util";

import {
  deviceCertificateIsUsable,
  readDeviceCertificateLifecycle,
  type DeviceCertificateLifecycle,
  type DeviceCertificateLifecycleState,
} from "@opendelegate/device-identity";
import { PROTOCOL_VERSION, type ArtifactUploadGrantV1 } from "@opendelegate/protocol";
import type {
  SequencedWorkerEventV1,
  WorkerHeartbeatV1,
  WorkerMainConnection,
  WorkerOutboxAckV1,
  WorkerRouteIncidentV1,
  WorkerRunAssignmentV1,
  WorkerRunLeaseAuthority,
  WorkerRunLeaseSnapshot,
  WorkerRunSteeringReceiptV1,
} from "@opendelegate/worker-runtime";
import WebSocket, { type RawData } from "ws";

import {
  MAX_DEVICE_CHANNEL_FRAME_BYTES,
  decodeDeviceChannelFrame,
  encodeDeviceChannelFrame,
  type ArtifactPrepareManifestV1,
  type ArtifactPrepareRejectionCodeV1,
  type IdentityRotationRejectionCodeV1,
  type MainArtifactGrantFrameV1,
  type MainArtifactRejectedFrameV1,
  type MainIdentityPendingFrameV1,
  type MainIdentityRejectedFrameV1,
  type MainIdentityRenewedFrameV1,
  type MainProviderUpgradeFrameV1,
  type MainActionAuthorizationFrameV1,
  type MainActionConsumptionFrameV1,
  type MainControlFrameV1,
  type MainDispatchFrameV1,
  type MainRunLeaseFrameV1,
  type MainRunSteerFrameV1,
  type MainToWorkerFrameV1,
  type MainWelcomeFrameV1,
  type WorkerToMainFrameV1,
  type WorkerActionAuthorizationRequestV1,
  type WorkerActionConsumptionRequestV1,
  type WorkerIdentityActivateFrameV1,
  type WorkerIdentityRotateFrameV1,
  type WorkerProviderUpgradeResultV1,
  type WorkerRouteIncidentFrameV1,
  type WorkerRunLeaseRenewalRequestV1,
  type WorkerRunLeaseRenewFrameV1,
  type WorkerRunSteeringReceiptFrameV1,
} from "./protocol.ts";
import {
  type SqliteWorkerChannelState,
  type WorkerMainAcknowledgment,
} from "./worker-channel-state.ts";

const DEVICE_CHANNEL_SUBPROTOCOL = "opendelegate.device.v1";
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_MAXIMUM_BUFFERED_BYTES = 2 * MAX_DEVICE_CHANNEL_FRAME_BYTES;
export const DEFAULT_MAXIMUM_HANDSHAKE_RTT_MS = 5_000;
export const DEFAULT_MAXIMUM_ABSOLUTE_CLOCK_SKEW_MS = 60_000;
const MINIMUM_RENEWAL_LEAD_MS = 30_000;
const MAXIMUM_RENEWAL_ATTEMPTS = 8;
const INITIAL_RENEWAL_RETRY_MS = 125;

export interface WorkerDeviceTlsIdentity {
  readonly certificatePem: string;
  readonly certificateAuthorityPem: string;
  readonly certificateGeneration: number;
  executeWithPrivateKeyBytes(
    executor: (pkcs8: Uint8Array) => unknown | Promise<unknown>,
  ): Promise<void>;
}

export interface WorkerDeviceChannelCallbacks {
  onDispatch?(frame: MainDispatchFrameV1, channel: WorkerDeviceChannelClient): Promise<void>;
  onControl?(frame: MainControlFrameV1): Promise<void>;
  onRunSteer?(frame: MainRunSteerFrameV1): Promise<WorkerRunSteeringReceiptV1>;
  onArtifactGrant?(frame: MainArtifactGrantFrameV1): Promise<void>;
  onArtifactRejected?(frame: MainArtifactRejectedFrameV1): Promise<void>;
  onRunLeaseDecision?(observation: WorkerRunLeaseDecisionObservation): Promise<void>;
  onRevoked?(): Promise<void>;
  /**
   * Applies the pinned upgrade for one adapter and returns what happened. The
   * receipt is sent for Main to record; the Worker decides the package and the
   * version from its own adapter constants.
   */
  onProviderUpgrade?(frame: MainProviderUpgradeFrameV1): Promise<WorkerProviderUpgradeResultV1>;
}

export interface ConnectWorkerDeviceChannelOptions extends WorkerDeviceChannelCallbacks {
  readonly endpointUrl: string;
  readonly deviceId: string;
  readonly workerId: string;
  readonly mainDeviceId: string;
  readonly identity: WorkerDeviceTlsIdentity;
  readonly state: SqliteWorkerChannelState;
  readonly connectTimeoutMs?: number;
  readonly maximumBufferedBytes?: number;
  readonly clock?: { now(): number };
  readonly monotonicClock?: { now(): number };
  readonly retryJitter?: () => number;
  readonly idSource?: () => string;
  readonly onLifecycleState?: (
    state: "hello-sent" | "ready" | "tls-authenticated" | "welcome-committed",
  ) => void;
}

export interface WorkerRunLeaseDecisionObservation {
  readonly frame: MainRunLeaseFrameV1;
  readonly receivedAtMonotonicMs: number;
  readonly responseRoundTripMs: number;
  readonly conservativeDeadlineMonotonicMs: number;
}

interface WorkerClockCalibration {
  readonly workerWallOriginMs: number;
  readonly workerMonotonicOriginMs: number;
  readonly maximumWorkerToMainOffsetMs: number;
  readonly maximumAbsoluteClockSkewMs: number;
  readonly maximumHandshakeRttMs: number;
}

interface EventAckWaiter {
  readonly sequence: number;
  readonly resolve: (ack: WorkerOutboxAckV1) => void;
  readonly reject: (error: Error) => void;
}

interface IdentityRotationWaiter {
  readonly resolve: (
    response: MainIdentityPendingFrameV1["payload"] | MainIdentityRenewedFrameV1["payload"],
  ) => void;
  readonly reject: (error: Error) => void;
}

interface ArtifactPrepareWaiter {
  readonly artifactId: string;
  readonly resolve: (grant: ArtifactUploadGrantV1) => void;
  readonly reject: (error: Error) => void;
}

interface RunLeaseWaiter {
  readonly request: WorkerRunLeaseRenewalRequestV1;
  readonly resolve: (observation: WorkerRunLeaseDecisionObservation) => void;
  readonly reject: (error: Error) => void;
}

export type WorkerActionAuthorizationDecisionV1 = Omit<
  MainActionAuthorizationFrameV1["payload"],
  "requestMessageId"
>;
export type WorkerActionConsumptionDecisionV1 = Omit<
  MainActionConsumptionFrameV1["payload"],
  "requestMessageId"
>;

type ActionWaiter =
  | {
      readonly kind: "authorize";
      readonly authorizationRequestId: string;
      readonly actionFingerprint: `sha256:${string}`;
      readonly resolve: (decision: WorkerActionAuthorizationDecisionV1) => void;
      readonly reject: (error: Error) => void;
    }
  | {
      readonly kind: "consume";
      readonly authorizationRequestId: string;
      readonly authorizationId: string;
      readonly actionFingerprint: `sha256:${string}`;
      readonly resolve: (decision: WorkerActionConsumptionDecisionV1) => void;
      readonly reject: (error: Error) => void;
    };

export class WorkerDeviceChannelClient implements WorkerMainConnection {
  private readonly options: ConnectWorkerDeviceChannelOptions;
  private readonly socket: WebSocket;
  private readonly waiters = new Map<string, EventAckWaiter>();
  private readonly artifactWaiters = new Map<string, ArtifactPrepareWaiter>();
  private readonly identityWaiters = new Map<string, IdentityRotationWaiter>();
  private readonly actionWaiters = new Map<string, ActionWaiter>();
  private readonly runLeaseWaiters = new Map<string, RunLeaseWaiter>();
  private readonly runLeaseSentAtMonotonicMs = new Map<string, number>();
  private readonly pendingRunLeaseRequestsAtConnect = new Map<string, WorkerRunLeaseRenewFrameV1>();
  private readonly deferredPreWelcomeFrames = new Map<
    string,
    MainDispatchFrameV1 | MainRunLeaseFrameV1 | MainRunSteerFrameV1
  >();
  private sendQueue: Promise<void> = Promise.resolve();
  private receiveQueue: Promise<void> = Promise.resolve();
  private pendingAcknowledgmentFrame: MainToWorkerFrameV1 | undefined;
  private deferMainAcknowledgments = true;
  private welcomeReceived = false;
  private closed = false;
  private helloWallSentAtMs: number | undefined;
  private helloMonotonicSentAtMs: number | undefined;
  private helloCorrelationId: string | undefined;
  private calibration: WorkerClockCalibration | undefined;

  private constructor(options: ConnectWorkerDeviceChannelOptions, socket: WebSocket) {
    this.options = options;
    this.socket = socket;
  }

  public static async connect(
    options: ConnectWorkerDeviceChannelOptions,
  ): Promise<WorkerDeviceChannelClient> {
    validateConnectOptions(options);
    // Refuse before the handshake. TLS reports an expired client certificate as a
    // bare connection reset, so a Worker that only learns from the socket retries
    // forever without ever naming the reason it can no longer authenticate.
    assertDeviceCertificateUsable(options);
    const connectTimeoutMs = readBoundedPositiveInteger(
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      "connect timeout",
      300_000,
    );
    let connected: WorkerDeviceChannelClient | undefined;
    await options.identity.executeWithPrivateKeyBytes(async (pkcs8) => {
      if (!(pkcs8 instanceof Uint8Array) || pkcs8.byteLength === 0 || pkcs8.byteLength > 65_536) {
        throw new DeviceChannelClientError("The Worker private-key lease is invalid.");
      }
      const keyCopy = Buffer.from(pkcs8);
      try {
        const privateKey = createPrivateKey({
          key: keyCopy,
          format: "der",
          type: "pkcs8",
        });
        const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
        const socket = new WebSocket(options.endpointUrl, DEVICE_CHANNEL_SUBPROTOCOL, {
          ca: options.identity.certificateAuthorityPem,
          cert: options.identity.certificatePem,
          key: privateKeyPem,
          minVersion: "TLSv1.3",
          maxVersion: "TLSv1.3",
          rejectUnauthorized: true,
          maxPayload: MAX_DEVICE_CHANNEL_FRAME_BYTES,
          perMessageDeflate: false,
          followRedirects: false,
          handshakeTimeout: connectTimeoutMs,
        });
        const client = new WorkerDeviceChannelClient(options, socket);
        await client.open(connectTimeoutMs);
        connected = client;
      } catch (error) {
        if (error instanceof DeviceChannelClientError) {
          throw error;
        }
        throw new DeviceChannelClientError("The Worker private-key lease could not be used.");
      } finally {
        keyCopy.fill(0);
      }
    });
    if (connected === undefined) {
      throw new DeviceChannelClientError("The Worker private-key lease was not executed.");
    }
    return connected;
  }

  public async sendEvents(events: readonly SequencedWorkerEventV1[]): Promise<WorkerOutboxAckV1> {
    this.assertOpen();
    if (!Array.isArray(events) || events.length === 0 || events.length > 256) {
      throw new DeviceChannelClientError("The Worker event batch is invalid.");
    }
    const correlationId = events[0]?.correlationId ?? this.nextId();
    const frame = await this.options.state.enqueueOutbound((sequence) => ({
      ...this.envelope(sequence, correlationId),
      type: "worker.events",
      payload: { events },
    }));
    const ack = new Promise<WorkerOutboxAckV1>((resolve, reject) => {
      this.waiters.set(frame.messageId, {
        sequence: frame.sequence,
        resolve,
        reject,
      });
    });
    try {
      await this.send(frame);
    } catch (error) {
      this.waiters.delete(frame.messageId);
      throw error;
    }
    return ack;
  }

  public async sendHeartbeat(heartbeat: WorkerHeartbeatV1): Promise<void> {
    this.assertOpen();
    const frame = await this.options.state.enqueueOutbound((sequence) => ({
      ...this.envelope(sequence, this.nextId()),
      type: "worker.heartbeat",
      payload: heartbeat,
    }));
    await this.send(frame);
  }

  public async sendRouteIncident(incident: WorkerRouteIncidentV1): Promise<void> {
    this.assertOpen();
    const resume = await this.options.state.resume();
    const pending = resume.pendingOutbound.find(
      (frame): frame is WorkerRouteIncidentFrameV1 =>
        frame.type === "worker.route.incident" && frame.payload.incidentId === incident.incidentId,
    );
    if (pending !== undefined) {
      if (!isDeepStrictEqual(pending.payload, incident)) {
        throw new DeviceChannelClientError(
          "A durable route incident identity was reused with different evidence.",
        );
      }
      await this.send(pending);
      return;
    }
    const frame = await this.options.state.enqueueOutbound((sequence) => ({
      ...this.envelope(sequence, incident.fingerprint),
      type: "worker.route.incident",
      payload: incident,
    }));
    await this.send(frame);
  }

  /**
   * Offers a certificate request signed by a freshly generated key. The reply is
   * a certificate that cannot authenticate anything until {@link activateIdentity}
   * proves the Worker holds the matching private key.
   */
  public async rotateIdentity(
    certificateRequestPem: string,
  ): Promise<MainIdentityPendingFrameV1["payload"]> {
    const response = await this.requestIdentityDecision({
      type: "worker.identity.rotate",
      payload: {
        deviceId: this.options.deviceId,
        certificateRequestPem,
      },
    });
    if (!("activationChallenge" in response)) {
      throw new DeviceChannelClientError("Main answered a rotation offer with an activation.");
    }
    return response;
  }

  public async activateIdentity(input: {
    readonly certificatePem: string;
    readonly activationChallenge: string;
    readonly signature: string;
  }): Promise<MainIdentityRenewedFrameV1["payload"]> {
    const response = await this.requestIdentityDecision({
      type: "worker.identity.activate",
      payload: {
        deviceId: this.options.deviceId,
        certificatePem: input.certificatePem,
        activationChallenge: input.activationChallenge,
        signature: input.signature,
      },
    });
    if ("activationChallenge" in response) {
      throw new DeviceChannelClientError("Main answered an activation with a rotation offer.");
    }
    return response;
  }

  private async requestIdentityDecision(
    request:
      | {
          readonly type: "worker.identity.rotate";
          readonly payload: WorkerIdentityRotateFrameV1["payload"];
        }
      | {
          readonly type: "worker.identity.activate";
          readonly payload: WorkerIdentityActivateFrameV1["payload"];
        },
  ): Promise<MainIdentityPendingFrameV1["payload"] | MainIdentityRenewedFrameV1["payload"]> {
    this.assertOpen();
    const correlationId = this.nextId();
    const frame = await this.options.state.enqueueOutbound((sequence) => {
      const envelope = this.envelope(sequence, correlationId);
      return request.type === "worker.identity.rotate"
        ? { ...envelope, type: request.type, payload: request.payload }
        : { ...envelope, type: request.type, payload: request.payload };
    });
    const response = new Promise<
      MainIdentityPendingFrameV1["payload"] | MainIdentityRenewedFrameV1["payload"]
    >((resolve, reject) => {
      this.identityWaiters.set(frame.messageId, { resolve, reject });
    });
    try {
      await this.send(frame);
    } catch (error) {
      this.identityWaiters.delete(frame.messageId);
      throw error;
    }
    return response;
  }

  private async acceptProviderUpgrade(frame: MainProviderUpgradeFrameV1): Promise<void> {
    if (frame.payload.deviceId !== this.options.deviceId) {
      throw new DeviceChannelClientError("The Main provider upgrade targets another Device.");
    }
    const outcome = this.options.onProviderUpgrade
      ? await this.options.onProviderUpgrade(frame)
      : ({
          adapterId: frame.payload.adapterId,
          status: "failed",
          code: "ADAPTER_UNKNOWN",
        } as const);
    const receipt = await this.options.state.enqueueOutbound((sequence) => {
      const envelope = {
        ...this.envelope(sequence, frame.payload.requestId),
        type: "worker.provider.upgraded" as const,
      };
      const identity = {
        requestId: frame.payload.requestId,
        deviceId: this.options.deviceId,
      };
      return outcome.status === "failed"
        ? { ...envelope, payload: { ...identity, ...outcome } }
        : { ...envelope, payload: { ...identity, ...outcome } };
    });
    await this.send(receipt);
  }

  private acceptIdentityResponse(
    frame: MainIdentityPendingFrameV1 | MainIdentityRejectedFrameV1 | MainIdentityRenewedFrameV1,
  ): void {
    if (
      frame.payload.deviceId !== this.options.deviceId ||
      frame.correlationId !== frame.payload.requestMessageId
    ) {
      throw new DeviceChannelClientError("The Main identity response targets another request.");
    }
    const waiter = this.identityWaiters.get(frame.payload.requestMessageId);
    if (waiter === undefined) {
      return;
    }
    this.identityWaiters.delete(frame.payload.requestMessageId);
    if (frame.type === "main.identity.rejected") {
      waiter.reject(new IdentityRotationRejectedError(frame.payload.code, frame.payload.retryable));
      return;
    }
    waiter.resolve(frame.payload);
  }

  public async prepareArtifact(
    manifest: ArtifactPrepareManifestV1,
  ): Promise<ArtifactUploadGrantV1> {
    this.assertOpen();
    if (
      manifest.deviceId !== this.options.deviceId ||
      manifest.workerId !== this.options.workerId
    ) {
      throw new DeviceChannelClientError(
        "The Artifact prepare manifest targets a different Worker.",
      );
    }
    const frame = await this.options.state.enqueueOutbound((sequence) => ({
      ...this.envelope(sequence, manifest.taskId),
      type: "worker.artifact.prepare",
      payload: manifest,
    }));
    const response = new Promise<ArtifactUploadGrantV1>((resolve, reject) => {
      this.artifactWaiters.set(frame.messageId, {
        artifactId: manifest.artifactId,
        resolve,
        reject,
      });
    });
    try {
      await this.send(frame);
    } catch (error) {
      this.artifactWaiters.delete(frame.messageId);
      throw error;
    }
    return response;
  }

  public authorizeAction(
    request: WorkerActionAuthorizationRequestV1,
  ): Promise<WorkerActionAuthorizationDecisionV1> {
    return this.requestActionDecision("authorize", request);
  }

  public consumeActionAuthorization(
    request: WorkerActionConsumptionRequestV1,
  ): Promise<WorkerActionConsumptionDecisionV1> {
    return this.requestActionDecision("consume", request);
  }

  public createRunLeaseAuthority(
    assignment: WorkerRunAssignmentV1,
  ): CalibratedWorkerRunLeaseAuthority {
    return new CalibratedWorkerRunLeaseAuthority(assignment, this, this.nextId.bind(this));
  }

  public async renewRunLease(
    request: WorkerRunLeaseRenewalRequestV1,
    conservativeCurrentDeadlineMonotonicMs: number,
  ): Promise<WorkerRunLeaseDecisionObservation> {
    this.assertOpen();
    if (request.deviceId !== this.options.deviceId || request.workerId !== this.options.workerId) {
      throw new DeviceChannelClientError("The Run lease renewal targets another Worker.");
    }
    if (
      !Number.isFinite(conservativeCurrentDeadlineMonotonicMs) ||
      conservativeCurrentDeadlineMonotonicMs <= this.monotonicNow()
    ) {
      throw new DeviceChannelClientError("The Run lease renewal deadline has elapsed.");
    }
    const frame = (await this.options.state.enqueueOutbound((sequence) => ({
      ...this.envelope(sequence, request.runId),
      idempotencyKey: request.renewalId,
      type: "worker.run.renew",
      payload: request,
    }))) as WorkerRunLeaseRenewFrameV1;
    let resolveResponse!: (observation: WorkerRunLeaseDecisionObservation) => void;
    let rejectResponse!: (error: Error) => void;
    const response = new Promise<WorkerRunLeaseDecisionObservation>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    this.runLeaseWaiters.set(frame.messageId, {
      request,
      resolve: resolveResponse,
      reject: rejectResponse,
    });
    let retryDelayMs = INITIAL_RENEWAL_RETRY_MS;
    try {
      for (let attempt = 0; attempt < MAXIMUM_RENEWAL_ATTEMPTS; attempt += 1) {
        const beforeSend = this.monotonicNow();
        if (beforeSend >= conservativeCurrentDeadlineMonotonicMs) {
          break;
        }
        await this.send(frame);
        const maximumWaitMs = Math.min(
          this.requireCalibration().maximumHandshakeRttMs,
          Math.max(0, conservativeCurrentDeadlineMonotonicMs - this.monotonicNow()),
        );
        if (maximumWaitMs <= 0) {
          break;
        }
        const observed = await raceWithMonotonicTimeout(response, maximumWaitMs);
        if (observed !== undefined) {
          return observed;
        }
        const jitteredDelayMs = Math.floor(retryDelayMs * (0.75 + 0.5 * this.retryJitter()));
        if (
          attempt + 1 >= MAXIMUM_RENEWAL_ATTEMPTS ||
          this.monotonicNow() + jitteredDelayMs >= conservativeCurrentDeadlineMonotonicMs
        ) {
          break;
        }
        await delay(jitteredDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, 2_000);
      }
      throw new DeviceChannelClientError(
        "The Run lease renewal did not complete before its conservative deadline.",
      );
    } finally {
      this.runLeaseWaiters.delete(frame.messageId);
      this.runLeaseSentAtMonotonicMs.delete(frame.messageId);
    }
  }

  public conservativeDeadlineForMainExpiry(mainExpiresAtMs: number): number {
    if (!Number.isSafeInteger(mainExpiresAtMs) || mainExpiresAtMs < 0) {
      throw new DeviceChannelClientError("The Main expiry is invalid.");
    }
    const monotonicNow = this.monotonicNow();
    const maximumMainNow = this.maximumMainWallAt(monotonicNow);
    return monotonicNow + Math.max(0, mainExpiresAtMs - maximumMainNow);
  }

  public isCalibratedClockHealthy(): boolean {
    try {
      this.assertClockConsistent(this.monotonicNow(), this.now());
      return this.calibration !== undefined;
    } catch {
      return false;
    }
  }

  public monotonicNow(): number {
    const value = (this.options.monotonicClock ?? { now: () => performance.now() }).now();
    if (!Number.isFinite(value) || value < 0) {
      throw new DeviceChannelClientError("The Worker monotonic clock is invalid.");
    }
    return value;
  }

  public get isClosed(): boolean {
    return this.closed;
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const error = new DeviceChannelClientError("The Worker Device channel closed.");
    for (const waiter of this.waiters.values()) {
      waiter.reject(error);
    }
    this.waiters.clear();
    for (const waiter of this.identityWaiters.values()) {
      waiter.reject(error);
    }
    this.identityWaiters.clear();
    for (const waiter of this.artifactWaiters.values()) {
      waiter.reject(error);
    }
    this.artifactWaiters.clear();
    for (const waiter of this.actionWaiters.values()) {
      waiter.reject(error);
    }
    this.actionWaiters.clear();
    for (const waiter of this.runLeaseWaiters.values()) {
      waiter.reject(error);
    }
    this.runLeaseWaiters.clear();
    if (this.socket.readyState === WebSocket.CLOSED) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.socket.terminate();
        resolve();
      }, 1_000);
      timeout.unref();
      this.socket.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
      this.socket.close(1000, "Worker shutdown");
    });
  }

  private async open(connectTimeoutMs: number): Promise<void> {
    const resume = await this.options.state.resume();
    for (const pending of resume.pendingOutbound) {
      if (pending.type === "worker.run.renew") {
        this.pendingRunLeaseRequestsAtConnect.set(pending.messageId, pending);
      }
    }
    await new Promise<void>((resolve, reject) => {
      const fail = (error?: Error): void => {
        cleanup();
        reject(
          new DeviceChannelClientError(
            `The Worker Device channel could not connect${safeErrorCode(error)}.`,
          ),
        );
      };
      const opened = (): void => {
        cleanup();
        const tlsSocket = this.readTlsSocket();
        if (!tlsSocket.authorized || this.socket.protocol !== DEVICE_CHANNEL_SUBPROTOCOL) {
          reject(new DeviceChannelClientError("The Main TLS identity was not authenticated."));
          return;
        }
        resolve();
      };
      const cleanup = (): void => {
        this.socket.off("error", fail);
        this.socket.off("close", fail);
        this.socket.off("open", opened);
      };
      this.socket.once("error", fail);
      this.socket.once("close", fail);
      this.socket.once("open", opened);
    });
    // Do not create the welcome waiter until the TLS socket is open. When an
    // endpoint refuses the connection, separate pre-open and welcome promises
    // reject from the same socket error; only the former is awaited, leaving the
    // latter as an unhandled rejection that terminates the Worker instead of
    // allowing its deterministic reconnect loop to continue.
    const welcome = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new DeviceChannelClientError("The Main welcome timed out."));
      }, connectTimeoutMs);
      timeout.unref();
      const fail = (error?: Error): void => {
        clearTimeout(timeout);
        reject(
          new DeviceChannelClientError(
            `The Worker Device channel handshake failed${safeErrorCode(error)}.`,
          ),
        );
      };
      this.socket.once("error", fail);
      this.socket.once("close", fail);
      this.socket.on("message", (bytes, binary) => {
        this.receiveQueue = this.receiveQueue
          .then(async () => {
            const didWelcome = await this.handleMessage(bytes, binary);
            if (didWelcome && !this.welcomeReceived) {
              this.welcomeReceived = true;
              clearTimeout(timeout);
              this.socket.off("error", fail);
              this.socket.off("close", fail);
              resolve();
            }
          })
          .catch((error: unknown) => {
            this.socket.close(4002, "Main frame rejected");
            clearTimeout(timeout);
            reject(
              error instanceof Error
                ? error
                : new DeviceChannelClientError("The Main frame was rejected."),
            );
          });
      });
    });
    this.observeLifecycle("tls-authenticated");
    this.helloMonotonicSentAtMs = this.monotonicNow();
    this.helloWallSentAtMs = this.now();
    this.helloCorrelationId = this.nextId();
    const hello: WorkerToMainFrameV1 = {
      ...this.envelope(resume.nextWorkerSequence, this.helloCorrelationId),
      type: "worker.hello",
      payload: {
        deviceId: this.options.deviceId,
        workerId: this.options.workerId,
        certificateGeneration: this.options.identity.certificateGeneration,
        minimumProtocolVersion: PROTOCOL_VERSION,
        maximumProtocolVersion: PROTOCOL_VERSION,
        acknowledgedMainSequence: resume.acknowledgedMainSequence,
        workerWallSentAtMs: this.helloWallSentAtMs,
      },
    };
    await this.sendDirect(hello);
    this.observeLifecycle("hello-sent");
    await welcome;
    for (const frame of (await this.options.state.resume()).pendingOutbound) {
      await this.send(frame);
    }
    this.deferMainAcknowledgments = false;
    await this.flushMainAcknowledgment();
    this.observeLifecycle("ready");
  }

  private async handleMessage(bytes: RawData, binary: boolean): Promise<boolean> {
    if (binary) {
      throw new DeviceChannelClientError("Binary Device channel frames are forbidden.");
    }
    const frame = decodeDeviceChannelFrame(
      toFrameBytes(bytes),
      this.options.mainDeviceId,
      "main-to-worker",
    ) as MainToWorkerFrameV1;
    const receivedAtMonotonicMs = this.monotonicNow();
    const receivedAtWallMs = this.now();
    await this.options.state.commitInbound(frame);
    const currentWelcome =
      frame.type === "main.welcome" &&
      frame.correlationId === this.helloCorrelationId &&
      frame.payload.workerWallSentAtMs === this.helloWallSentAtMs;
    if (
      (frame.type === "main.run.lease" ||
        frame.type === "main.run.steer" ||
        frame.type === "main.dispatch") &&
      this.calibration === undefined
    ) {
      this.assertCalibrationDependentFrameScope(frame);
      this.deferredPreWelcomeFrames.set(frame.messageId, frame);
      return false;
    }
    const claimId = randomUUID();
    const claim = await this.options.state.claimInboundEffect(frame, claimId);
    if (claim.disposition === "processing") {
      throw new DeviceChannelClientError("The inbound Main effect is already processing.");
    }
    if (claim.disposition === "claimed") {
      try {
        if (frame.type === "main.welcome") {
          if (currentWelcome) {
            if (
              frame.payload.deviceId !== this.options.deviceId ||
              frame.payload.acknowledgedWorkerSequence >
                (await this.options.state.resume()).nextWorkerSequence - 1
            ) {
              throw new DeviceChannelClientError("The Main welcome is outside the Worker scope.");
            }
            this.acceptClockCalibration(frame, receivedAtMonotonicMs, receivedAtWallMs);
            await this.acceptDeferredCalibrationFrames();
            await this.acceptWorkerAcknowledgment(
              frame.payload.acknowledgedWorkerSequence,
              frame.correlationId,
              [],
            );
          } else if (frame.payload.deviceId !== this.options.deviceId) {
            throw new DeviceChannelClientError("A stale Main welcome targets another Worker.");
          }
        } else if (frame.type === "main.ack") {
          await this.acceptWorkerAcknowledgment(
            frame.payload.acknowledgedWorkerSequence,
            frame.correlationId,
            frame.payload.acknowledgedMessageIds,
          );
        } else if (
          frame.type === "main.identity.pending" ||
          frame.type === "main.identity.renewed" ||
          frame.type === "main.identity.rejected"
        ) {
          this.acceptIdentityResponse(frame);
        } else if (frame.type === "main.artifact.grant") {
          await this.acceptArtifactGrant(frame);
        } else if (frame.type === "main.artifact.rejected") {
          await this.acceptArtifactRejection(frame);
        } else if (frame.type === "main.action.authorization") {
          this.acceptActionAuthorization(frame);
        } else if (frame.type === "main.action.consumption") {
          this.acceptActionConsumption(frame);
        } else if (frame.type === "main.run.lease") {
          await this.acceptRunLeaseDecision(frame, receivedAtMonotonicMs, receivedAtWallMs);
        } else if (frame.type === "main.dispatch") {
          if (
            frame.payload.deviceId !== this.options.deviceId ||
            frame.payload.workerId !== this.options.workerId
          ) {
            throw new DeviceChannelClientError("The Main dispatch targets another Worker.");
          }
          await this.options.onDispatch?.(frame, this);
        } else if (frame.type === "main.run.steer") {
          await this.acceptRunSteering(frame);
        } else if (frame.type === "main.provider.upgrade") {
          await this.acceptProviderUpgrade(frame);
        } else if (frame.type === "main.control") {
          await this.options.onControl?.(frame);
        } else if (frame.type === "main.revoked") {
          await this.options.onRevoked?.();
        } else if (frame.type === "main.ping") {
          const pong = await this.options.state.enqueueOutbound((sequence) => ({
            ...this.envelope(sequence, frame.messageId),
            type: "worker.pong",
            payload: {
              pingId: frame.payload.pingId,
              observedAtMs: this.now(),
            },
          }));
          await this.send(pong);
        }
      } catch (error) {
        await this.options.state.releaseInboundEffect(frame, claimId);
        throw error;
      }
      await this.options.state.completeInboundEffect(frame, claimId);
    } else if (frame.type === "main.dispatch") {
      if (
        frame.payload.deviceId !== this.options.deviceId ||
        frame.payload.workerId !== this.options.workerId
      ) {
        throw new DeviceChannelClientError("The Main dispatch targets another Worker.");
      }
    } else if (
      frame.type === "main.run.steer" &&
      (frame.payload.deviceId !== this.options.deviceId ||
        frame.payload.workerId !== this.options.workerId ||
        frame.payload.requestId !== frame.messageId)
    ) {
      throw new DeviceChannelClientError(
        "The Main Run steering command targets another Worker or request.",
      );
    } else if (
      (frame.type === "main.artifact.grant" || frame.type === "main.artifact.rejected") &&
      (frame.payload.deviceId !== this.options.deviceId ||
        frame.correlationId !== frame.payload.requestMessageId)
    ) {
      throw new DeviceChannelClientError("The Main Artifact response targets another request.");
    } else if (
      frame.type === "main.run.lease" &&
      (frame.payload.deviceId !== this.options.deviceId ||
        frame.payload.workerId !== this.options.workerId ||
        frame.correlationId !== frame.payload.requestMessageId)
    ) {
      throw new DeviceChannelClientError("The Main Run lease decision targets another request.");
    }
    if (currentWelcome) {
      this.observeLifecycle("welcome-committed");
    }
    this.pendingAcknowledgmentFrame = frame;
    if (!this.deferMainAcknowledgments) {
      await this.flushMainAcknowledgment();
    }
    if (frame.type === "main.revoked") {
      await this.close();
    }
    return currentWelcome;
  }

  private async enqueueRunSteeringReceipt(
    request: MainRunSteerFrameV1,
    receiptInput: WorkerRunSteeringReceiptV1,
  ): Promise<WorkerRunSteeringReceiptFrameV1> {
    const receipt = assertRunSteeringReceipt(request, receiptInput);
    const identity = runSteeringReceiptIdentity(request.messageId);
    try {
      return (await this.options.state.enqueueOutbound((sequence) => ({
        ...this.envelope(sequence, request.messageId),
        messageId: identity,
        idempotencyKey: identity,
        type: "worker.run.steering",
        payload: receipt,
      }))) as WorkerRunSteeringReceiptFrameV1;
    } catch (error) {
      const replay = (await this.options.state.resume()).pendingOutbound.find(
        (frame) => frame.idempotencyKey === identity,
      );
      if (replay === undefined) {
        throw error;
      }
      return assertRunSteeringReceiptReplay(replay, request, receipt, identity);
    }
  }

  private async acceptRunSteering(frame: MainRunSteerFrameV1): Promise<void> {
    if (
      frame.payload.deviceId !== this.options.deviceId ||
      frame.payload.workerId !== this.options.workerId ||
      frame.payload.requestId !== frame.messageId
    ) {
      throw new DeviceChannelClientError(
        "The Main Run steering command targets another Worker or request.",
      );
    }
    if (this.options.onRunSteer === undefined) {
      throw new DeviceChannelClientError("The Worker Run steering handler is unavailable.");
    }
    const receipt = await this.options.onRunSteer(frame);
    const response = await this.enqueueRunSteeringReceipt(frame, receipt);
    await this.send(response);
  }

  private async flushMainAcknowledgment(): Promise<void> {
    const frame = this.pendingAcknowledgmentFrame;
    if (frame === undefined) {
      return;
    }
    const acknowledgment = await this.options.state.enqueueMainAcknowledgment(
      (sequence, durableAck) => this.createMainAcknowledgment(sequence, frame, durableAck),
    );
    this.pendingAcknowledgmentFrame = undefined;
    if (acknowledgment !== undefined) {
      await this.send(acknowledgment);
    }
  }

  private async acceptArtifactGrant(frame: MainArtifactGrantFrameV1): Promise<void> {
    if (
      frame.payload.deviceId !== this.options.deviceId ||
      frame.correlationId !== frame.payload.requestMessageId
    ) {
      throw new DeviceChannelClientError("The Main Artifact grant targets another request.");
    }
    const waiter = this.artifactWaiters.get(frame.payload.requestMessageId);
    if (waiter !== undefined && waiter.artifactId !== frame.payload.grant.artifactId) {
      throw new DeviceChannelClientError("The Main Artifact grant changed the requested Artifact.");
    }
    await this.options.onArtifactGrant?.(frame);
    if (waiter !== undefined) {
      this.artifactWaiters.delete(frame.payload.requestMessageId);
      waiter.resolve(frame.payload.grant);
    }
  }

  private async acceptArtifactRejection(frame: MainArtifactRejectedFrameV1): Promise<void> {
    if (
      frame.payload.deviceId !== this.options.deviceId ||
      frame.correlationId !== frame.payload.requestMessageId
    ) {
      throw new DeviceChannelClientError("The Main Artifact rejection targets another request.");
    }
    const waiter = this.artifactWaiters.get(frame.payload.requestMessageId);
    if (waiter !== undefined && waiter.artifactId !== frame.payload.artifactId) {
      throw new DeviceChannelClientError(
        "The Main Artifact rejection changed the requested Artifact.",
      );
    }
    await this.options.onArtifactRejected?.(frame);
    if (waiter !== undefined) {
      this.artifactWaiters.delete(frame.payload.requestMessageId);
      waiter.reject(
        new ArtifactPrepareRejectedError(
          frame.payload.artifactId,
          frame.payload.code,
          frame.payload.retryable,
        ),
      );
    }
  }

  private acceptActionAuthorization(frame: MainActionAuthorizationFrameV1): void {
    if (frame.correlationId !== frame.payload.requestMessageId) {
      throw new DeviceChannelClientError("The Main action authorization targets another request.");
    }
    const waiter = this.actionWaiters.get(frame.payload.requestMessageId);
    if (
      waiter !== undefined &&
      (waiter.kind !== "authorize" ||
        waiter.authorizationRequestId !== frame.payload.authorizationRequestId ||
        waiter.actionFingerprint !== frame.payload.actionFingerprint)
    ) {
      throw new DeviceChannelClientError(
        "The Main action authorization changed the exact action identity.",
      );
    }
    if (waiter?.kind === "authorize") {
      this.actionWaiters.delete(frame.payload.requestMessageId);
      waiter.resolve(
        Object.freeze({
          authorizationRequestId: frame.payload.authorizationRequestId,
          authorizationId: frame.payload.authorizationId,
          actionFingerprint: frame.payload.actionFingerprint,
          decision: frame.payload.decision,
          reasonCode: frame.payload.reasonCode,
        }),
      );
    }
  }

  private acceptActionConsumption(frame: MainActionConsumptionFrameV1): void {
    if (frame.correlationId !== frame.payload.requestMessageId) {
      throw new DeviceChannelClientError("The Main action consumption targets another request.");
    }
    const waiter = this.actionWaiters.get(frame.payload.requestMessageId);
    if (
      waiter !== undefined &&
      (waiter.kind !== "consume" ||
        waiter.authorizationRequestId !== frame.payload.authorizationRequestId ||
        waiter.authorizationId !== frame.payload.authorizationId ||
        waiter.actionFingerprint !== frame.payload.actionFingerprint)
    ) {
      throw new DeviceChannelClientError(
        "The Main action consumption changed the exact authorization identity.",
      );
    }
    if (waiter?.kind === "consume") {
      this.actionWaiters.delete(frame.payload.requestMessageId);
      waiter.resolve(
        Object.freeze({
          authorizationRequestId: frame.payload.authorizationRequestId,
          authorizationId: frame.payload.authorizationId,
          actionFingerprint: frame.payload.actionFingerprint,
          decision: frame.payload.decision,
          reasonCode: frame.payload.reasonCode,
        }),
      );
    }
  }

  private acceptClockCalibration(
    frame: MainWelcomeFrameV1,
    receivedAtMonotonicMs: number,
    receivedAtWallMs: number,
  ): void {
    const sentAtMonotonicMs = this.helloMonotonicSentAtMs;
    const sentAtWallMs = this.helloWallSentAtMs;
    if (
      sentAtMonotonicMs === undefined ||
      sentAtWallMs === undefined ||
      frame.payload.workerWallSentAtMs !== sentAtWallMs ||
      frame.payload.maximumHandshakeRttMs > DEFAULT_MAXIMUM_HANDSHAKE_RTT_MS ||
      frame.payload.maximumAbsoluteClockSkewMs > DEFAULT_MAXIMUM_ABSOLUTE_CLOCK_SKEW_MS ||
      frame.payload.mainReceivedAtMs > frame.payload.mainSentAtMs
    ) {
      throw new DeviceChannelClientError("The Main clock calibration is invalid.");
    }
    const roundTripMs = receivedAtMonotonicMs - sentAtMonotonicMs;
    if (
      !Number.isFinite(roundTripMs) ||
      roundTripMs < 0 ||
      roundTripMs > frame.payload.maximumHandshakeRttMs
    ) {
      throw new DeviceChannelClientError("The Device channel handshake RTT is unsafe.");
    }
    const projectedWorkerWallAtReceiveMs = sentAtWallMs + roundTripMs;
    if (
      Math.abs(receivedAtWallMs - projectedWorkerWallAtReceiveMs) >
      frame.payload.maximumAbsoluteClockSkewMs
    ) {
      throw new DeviceChannelClientError("The Worker wall clock changed during calibration.");
    }
    const minimumWorkerToMainOffsetMs =
      frame.payload.mainReceivedAtMs - projectedWorkerWallAtReceiveMs;
    const maximumWorkerToMainOffsetMs = frame.payload.mainSentAtMs - sentAtWallMs;
    if (
      minimumWorkerToMainOffsetMs > maximumWorkerToMainOffsetMs ||
      Math.max(Math.abs(minimumWorkerToMainOffsetMs), Math.abs(maximumWorkerToMainOffsetMs)) >
        frame.payload.maximumAbsoluteClockSkewMs
    ) {
      throw new DeviceChannelClientError("The Main and Worker clock offset is unsafe.");
    }
    this.calibration = Object.freeze({
      workerWallOriginMs: sentAtWallMs,
      workerMonotonicOriginMs: sentAtMonotonicMs,
      maximumWorkerToMainOffsetMs,
      maximumAbsoluteClockSkewMs: frame.payload.maximumAbsoluteClockSkewMs,
      maximumHandshakeRttMs: frame.payload.maximumHandshakeRttMs,
    });
  }

  private async acceptRunLeaseDecision(
    frame: MainRunLeaseFrameV1,
    receivedAtMonotonicMs: number,
    receivedAtWallMs: number,
  ): Promise<void> {
    this.assertRunLeaseDecisionScope(frame);
    this.assertClockConsistent(receivedAtMonotonicMs, receivedAtWallMs);
    const waiter = this.runLeaseWaiters.get(frame.payload.requestMessageId);
    const replayedRequest = this.pendingRunLeaseRequestsAtConnect.get(
      frame.payload.requestMessageId,
    );
    const expectedRequest = waiter?.request ?? replayedRequest?.payload;
    if (expectedRequest === undefined || !runLeaseRequestsMatch(expectedRequest, frame.payload)) {
      throw new DeviceChannelClientError(
        "The Main Run lease decision changed the exact renewal identity.",
      );
    }
    const sentAtMonotonicMs = this.runLeaseSentAtMonotonicMs.get(frame.payload.requestMessageId);
    const responseRoundTripMs =
      sentAtMonotonicMs === undefined ? 0 : receivedAtMonotonicMs - sentAtMonotonicMs;
    if (!Number.isFinite(responseRoundTripMs) || responseRoundTripMs < 0) {
      throw new DeviceChannelClientError("The Run lease response timing is invalid.");
    }
    const conservativeDeadlineMonotonicMs =
      frame.payload.status === "renewed"
        ? sentAtMonotonicMs === undefined
          ? this.conservativeDeadlineForMainExpiry(frame.payload.leaseExpiresAtMs)
          : receivedAtMonotonicMs +
            Math.max(
              0,
              frame.payload.leaseExpiresAtMs - frame.payload.renewedAtMs - responseRoundTripMs,
            )
        : receivedAtMonotonicMs;
    const observation = Object.freeze({
      frame,
      receivedAtMonotonicMs,
      responseRoundTripMs,
      conservativeDeadlineMonotonicMs,
    });
    await this.options.onRunLeaseDecision?.(observation);
    this.pendingRunLeaseRequestsAtConnect.delete(frame.payload.requestMessageId);
    if (waiter !== undefined) {
      this.runLeaseWaiters.delete(frame.payload.requestMessageId);
      waiter.resolve(observation);
    }
  }

  private assertRunLeaseDecisionScope(frame: MainRunLeaseFrameV1): void {
    if (
      frame.payload.deviceId !== this.options.deviceId ||
      frame.payload.workerId !== this.options.workerId ||
      frame.correlationId !== frame.payload.requestMessageId
    ) {
      throw new DeviceChannelClientError("The Main Run lease decision targets another request.");
    }
  }

  private assertCalibrationDependentFrameScope(
    frame: MainDispatchFrameV1 | MainRunLeaseFrameV1 | MainRunSteerFrameV1,
  ): void {
    if (frame.type === "main.run.lease") {
      this.assertRunLeaseDecisionScope(frame);
      return;
    }
    if (
      frame.payload.deviceId !== this.options.deviceId ||
      frame.payload.workerId !== this.options.workerId ||
      (frame.type === "main.run.steer" && frame.payload.requestId !== frame.messageId)
    ) {
      throw new DeviceChannelClientError("The Main Run command targets another Worker or request.");
    }
  }

  private async acceptDeferredCalibrationFrames(): Promise<void> {
    const deferred = [...this.deferredPreWelcomeFrames.values()].sort(
      (left, right) => left.sequence - right.sequence,
    );
    for (const frame of deferred) {
      const claimId = randomUUID();
      const claim = await this.options.state.claimInboundEffect(frame, claimId);
      if (claim.disposition === "processing") {
        throw new DeviceChannelClientError("The deferred Main effect is already processing.");
      }
      if (claim.disposition === "claimed") {
        try {
          if (frame.type === "main.run.lease") {
            await this.acceptRunLeaseDecision(frame, this.monotonicNow(), this.now());
          } else if (frame.type === "main.run.steer") {
            await this.acceptRunSteering(frame);
          } else {
            await this.options.onDispatch?.(frame, this);
          }
          await this.options.state.completeInboundEffect(frame, claimId);
        } catch (error) {
          await this.options.state.releaseInboundEffect(frame, claimId);
          throw error;
        }
      }
      this.deferredPreWelcomeFrames.delete(frame.messageId);
    }
  }

  private async requestActionDecision(
    kind: "authorize",
    request: WorkerActionAuthorizationRequestV1,
  ): Promise<WorkerActionAuthorizationDecisionV1>;
  private async requestActionDecision(
    kind: "consume",
    request: WorkerActionConsumptionRequestV1,
  ): Promise<WorkerActionConsumptionDecisionV1>;
  private async requestActionDecision(
    kind: "authorize" | "consume",
    request: WorkerActionAuthorizationRequestV1 | WorkerActionConsumptionRequestV1,
  ): Promise<WorkerActionAuthorizationDecisionV1 | WorkerActionConsumptionDecisionV1> {
    this.assertOpen();
    if (request.deviceId !== this.options.deviceId || request.workerId !== this.options.workerId) {
      throw new DeviceChannelClientError(
        "The action authorization request targets another Worker.",
      );
    }
    const frame =
      kind === "authorize"
        ? await this.options.state.enqueueOutbound((sequence) => ({
            ...this.envelope(sequence, request.authorizationRequestId),
            type: "worker.action.authorize",
            payload: request as WorkerActionAuthorizationRequestV1,
          }))
        : await this.options.state.enqueueOutbound((sequence) => ({
            ...this.envelope(sequence, request.authorizationRequestId),
            type: "worker.action.consume",
            payload: request as WorkerActionConsumptionRequestV1,
          }));
    const response = new Promise<
      WorkerActionAuthorizationDecisionV1 | WorkerActionConsumptionDecisionV1
    >((resolve, reject) => {
      this.actionWaiters.set(
        frame.messageId,
        kind === "authorize"
          ? {
              kind,
              authorizationRequestId: request.authorizationRequestId,
              actionFingerprint: request.actionFingerprint,
              resolve: resolve as (decision: WorkerActionAuthorizationDecisionV1) => void,
              reject,
            }
          : {
              kind,
              authorizationRequestId: request.authorizationRequestId,
              authorizationId: (request as WorkerActionConsumptionRequestV1).authorizationId,
              actionFingerprint: request.actionFingerprint,
              resolve: resolve as (decision: WorkerActionConsumptionDecisionV1) => void,
              reject,
            },
      );
    });
    try {
      await this.send(frame);
    } catch (error) {
      this.actionWaiters.delete(frame.messageId);
      throw error;
    }
    return await response;
  }

  private async acceptWorkerAcknowledgment(
    acknowledgedWorkerSequence: number,
    correlationId: string,
    acknowledgedMessageIds: readonly string[],
  ): Promise<void> {
    const resume = await this.options.state.resume();
    if (acknowledgedWorkerSequence > resume.acknowledgedWorkerSequence) {
      await this.options.state.acknowledgeOutbound(acknowledgedWorkerSequence);
    }
    for (const [messageId, waiter] of this.waiters) {
      if (waiter.sequence <= acknowledgedWorkerSequence) {
        this.waiters.delete(messageId);
        waiter.resolve({
          protocolVersion: PROTOCOL_VERSION,
          acknowledgedMessageIds: messageId === correlationId ? [...acknowledgedMessageIds] : [],
        });
      }
    }
  }

  private createMainAcknowledgment(
    sequence: number,
    frame: MainToWorkerFrameV1,
    acknowledgment: WorkerMainAcknowledgment,
  ): WorkerToMainFrameV1 {
    return {
      ...this.envelope(sequence, frame.messageId),
      type: "worker.ack",
      payload: acknowledgment,
    };
  }

  private async send(frame: WorkerToMainFrameV1): Promise<void> {
    this.assertOpen();
    this.sendQueue = this.sendQueue.then(() => this.sendDirect(frame));
    return this.sendQueue;
  }

  private async sendDirect(frame: WorkerToMainFrameV1): Promise<void> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new DeviceChannelClientError("The Worker Device channel is offline.");
    }
    const encoded = encodeDeviceChannelFrame(frame);
    const maximumBufferedBytes = readBoundedPositiveInteger(
      this.options.maximumBufferedBytes ?? DEFAULT_MAXIMUM_BUFFERED_BYTES,
      "maximum buffered bytes",
      64 * MAX_DEVICE_CHANNEL_FRAME_BYTES,
    );
    if (this.socket.bufferedAmount + encoded.byteLength > maximumBufferedBytes) {
      this.socket.close(1013, "Channel backpressure");
      throw new DeviceChannelClientError("The Worker Device channel reached backpressure.");
    }
    try {
      if (
        frame.type === "worker.run.renew" &&
        !this.runLeaseSentAtMonotonicMs.has(frame.messageId)
      ) {
        this.runLeaseSentAtMonotonicMs.set(frame.messageId, this.monotonicNow());
      }
      this.socket.send(encoded, { binary: false, compress: false });
    } catch {
      throw new DeviceChannelClientError("A Worker channel frame could not be sent.");
    }
  }

  private envelope(
    sequence: number,
    correlationId: string,
  ): Omit<WorkerToMainFrameV1, "payload" | "type"> {
    const messageId = this.nextId();
    return {
      protocolVersion: PROTOCOL_VERSION,
      messageId,
      senderDeviceId: this.options.deviceId,
      correlationId,
      createdAt: new Date(this.now()).toISOString(),
      idempotencyKey: messageId,
      sequence,
    };
  }

  private readTlsSocket(): TLSSocket {
    const socket = (this.socket as WebSocket & { readonly _socket?: TLSSocket })._socket;
    if (socket === undefined) {
      throw new DeviceChannelClientError("The Device channel TLS socket is unavailable.");
    }
    return socket;
  }

  private nextId(): string {
    const value = (this.options.idSource ?? randomUUID)();
    validateIdentifier(value, "message ID");
    return value;
  }

  private now(): number {
    const value = (this.options.clock ?? { now: () => Date.now() }).now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new DeviceChannelClientError("The Worker Device channel clock is invalid.");
    }
    return value;
  }

  private maximumMainWallAt(monotonicAtMs: number): number {
    const calibration = this.requireCalibration();
    this.assertClockConsistent(monotonicAtMs, this.now());
    return (
      calibration.workerWallOriginMs +
      (monotonicAtMs - calibration.workerMonotonicOriginMs) +
      calibration.maximumWorkerToMainOffsetMs
    );
  }

  private assertClockConsistent(monotonicAtMs: number, wallAtMs: number): void {
    const calibration = this.requireCalibration();
    const projectedWorkerWallMs =
      calibration.workerWallOriginMs + (monotonicAtMs - calibration.workerMonotonicOriginMs);
    if (
      !Number.isFinite(projectedWorkerWallMs) ||
      Math.abs(wallAtMs - projectedWorkerWallMs) > calibration.maximumAbsoluteClockSkewMs
    ) {
      throw new DeviceChannelClientError(
        "The Worker wall clock diverged from its monotonic calibration.",
      );
    }
  }

  private requireCalibration(): WorkerClockCalibration {
    if (this.calibration === undefined) {
      throw new DeviceChannelClientError("The Worker clock is not calibrated.");
    }
    return this.calibration;
  }

  private retryJitter(): number {
    const value = (this.options.retryJitter ?? Math.random)();
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new DeviceChannelClientError("The Run lease retry jitter is invalid.");
    }
    return value;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new DeviceChannelClientError("The Worker Device channel is closed.");
    }
  }

  private observeLifecycle(
    state: "hello-sent" | "ready" | "tls-authenticated" | "welcome-committed",
  ): void {
    try {
      this.options.onLifecycleState?.(state);
    } catch {
      // Diagnostics must not affect the authenticated channel lifecycle.
    }
  }
}

export class DeviceChannelClientError extends Error {
  public readonly code = "DEVICE_CHANNEL_CLIENT_ERROR" as const;

  public constructor(message: string) {
    super(message);
    this.name = "DeviceChannelClientError";
  }
}

/**
 * Raised instead of attempting a handshake that the Device certificate can no
 * longer authenticate. It carries the validity window so the Worker can tell the
 * owner when the credential lapsed rather than reporting a transport failure.
 */
export class DeviceCertificateUnusableError extends Error {
  public readonly code = "DEVICE_CERTIFICATE_UNUSABLE" as const;
  public readonly deviceId: string;
  public readonly certificateGeneration: number;
  public readonly certificateSerial: string;
  public readonly state: DeviceCertificateLifecycleState;
  public readonly notBefore: number;
  public readonly notAfter: number;

  public constructor(input: {
    readonly certificateGeneration: number;
    readonly deviceId: string;
    readonly lifecycle: DeviceCertificateLifecycle;
  }) {
    super(
      input.lifecycle.state === "expired"
        ? `The Device certificate for ${input.deviceId} expired at ${new Date(
            input.lifecycle.notAfter,
          ).toISOString()}. Issue a new enrollment grant from Admin Web and re-enrol this Device.`
        : `The Device certificate for ${input.deviceId} does not take effect until ${new Date(
            input.lifecycle.notBefore,
          ).toISOString()}. Check this Device's clock.`,
    );
    this.name = "DeviceCertificateUnusableError";
    this.deviceId = input.deviceId;
    this.certificateGeneration = input.certificateGeneration;
    this.certificateSerial = input.lifecycle.serialNumber;
    this.state = input.lifecycle.state;
    this.notBefore = input.lifecycle.notBefore;
    this.notAfter = input.lifecycle.notAfter;
  }
}

export class IdentityRotationRejectedError extends Error {
  public readonly code: IdentityRotationRejectionCodeV1;
  public readonly retryable: boolean;

  public constructor(code: IdentityRotationRejectionCodeV1, retryable: boolean) {
    super(`Main refused the Device certificate rotation (${code}).`);
    this.name = "IdentityRotationRejectedError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class ArtifactPrepareRejectedError extends Error {
  public readonly artifactId: string;
  public readonly code: ArtifactPrepareRejectionCodeV1;
  public readonly retryable: boolean;

  public constructor(artifactId: string, code: ArtifactPrepareRejectionCodeV1, retryable: boolean) {
    super(`Main rejected Artifact preparation with ${code}.`);
    this.name = "ArtifactPrepareRejectedError";
    this.artifactId = artifactId;
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * Mutable, exact Run authority shared by the Worker Runtime and every
 * Run-scoped capability. A reconnect may attach a freshly calibrated channel,
 * but an already elapsed conservative deadline is never revived.
 */
export class CalibratedWorkerRunLeaseAuthority implements WorkerRunLeaseAuthority {
  private readonly assignment: WorkerRunAssignmentV1;
  private readonly idSource: () => string;
  private readonly observedRenewalIds = new Set<string>();
  private client: WorkerDeviceChannelClient;
  private leaseExpiresAtMs: number;
  private conservativeDeadlineMonotonicMs: number;
  private leaseDurationMs: number;
  private retired = false;
  private renewal: Promise<void> | undefined;

  public constructor(
    assignment: WorkerRunAssignmentV1,
    client: WorkerDeviceChannelClient,
    idSource: () => string = randomUUID,
  ) {
    this.assignment = structuredClone(assignment);
    this.client = client;
    this.idSource = idSource;
    this.leaseExpiresAtMs = assignment.leaseExpiresAtMs;
    this.conservativeDeadlineMonotonicMs = client.conservativeDeadlineForMainExpiry(
      assignment.leaseExpiresAtMs,
    );
    this.leaseDurationMs = Math.max(
      1,
      this.conservativeDeadlineMonotonicMs - client.monotonicNow(),
    );
  }

  public snapshot(): WorkerRunLeaseSnapshot {
    return Object.freeze({
      leaseExpiresAtMs: this.leaseExpiresAtMs,
      conservativeDeadlineMonotonicMs: this.conservativeDeadlineMonotonicMs,
    });
  }

  public isCurrent(): boolean {
    return (
      !this.retired &&
      this.client.isCalibratedClockHealthy() &&
      this.client.monotonicNow() < this.conservativeDeadlineMonotonicMs
    );
  }

  public attach(client: WorkerDeviceChannelClient): boolean {
    if (!this.isCurrent()) {
      this.retired = true;
      return false;
    }
    this.client = client;
    const recalibratedDeadline = client.conservativeDeadlineForMainExpiry(this.leaseExpiresAtMs);
    if (recalibratedDeadline <= client.monotonicNow()) {
      this.retired = true;
      return false;
    }
    this.conservativeDeadlineMonotonicMs = recalibratedDeadline;
    return true;
  }

  public acceptDecision(observation: WorkerRunLeaseDecisionObservation): void {
    const payload = observation.frame.payload;
    if (!this.matches(payload)) {
      throw new DeviceChannelClientError(
        "A Run lease decision targets a different exact authority.",
      );
    }
    if (this.observedRenewalIds.has(payload.renewalId)) {
      return;
    }
    this.observedRenewalIds.add(payload.renewalId);
    if (payload.priorLeaseExpiresAtMs < this.leaseExpiresAtMs) {
      // A concurrent/replayed request can be decided after another exact
      // renewal already advanced this authority. Its stale outcome cannot
      // revoke or revive the newer lease.
      return;
    }
    if (
      payload.priorLeaseExpiresAtMs > this.leaseExpiresAtMs ||
      observation.receivedAtMonotonicMs >= this.conservativeDeadlineMonotonicMs
    ) {
      this.retired = true;
      return;
    }
    if (payload.status === "renewed") {
      if (
        payload.leaseExpiresAtMs <= this.leaseExpiresAtMs ||
        observation.conservativeDeadlineMonotonicMs <= observation.receivedAtMonotonicMs
      ) {
        this.retired = true;
        return;
      }
      this.leaseExpiresAtMs = payload.leaseExpiresAtMs;
      this.conservativeDeadlineMonotonicMs = observation.conservativeDeadlineMonotonicMs;
      this.leaseDurationMs = payload.leaseExpiresAtMs - payload.renewedAtMs;
      return;
    }
    if (payload.reasonCode !== "RUN_LEASE_NOT_DUE" && payload.reasonCode !== "RUN_LEASE_CHANGED") {
      this.retired = true;
    }
  }

  public async renewIfDue(): Promise<void> {
    if (!this.isCurrent()) {
      this.retired = true;
      return;
    }
    const remainingMs = this.conservativeDeadlineMonotonicMs - this.client.monotonicNow();
    const renewalLeadMs = Math.max(MINIMUM_RENEWAL_LEAD_MS, this.leaseDurationMs * 0.2);
    if (remainingMs > renewalLeadMs) {
      return;
    }
    if (this.client.isClosed) {
      return;
    }
    if (this.renewal !== undefined) {
      return await this.renewal;
    }
    const request: WorkerRunLeaseRenewalRequestV1 = Object.freeze({
      taskId: this.assignment.taskId,
      workOrderId: this.assignment.workOrder.workOrderId,
      deviceId: this.assignment.deviceId,
      workerId: this.assignment.workerId,
      routeId: this.assignment.routeId,
      runId: this.assignment.runId,
      leaseId: this.assignment.leaseId,
      fencingToken: this.assignment.fencingToken,
      renewalId: this.idSource(),
      priorLeaseExpiresAtMs: this.leaseExpiresAtMs,
    });
    this.renewal = this.client
      .renewRunLease(request, this.conservativeDeadlineMonotonicMs)
      .then((observation) => {
        this.acceptDecision(observation);
      })
      .finally(() => {
        this.renewal = undefined;
      });
    return await this.renewal;
  }

  private matches(payload: MainRunLeaseFrameV1["payload"]): boolean {
    return (
      payload.taskId === this.assignment.taskId &&
      payload.workOrderId === this.assignment.workOrder.workOrderId &&
      payload.deviceId === this.assignment.deviceId &&
      payload.workerId === this.assignment.workerId &&
      payload.routeId === this.assignment.routeId &&
      payload.runId === this.assignment.runId &&
      payload.leaseId === this.assignment.leaseId &&
      payload.fencingToken === this.assignment.fencingToken
    );
  }
}

function runSteeringReceiptIdentity(requestMessageId: string): string {
  validateIdentifier(requestMessageId, "Run steering request message ID");
  return `run-steering-receipt:${createHash("sha256")
    .update(requestMessageId, "utf8")
    .digest("hex")}`;
}

function assertRunSteeringReceipt(
  request: MainRunSteerFrameV1,
  receipt: WorkerRunSteeringReceiptV1,
): WorkerRunSteeringReceiptV1 {
  const command = request.payload;
  if (
    receipt.requestId !== command.requestId ||
    receipt.requestMessageId !== request.messageId ||
    receipt.taskId !== command.taskId ||
    receipt.workOrderId !== command.workOrderId ||
    receipt.deviceId !== command.deviceId ||
    receipt.workerId !== command.workerId ||
    receipt.routeId !== command.routeId ||
    receipt.runId !== command.runId ||
    receipt.leaseId !== command.leaseId ||
    receipt.fencingToken !== command.fencingToken ||
    !isDeepStrictEqual(receipt.agentSession, command.agentSession)
  ) {
    throw new DeviceChannelClientError(
      "The Worker Run steering receipt escaped its exact command scope.",
    );
  }
  return structuredClone(receipt);
}

function assertRunSteeringReceiptReplay(
  frame: WorkerToMainFrameV1,
  request: MainRunSteerFrameV1,
  receipt: WorkerRunSteeringReceiptV1,
  identity: string,
): WorkerRunSteeringReceiptFrameV1 {
  if (
    frame.type !== "worker.run.steering" ||
    frame.senderDeviceId !== request.payload.deviceId ||
    frame.correlationId !== request.messageId ||
    frame.messageId !== identity ||
    frame.idempotencyKey !== identity ||
    !isDeepStrictEqual(frame.payload, receipt)
  ) {
    throw new DeviceChannelClientError(
      "The durable Run steering receipt identity conflicts with another Worker frame.",
    );
  }
  return frame;
}

function validateConnectOptions(options: ConnectWorkerDeviceChannelOptions): void {
  validateIdentifier(options.deviceId, "Device ID");
  validateIdentifier(options.workerId, "Worker ID");
  validateIdentifier(options.mainDeviceId, "Main Device ID");
  let endpoint: URL;
  try {
    endpoint = new URL(options.endpointUrl);
  } catch {
    throw new DeviceChannelClientError("The Device channel endpoint is invalid.");
  }
  if (
    endpoint.protocol !== "wss:" ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    endpoint.search.length > 0 ||
    endpoint.hash.length > 0
  ) {
    throw new DeviceChannelClientError(
      "The Device channel endpoint must be a credential-free wss URL.",
    );
  }
  if (
    !Number.isSafeInteger(options.identity.certificateGeneration) ||
    options.identity.certificateGeneration <= 0 ||
    !options.identity.certificatePem.includes("BEGIN CERTIFICATE") ||
    !options.identity.certificateAuthorityPem.includes("BEGIN CERTIFICATE")
  ) {
    throw new DeviceChannelClientError("The Worker TLS identity is invalid.");
  }
}

function assertDeviceCertificateUsable(options: ConnectWorkerDeviceChannelOptions): void {
  const now = options.clock?.now() ?? Date.now();
  let lifecycle: DeviceCertificateLifecycle;
  try {
    lifecycle = readDeviceCertificateLifecycle(options.identity.certificatePem, now);
  } catch {
    throw new DeviceChannelClientError("The Worker TLS identity is invalid.");
  }
  if (deviceCertificateIsUsable(lifecycle)) {
    return;
  }
  throw new DeviceCertificateUnusableError({
    certificateGeneration: options.identity.certificateGeneration,
    deviceId: options.deviceId,
    lifecycle,
  });
}

function validateIdentifier(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value !== value.trim() ||
    hasControlCharacter(value)
  ) {
    throw new DeviceChannelClientError(`${label} is invalid.`);
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

function readBoundedPositiveInteger(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new DeviceChannelClientError(`The ${label} is invalid.`);
  }
  return value;
}

function toFrameBytes(value: RawData): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return Buffer.concat(value);
  }
  return Buffer.from(value);
}

function safeErrorCode(error: Error | undefined): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,64}$/u.test(code) ? ` (${code})` : "";
}

function runLeaseRequestsMatch(
  expected: WorkerRunLeaseRenewalRequestV1,
  actual: MainRunLeaseFrameV1["payload"],
): boolean {
  return (
    expected.taskId === actual.taskId &&
    expected.workOrderId === actual.workOrderId &&
    expected.deviceId === actual.deviceId &&
    expected.workerId === actual.workerId &&
    expected.routeId === actual.routeId &&
    expected.runId === actual.runId &&
    expected.leaseId === actual.leaseId &&
    expected.fencingToken === actual.fencingToken &&
    expected.renewalId === actual.renewalId &&
    expected.priorLeaseExpiresAtMs === actual.priorLeaseExpiresAtMs
  );
}

async function raceWithMonotonicTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  return await Promise.race([
    promise,
    new Promise<undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), Math.max(1, Math.ceil(timeoutMs)));
      timer.unref();
    }),
  ]);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, Math.max(1, milliseconds));
    timer.unref();
  });
}
