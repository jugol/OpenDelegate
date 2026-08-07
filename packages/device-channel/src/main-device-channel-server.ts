import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { createServer, type Server as HttpsServer, type ServerOptions } from "node:https";
import type { AddressInfo } from "node:net";
import type { TLSSocket } from "node:tls";
import { isDeepStrictEqual } from "node:util";

import {
  DeviceIdentityError,
  type AuthenticatedDevicePeer,
  type ConfirmedDeviceIdentity,
  type DeviceIdentityAuthority,
  type IssuedPendingDeviceIdentity,
} from "@opendelegate/device-identity";
import { PROTOCOL_VERSION } from "@opendelegate/protocol";
import {
  validateWorkerRunSteeringCommand,
  type SequencedWorkerEventV1,
  type WorkerHeartbeatV1,
  type WorkerRouteIncidentV1,
  type WorkerRunAssignmentV1,
  type WorkerRunSteeringCommandV1,
  type WorkerRunSteeringReceiptV1,
} from "@opendelegate/worker-runtime";
import WebSocket, { WebSocketServer, type RawData } from "ws";

import type { DeviceChannelRepository } from "./channel-repository.ts";
import {
  MAX_DEVICE_CHANNEL_FRAME_BYTES,
  decodeDeviceChannelFrame,
  encodeDeviceChannelFrame,
  type MainControlFrameV1,
  type MainArtifactGrantFrameV1,
  type MainArtifactRejectedFrameV1,
  type MainActionAuthorizationFrameV1,
  type MainActionConsumptionFrameV1,
  type MainDispatchFrameV1,
  type MainIdentityPendingFrameV1,
  type MainIdentityRejectedFrameV1,
  type MainIdentityRenewedFrameV1,
  type MainRunLeaseFrameV1,
  type MainRunSteerFrameV1,
  type MainToWorkerFrameV1,
  type ArtifactPrepareManifestV1,
  type ArtifactPrepareRejectionCodeV1,
  type IdentityRotationRejectionCodeV1,
  type WorkerIdentityActivateFrameV1,
  type WorkerIdentityRotateFrameV1,
  type WorkerProviderUpgradedFrameV1,
  type WorkerArtifactPrepareFrameV1,
  type WorkerActionAuthorizeFrameV1,
  type WorkerActionConsumeFrameV1,
  type WorkerRunLeaseRenewFrameV1,
  type WorkerRunSteeringReceiptFrameV1,
  type WorkerRouteIncidentFrameV1,
  type WorkerToMainFrameV1,
} from "./protocol.ts";

const DEFAULT_CHANNEL_PATH = "/api/v1/device/channel";
const DEVICE_CHANNEL_SUBPROTOCOL = "opendelegate.device.v1";
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_MAXIMUM_IN_FLIGHT_FRAMES = 64;
const DEFAULT_MAXIMUM_BUFFERED_BYTES = 2 * MAX_DEVICE_CHANNEL_FRAME_BYTES;
const FIRST_FRAME_TIMEOUT_MS = 15_000;
const DEFAULT_MAXIMUM_HANDSHAKE_RTT_MS = 5_000;
const DEFAULT_MAXIMUM_ABSOLUTE_CLOCK_SKEW_MS = 60_000;

export interface MainDeviceChannelTlsOptions {
  readonly certificateAuthorityPem: string;
  readonly certificate: ServerOptions["cert"];
  readonly privateKey: ServerOptions["key"];
}

export interface MainDeviceChannelClock {
  now(): number;
}

export interface MainDeviceChannelCallbacks {
  onEvents?(deviceId: string, events: readonly SequencedWorkerEventV1[]): Promise<void>;
  onHeartbeat?(deviceId: string, heartbeat: WorkerHeartbeatV1): Promise<void>;
  onArtifactPrepare?(input: MainArtifactPrepareRequest): Promise<MainArtifactPrepareDecision>;
  onActionAuthorize?(
    input: MainActionAuthorizationRequest,
  ): Promise<MainActionAuthorizationDecision>;
  onActionConsume?(input: MainActionConsumptionRequest): Promise<MainActionConsumptionDecision>;
  onRunLeaseRenew?(input: MainRunLeaseRenewalRequest): Promise<MainRunLeaseRenewalDecision>;
  onRunSteeringReceipt?(input: MainRunSteeringReceiptObservation): Promise<void>;
  onRouteIncident?(input: MainRouteIncidentRequest): Promise<void>;
  onProviderUpgraded?(input: MainProviderUpgradeObservation): Promise<void>;
}

export interface MainRunSteeringReceiptObservation {
  readonly authenticatedDeviceId: string;
  readonly receiptMessageId: string;
  readonly idempotencyKey: string;
  readonly receipt: WorkerRunSteeringReceiptV1;
  readonly receivedAtMs: number;
}

export interface MainProviderUpgradeObservation {
  readonly authenticatedDeviceId: string;
  readonly receiptMessageId: string;
  readonly receipt: WorkerProviderUpgradedFrameV1["payload"];
  readonly receivedAtMs: number;
}

export interface MainRouteIncidentRequest {
  readonly authenticatedDeviceId: string;
  readonly requestMessageId: string;
  readonly idempotencyKey: string;
  readonly incident: WorkerRouteIncidentV1;
  readonly receivedAtMs: number;
}

export interface MainArtifactPrepareRequest {
  readonly authenticatedDeviceId: string;
  readonly requestMessageId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly manifest: ArtifactPrepareManifestV1;
}

export type MainArtifactPrepareDecision =
  | {
      readonly status: "granted";
      readonly grant: MainArtifactGrantFrameV1["payload"]["grant"];
    }
  | {
      readonly status: "rejected";
      readonly code: ArtifactPrepareRejectionCodeV1;
      readonly retryable: boolean;
    };

type MainArtifactPrepareResponseFrameV1 = MainArtifactGrantFrameV1 | MainArtifactRejectedFrameV1;

export interface MainActionAuthorizationRequest {
  readonly authenticatedDeviceId: string;
  readonly requestMessageId: string;
  readonly idempotencyKey: string;
  readonly request: WorkerActionAuthorizeFrameV1["payload"];
}

export interface MainActionConsumptionRequest {
  readonly authenticatedDeviceId: string;
  readonly requestMessageId: string;
  readonly idempotencyKey: string;
  readonly request: WorkerActionConsumeFrameV1["payload"];
}

export interface MainActionAuthorizationDecision {
  readonly decision: "allow" | "deny" | "require-approval";
  readonly authorizationId: string;
  readonly reasonCode: string;
}

export interface MainActionConsumptionDecision {
  readonly decision: "consumed" | "deny";
  readonly reasonCode: string;
}

export interface MainRunLeaseRenewalRequest {
  readonly authenticatedDeviceId: string;
  readonly requestMessageId: string;
  readonly idempotencyKey: string;
  readonly request: WorkerRunLeaseRenewFrameV1["payload"];
}

export type MainRunLeaseRenewalDecision =
  | {
      readonly status: "renewed";
      readonly renewalId: string;
      readonly renewedAtMs: number;
      readonly priorLeaseExpiresAtMs: number;
      readonly leaseExpiresAtMs: number;
    }
  | {
      readonly status: "rejected";
      readonly renewalId: string;
      readonly decidedAtMs: number;
      readonly priorLeaseExpiresAtMs: number;
      readonly reasonCode:
        | "RUN_LEASE_CHANGED"
        | "RUN_LEASE_EXPIRED"
        | "RUN_LEASE_NOT_DUE"
        | "RUN_NOT_ACTIVE"
        | "RUN_SCOPE_MISMATCH";
    };

type MainActionResponseFrameV1 = MainActionAuthorizationFrameV1 | MainActionConsumptionFrameV1;

type WorkerIdentityFrameV1 = WorkerIdentityActivateFrameV1 | WorkerIdentityRotateFrameV1;
type MainIdentityResponseFrameV1 =
  MainIdentityPendingFrameV1 | MainIdentityRejectedFrameV1 | MainIdentityRenewedFrameV1;

function identityRejectionCode(error: unknown): IdentityRotationRejectionCodeV1 {
  if (error instanceof DeviceIdentityError) {
    if (error.code === "ROTATION_ALREADY_PENDING") {
      return "ROTATION_ALREADY_PENDING";
    }
    if (error.code === "ROTATION_INVALID" || error.code === "CERTIFICATE_REQUEST_INVALID") {
      return "ROTATION_INVALID";
    }
  }
  return "SERVICE_UNAVAILABLE";
}

export interface CreateMainDeviceChannelServerOptions extends MainDeviceChannelCallbacks {
  readonly mainDeviceId: string;
  readonly authority: Pick<
    DeviceIdentityAuthority,
    "confirmCertificateRotation" | "issueCertificateRotation" | "validatePeerIdentity"
  >;
  readonly repository: DeviceChannelRepository;
  readonly tls: MainDeviceChannelTlsOptions;
  readonly host?: string;
  readonly port?: number;
  readonly path?: string;
  readonly heartbeatIntervalMs?: number;
  readonly maximumInFlightFrames?: number;
  readonly maximumBufferedBytes?: number;
  readonly maximumHandshakeRttMs?: number;
  readonly maximumAbsoluteClockSkewMs?: number;
  readonly clock?: MainDeviceChannelClock;
  readonly idSource?: () => string;
}

export interface MainDeviceChannelAddress {
  readonly host: string;
  readonly port: number;
  readonly url: string;
}

export type MainDeviceControl =
  | {
      readonly action: "cancel";
      readonly reason: string;
      readonly runId: string;
      readonly leaseId: string;
      readonly fencingToken: number;
    }
  | {
      readonly action: "disable" | "drain" | "revoke";
      readonly reason: string;
    };

interface ActiveConnection {
  readonly socket: WebSocket;
  readonly certificatePem: string;
  readonly peer: AuthenticatedDevicePeer;
  lastObservedAtMs: number;
  queue: Promise<void>;
  closed: boolean;
}

export class MainDeviceChannelServer {
  private readonly options: Required<
    Pick<
      CreateMainDeviceChannelServerOptions,
      | "heartbeatIntervalMs"
      | "host"
      | "maximumBufferedBytes"
      | "maximumInFlightFrames"
      | "maximumHandshakeRttMs"
      | "maximumAbsoluteClockSkewMs"
      | "path"
      | "port"
    >
  > &
    CreateMainDeviceChannelServerOptions;
  private readonly httpsServer: HttpsServer;
  private readonly webSocketServer: WebSocketServer;
  private readonly connections = new Map<string, ActiveConnection>();
  private sweepTimer: NodeJS.Timeout | undefined;
  private closed = false;

  private constructor(options: CreateMainDeviceChannelServerOptions) {
    this.options = {
      ...options,
      heartbeatIntervalMs: readBoundedPositiveInteger(
        options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
        "heartbeat interval",
        3_600_000,
      ),
      host: options.host ?? "127.0.0.1",
      maximumBufferedBytes: readBoundedPositiveInteger(
        options.maximumBufferedBytes ?? DEFAULT_MAXIMUM_BUFFERED_BYTES,
        "maximum buffered bytes",
        64 * MAX_DEVICE_CHANNEL_FRAME_BYTES,
      ),
      maximumInFlightFrames: readBoundedPositiveInteger(
        options.maximumInFlightFrames ?? DEFAULT_MAXIMUM_IN_FLIGHT_FRAMES,
        "maximum in-flight frame count",
        1_024,
      ),
      maximumHandshakeRttMs: readBoundedPositiveInteger(
        options.maximumHandshakeRttMs ?? DEFAULT_MAXIMUM_HANDSHAKE_RTT_MS,
        "maximum handshake round trip",
        60_000,
      ),
      maximumAbsoluteClockSkewMs: readBoundedPositiveInteger(
        options.maximumAbsoluteClockSkewMs ?? DEFAULT_MAXIMUM_ABSOLUTE_CLOCK_SKEW_MS,
        "maximum absolute clock skew",
        3_600_000,
      ),
      path: validatePath(options.path ?? DEFAULT_CHANNEL_PATH),
      port: readPort(options.port ?? 0),
    };
    validateIdentifier(this.options.mainDeviceId, "Main Device ID");
    validateTlsMaterial(this.options.tls);
    this.httpsServer = createServer({
      ca: this.options.tls.certificateAuthorityPem,
      cert: this.options.tls.certificate,
      key: this.options.tls.privateKey,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      requestCert: true,
      rejectUnauthorized: true,
    });
    this.httpsServer.on("request", (_request, response) => {
      response.statusCode = 404;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end('{"code":"NOT_FOUND"}');
    });
    this.webSocketServer = new WebSocketServer({
      noServer: true,
      clientTracking: false,
      maxPayload: MAX_DEVICE_CHANNEL_FRAME_BYTES,
      perMessageDeflate: false,
      handleProtocols: (protocols) =>
        protocols.has(DEVICE_CHANNEL_SUBPROTOCOL) ? DEVICE_CHANNEL_SUBPROTOCOL : false,
    });
    this.httpsServer.on("upgrade", (request, socket, head) => {
      const tlsSocket = socket as TLSSocket;
      if (
        request.url !== this.options.path ||
        !tlsSocket.authorized ||
        request.headers["sec-websocket-protocol"]
          ?.split(",")
          .map((value) => value.trim())
          .includes(DEVICE_CHANNEL_SUBPROTOCOL) !== true
      ) {
        socket.destroy();
        return;
      }
      this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        this.acceptSocket(webSocket, tlsSocket);
      });
    });
  }

  public static async listen(
    options: CreateMainDeviceChannelServerOptions,
  ): Promise<MainDeviceChannelServer> {
    const channel = new MainDeviceChannelServer(options);
    await new Promise<void>((resolve, reject) => {
      const onError = (): void => {
        cleanup();
        reject(new DeviceChannelServerError("The Device channel listener could not start."));
      };
      const onListening = (): void => {
        cleanup();
        resolve();
      };
      const cleanup = (): void => {
        channel.httpsServer.off("error", onError);
        channel.httpsServer.off("listening", onListening);
      };
      channel.httpsServer.once("error", onError);
      channel.httpsServer.once("listening", onListening);
      channel.httpsServer.listen(channel.options.port, channel.options.host);
    });
    channel.sweepTimer = setInterval(() => {
      void channel.sweepConnections();
    }, channel.options.heartbeatIntervalMs);
    channel.sweepTimer.unref();
    return channel;
  }

  public address(): MainDeviceChannelAddress {
    const address = this.httpsServer.address();
    if (address === null || typeof address === "string") {
      throw new DeviceChannelServerError("The Device channel is not listening.");
    }
    const host = normalizeAddressHost(address, this.options.host);
    return Object.freeze({
      host,
      port: address.port,
      url: `wss://${formatUrlHost(host)}:${String(address.port)}${this.options.path}`,
    });
  }

  public async dispatch(
    deviceId: string,
    assignment: WorkerRunAssignmentV1,
    correlationId = assignment.taskId,
    idempotencyKey = `dispatch:${assignment.runId}`,
  ): Promise<MainDispatchFrameV1> {
    validateIdentifier(deviceId, "Device ID");
    validateIdentifier(correlationId, "correlation ID");
    validateIdentifier(idempotencyKey, "dispatch idempotency key");
    if (assignment.deviceId !== deviceId) {
      throw new DeviceChannelServerError("The assignment targets a different Device.");
    }
    const durable = await this.options.repository.outboundByIdempotencyKey(
      deviceId,
      idempotencyKey,
    );
    if (durable !== undefined) {
      const replay = assertDispatchReplay(
        durable,
        this.options.mainDeviceId,
        correlationId,
        idempotencyKey,
        assignment,
      );
      await this.sendIfConnected(deviceId, replay);
      return replay;
    }
    let frame: MainDispatchFrameV1;
    try {
      frame = (await this.options.repository.enqueueOutbound(deviceId, (sequence) => ({
        ...this.envelope(sequence, correlationId, "main.dispatch", {
          idempotencyKey,
          messageId: idempotencyKey,
        }),
        type: "main.dispatch",
        payload: assignment,
      }))) as MainDispatchFrameV1;
    } catch (error) {
      const concurrent = await this.options.repository.outboundByIdempotencyKey(
        deviceId,
        idempotencyKey,
      );
      if (concurrent === undefined) {
        throw error;
      }
      frame = assertDispatchReplay(
        concurrent,
        this.options.mainDeviceId,
        correlationId,
        idempotencyKey,
        assignment,
      );
    }
    await this.sendIfConnected(deviceId, frame);
    return frame;
  }

  public async control(
    deviceId: string,
    control: MainDeviceControl,
    correlationId?: string,
    idempotencyKey?: string,
  ): Promise<MainControlFrameV1> {
    validateIdentifier(deviceId, "Device ID");
    validateControl(control);
    const resolvedCorrelationId = correlationId ?? this.nextId();
    validateIdentifier(resolvedCorrelationId, "correlation ID");
    if (idempotencyKey !== undefined) {
      validateIdentifier(idempotencyKey, "control idempotency key");
      const durable = await this.options.repository.outboundByIdempotencyKey(
        deviceId,
        idempotencyKey,
      );
      if (durable !== undefined) {
        const replay = assertControlReplay(
          durable,
          this.options.mainDeviceId,
          resolvedCorrelationId,
          idempotencyKey,
          control,
        );
        await this.sendIfConnected(deviceId, replay);
        return replay;
      }
    }
    let frame: MainControlFrameV1;
    try {
      frame = (await this.options.repository.enqueueOutbound(deviceId, (sequence) => ({
        ...this.envelope(
          sequence,
          resolvedCorrelationId,
          "main.control",
          idempotencyKey === undefined
            ? undefined
            : {
                idempotencyKey,
                messageId: idempotencyKey,
              },
        ),
        type: "main.control",
        payload: control,
      }))) as MainControlFrameV1;
    } catch (error) {
      if (idempotencyKey === undefined) {
        throw error;
      }
      const concurrent = await this.options.repository.outboundByIdempotencyKey(
        deviceId,
        idempotencyKey,
      );
      if (concurrent === undefined) {
        throw error;
      }
      frame = assertControlReplay(
        concurrent,
        this.options.mainDeviceId,
        resolvedCorrelationId,
        idempotencyKey,
        control,
      );
    }
    await this.sendIfConnected(deviceId, frame);
    return frame;
  }

  public async steerRun(
    deviceId: string,
    command: WorkerRunSteeringCommandV1,
  ): Promise<MainRunSteerFrameV1> {
    validateIdentifier(deviceId, "Device ID");
    const validatedCommand = validateRunSteeringCommand(deviceId, command);
    const durable = await this.options.repository.outboundByIdempotencyKey(
      deviceId,
      validatedCommand.requestId,
    );
    if (durable !== undefined) {
      const replay = assertRunSteeringReplay(durable, this.options.mainDeviceId, validatedCommand);
      await this.sendIfConnected(deviceId, replay);
      return replay;
    }
    let frame: MainRunSteerFrameV1;
    try {
      frame = (await this.options.repository.enqueueOutbound(deviceId, (sequence) => ({
        ...this.envelope(sequence, validatedCommand.taskId, "main.run.steer", {
          idempotencyKey: validatedCommand.requestId,
          messageId: validatedCommand.requestId,
        }),
        type: "main.run.steer",
        payload: validatedCommand,
      }))) as MainRunSteerFrameV1;
    } catch (error) {
      const concurrent = await this.options.repository.outboundByIdempotencyKey(
        deviceId,
        validatedCommand.requestId,
      );
      if (concurrent === undefined) {
        throw error;
      }
      frame = assertRunSteeringReplay(concurrent, this.options.mainDeviceId, validatedCommand);
    }
    await this.sendIfConnected(deviceId, frame);
    return frame;
  }

  public async closeRevokedDevice(deviceId: string): Promise<void> {
    validateIdentifier(deviceId, "Device ID");
    const connection = this.connections.get(deviceId);
    if (connection === undefined) {
      return;
    }
    try {
      const frame = await this.options.repository.enqueueOutbound(deviceId, (sequence) => ({
        ...this.envelope(sequence, this.nextId(), "main.revoked"),
        type: "main.revoked",
        payload: { reasonCode: "DEVICE_REVOKED" },
      }));
      await this.sendFrame(connection, frame);
    } catch {
      // Revocation is already authoritative; delivery is best-effort before closure.
    } finally {
      this.closeConnection(deviceId, connection, 4003, "Device revoked");
    }
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.sweepTimer !== undefined) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    for (const [deviceId, connection] of this.connections) {
      this.closeConnection(deviceId, connection, 1001, "Server shutdown");
      connection.socket.terminate();
    }
    this.webSocketServer.close();
    this.httpsServer.closeAllConnections();
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.httpsServer.closeAllConnections();
        resolve();
      }, 2_000);
      this.httpsServer.close(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  private acceptSocket(socket: WebSocket, tlsSocket: TLSSocket): void {
    const peerCertificate = tlsSocket.getPeerCertificate(true);
    if (peerCertificate.raw === undefined || peerCertificate.raw.byteLength === 0) {
      socket.close(4003, "Client certificate required");
      return;
    }
    let certificatePem: string;
    try {
      certificatePem = new X509Certificate(peerCertificate.raw).toString();
    } catch {
      socket.close(4003, "Client certificate invalid");
      return;
    }
    const timer = setTimeout(() => {
      socket.close(4008, "Worker hello timed out");
    }, FIRST_FRAME_TIMEOUT_MS);
    timer.unref();
    let accepted = false;
    const firstMessage = (bytes: RawData, binary: boolean): void => {
      if (binary) {
        clearTimeout(timer);
        socket.close(4002, "Binary frames are forbidden");
        return;
      }
      socket.off("message", firstMessage);
      clearTimeout(timer);
      void this.authenticateConnection(socket, certificatePem, bytes).catch(() => {
        socket.close(4003, "Worker authentication failed");
      });
      accepted = true;
    };
    socket.once("message", firstMessage);
    socket.once("close", () => {
      clearTimeout(timer);
      if (!accepted) {
        socket.off("message", firstMessage);
      }
    });
  }

  private async authenticateConnection(
    socket: WebSocket,
    certificatePem: string,
    bytes: RawData,
  ): Promise<void> {
    const mainReceivedAtMs = this.now();
    const claimedDeviceId = readClaimedSender(bytes);
    const peer = await this.options.authority.validatePeerIdentity({
      certificatePem,
      claimedDeviceId,
    });
    const hello = decodeDeviceChannelFrame(
      toFrameBytes(bytes),
      peer.deviceId,
      "worker-to-main",
    ) as WorkerToMainFrameV1;
    if (
      hello.type !== "worker.hello" ||
      hello.payload.deviceId !== peer.deviceId ||
      hello.payload.certificateGeneration !== peer.certificateGeneration
    ) {
      throw new DeviceChannelServerError("The first Worker frame is not a valid hello.");
    }
    if (
      Math.abs(mainReceivedAtMs - hello.payload.workerWallSentAtMs) >
      this.options.maximumAbsoluteClockSkewMs + this.options.maximumHandshakeRttMs
    ) {
      throw new DeviceChannelServerError(
        "The Worker clock is outside the bounded scheduling calibration window.",
      );
    }
    await this.options.repository.observeConnection({
      deviceId: peer.deviceId,
      certificateGeneration: peer.certificateGeneration,
    });
    const prior = this.connections.get(peer.deviceId);
    if (prior !== undefined) {
      this.closeConnection(peer.deviceId, prior, 4000, "Superseded connection");
    }
    const connection: ActiveConnection = {
      socket,
      certificatePem,
      peer,
      lastObservedAtMs: this.now(),
      queue: Promise.resolve(),
      closed: false,
    };
    this.connections.set(peer.deviceId, connection);
    socket.on("message", (message, binary) => {
      connection.queue = connection.queue
        .then(() => this.handleMessage(connection, message, binary))
        .catch(() => {
          this.closeConnection(peer.deviceId, connection, 4002, "Channel frame rejected");
        });
    });
    socket.once("close", () => {
      connection.closed = true;
      if (this.connections.get(peer.deviceId) === connection) {
        this.connections.delete(peer.deviceId);
      }
    });
    const priorResume = await this.options.repository.resume(peer.deviceId);
    if (hello.payload.acknowledgedMainSequence > priorResume.acknowledgedMainSequence) {
      await this.options.repository.acknowledgeOutbound({
        deviceId: peer.deviceId,
        acknowledgedMainSequence: hello.payload.acknowledgedMainSequence,
        acknowledgedMessageIds: priorResume.pendingOutbound
          .filter((frame) => frame.sequence <= hello.payload.acknowledgedMainSequence)
          .map((frame) => frame.messageId),
      });
    }
    const resume = await this.options.repository.resume(peer.deviceId);
    const mainSentAtMs = this.now();
    if (mainSentAtMs < mainReceivedAtMs) {
      throw new DeviceChannelServerError("The Main clock regressed during Worker calibration.");
    }
    const welcome = await this.options.repository.enqueueOutbound(peer.deviceId, (sequence) => ({
      ...this.envelope(sequence, hello.correlationId, "main.welcome"),
      type: "main.welcome",
      payload: {
        deviceId: peer.deviceId,
        acceptedProtocolVersion: PROTOCOL_VERSION,
        acknowledgedWorkerSequence: resume.acknowledgedWorkerSequence,
        nextMainSequence: sequence + 1,
        heartbeatIntervalMs: this.options.heartbeatIntervalMs,
        maximumInFlightFrames: this.options.maximumInFlightFrames,
        workerWallSentAtMs: hello.payload.workerWallSentAtMs,
        mainReceivedAtMs,
        mainSentAtMs,
        maximumHandshakeRttMs: this.options.maximumHandshakeRttMs,
        maximumAbsoluteClockSkewMs: this.options.maximumAbsoluteClockSkewMs,
      },
    }));
    for (const pending of [...resume.pendingOutbound, welcome]) {
      await this.sendFrame(connection, pending);
    }
  }

  private async handleMessage(
    connection: ActiveConnection,
    bytes: RawData,
    binary: boolean,
  ): Promise<void> {
    if (binary || connection.closed) {
      throw new DeviceChannelServerError("Binary or closed-channel frames are forbidden.");
    }
    const currentPeer = await this.options.authority.validatePeerIdentity({
      certificatePem: connection.certificatePem,
      claimedDeviceId: connection.peer.deviceId,
    });
    if (
      currentPeer.serialNumber !== connection.peer.serialNumber ||
      currentPeer.certificateGeneration !== connection.peer.certificateGeneration ||
      currentPeer.publicKeySpkiSha256 !== connection.peer.publicKeySpkiSha256
    ) {
      throw new DeviceChannelServerError("The authenticated Device identity changed.");
    }
    const frame = decodeDeviceChannelFrame(
      toFrameBytes(bytes),
      connection.peer.deviceId,
      "worker-to-main",
    ) as WorkerToMainFrameV1;
    if (frame.type === "worker.hello") {
      throw new DeviceChannelServerError("A Worker hello is only valid as the first frame.");
    }
    connection.lastObservedAtMs = this.now();
    await this.options.repository.commitInbound(frame);
    const claimId = randomUUID();
    const claim = await this.options.repository.claimInboundEffect(frame, claimId);
    if (claim.disposition === "processing") {
      throw new DeviceChannelServerError("The inbound Worker effect is already processing.");
    }
    let acknowledgedWorkerSequence = claim.acknowledgedSequence;
    let artifactResponse: MainArtifactPrepareResponseFrameV1 | undefined;
    let actionResponse: MainActionResponseFrameV1 | undefined;
    let runLeaseResponse: MainRunLeaseFrameV1 | undefined;
    let identityResponse: MainIdentityResponseFrameV1 | undefined;
    if (claim.disposition === "claimed") {
      try {
        if (frame.type === "worker.ack") {
          await this.options.repository.acknowledgeOutbound({
            deviceId: connection.peer.deviceId,
            acknowledgedMainSequence: frame.payload.acknowledgedMainSequence,
            acknowledgedMessageIds: frame.payload.acknowledgedMessageIds,
          });
        } else if (frame.type === "worker.events") {
          await this.options.onEvents?.(connection.peer.deviceId, frame.payload.events);
        } else if (frame.type === "worker.heartbeat") {
          await this.options.onHeartbeat?.(connection.peer.deviceId, frame.payload);
        } else if (frame.type === "worker.artifact.prepare") {
          artifactResponse = await this.prepareArtifactResponse(connection.peer.deviceId, frame);
        } else if (
          frame.type === "worker.identity.rotate" ||
          frame.type === "worker.identity.activate"
        ) {
          identityResponse = await this.prepareIdentityResponse(connection, frame);
        } else if (frame.type === "worker.action.authorize") {
          actionResponse = await this.prepareActionAuthorizationResponse(
            connection.peer.deviceId,
            frame,
          );
        } else if (frame.type === "worker.action.consume") {
          actionResponse = await this.prepareActionConsumptionResponse(
            connection.peer.deviceId,
            frame,
          );
        } else if (frame.type === "worker.run.renew") {
          runLeaseResponse = await this.prepareRunLeaseResponse(connection.peer.deviceId, frame);
        } else if (frame.type === "worker.run.steering") {
          await this.acceptRunSteeringReceipt(connection.peer.deviceId, frame);
        } else if (frame.type === "worker.route.incident") {
          await this.acceptRouteIncident(connection.peer.deviceId, frame);
        } else if (frame.type === "worker.provider.upgraded") {
          await this.acceptProviderUpgrade(connection.peer.deviceId, frame);
        } else if (frame.type === "worker.pong") {
          // The durable commit and last-observed timestamp are the entire pong side effect.
        }
      } catch (error) {
        await this.options.repository.releaseInboundEffect(frame, claimId);
        throw error;
      }
      acknowledgedWorkerSequence = (
        await this.options.repository.completeInboundEffect(frame, claimId)
      ).acknowledgedSequence;
    } else if (frame.type === "worker.artifact.prepare") {
      artifactResponse = await this.findArtifactResponse(connection.peer.deviceId, frame);
    } else if (
      frame.type === "worker.identity.rotate" ||
      frame.type === "worker.identity.activate"
    ) {
      identityResponse = await this.findIdentityResponse(connection.peer.deviceId, frame);
    } else if (frame.type === "worker.action.authorize" || frame.type === "worker.action.consume") {
      actionResponse = await this.findActionResponse(connection.peer.deviceId, frame);
    } else if (frame.type === "worker.run.renew") {
      runLeaseResponse = await this.findRunLeaseResponse(connection.peer.deviceId, frame);
    }
    if (frame.type === "worker.ack") {
      return;
    }
    if (artifactResponse !== undefined) {
      await this.sendFrame(connection, artifactResponse);
    }
    if (identityResponse !== undefined) {
      await this.sendFrame(connection, identityResponse);
    }
    if (actionResponse !== undefined) {
      await this.sendFrame(connection, actionResponse);
    }
    if (runLeaseResponse !== undefined) {
      await this.sendFrame(connection, runLeaseResponse);
    }
    const acknowledgedMessageIds =
      frame.type === "worker.events" ? frame.payload.events.map((event) => event.messageId) : [];
    const acknowledgment = await this.options.repository.enqueueOutbound(
      connection.peer.deviceId,
      (sequence) => ({
        ...this.envelope(sequence, frame.messageId, "main.ack"),
        type: "main.ack",
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          acknowledgedWorkerSequence,
          acknowledgedMessageIds,
        },
      }),
    );
    await this.sendFrame(connection, acknowledgment);
  }

  private async acceptRunSteeringReceipt(
    authenticatedDeviceId: string,
    frame: WorkerRunSteeringReceiptFrameV1,
  ): Promise<void> {
    const request = await this.options.repository.outboundByIdempotencyKey(
      authenticatedDeviceId,
      frame.payload.requestId,
    );
    if (
      request === undefined ||
      request.type !== "main.run.steer" ||
      request.senderDeviceId !== this.options.mainDeviceId ||
      request.messageId !== frame.payload.requestMessageId ||
      request.idempotencyKey !== frame.payload.requestId ||
      frame.payload.deviceId !== authenticatedDeviceId ||
      frame.correlationId !== frame.payload.requestMessageId ||
      frame.payload.requestId !== frame.payload.requestMessageId ||
      !sameRunSteeringReceiptScope(request.payload, frame.payload)
    ) {
      throw new DeviceChannelServerError(
        "The Worker Run steering receipt escaped its authenticated request scope.",
      );
    }
    await this.options.onRunSteeringReceipt?.({
      authenticatedDeviceId,
      receiptMessageId: frame.messageId,
      idempotencyKey: frame.idempotencyKey,
      receipt: structuredClone(frame.payload),
      receivedAtMs: this.now(),
    });
  }

  private async acceptRouteIncident(
    deviceId: string,
    frame: WorkerRouteIncidentFrameV1,
  ): Promise<void> {
    await this.options.onRouteIncident?.({
      authenticatedDeviceId: deviceId,
      requestMessageId: frame.messageId,
      idempotencyKey: frame.idempotencyKey,
      incident: frame.payload,
      receivedAtMs: this.now(),
    });
  }

  /**
   * The authenticated connection is the proof of possession for the current key,
   * so rotation needs no separate credential. The response is durable and keyed
   * by the request, which keeps a reconnecting Worker from asking the authority
   * to start a second rotation it would then refuse as already pending.
   */
  /** True while the Device holds an open authenticated channel. */
  public isConnected(deviceId: string): boolean {
    const connection = this.connections.get(deviceId);
    return connection !== undefined && !connection.closed;
  }

  /**
   * Asks a connected Device to bring one Agent adapter to the version that
   * adapter's own pin requires. The command names only the adapter; the package
   * and version stay on the Worker, so nothing installable crosses the wire.
   */
  public async upgradeProvider(input: {
    readonly deviceId: string;
    readonly adapterId: string;
    readonly requestId: string;
  }): Promise<void> {
    validateIdentifier(input.deviceId, "Device ID");
    validateIdentifier(input.adapterId, "Agent adapter ID");
    validateIdentifier(input.requestId, "provider upgrade request ID");
    const connection = this.connections.get(input.deviceId);
    if (connection === undefined || connection.closed) {
      throw new DeviceChannelServerError("The Device is not connected.");
    }
    const frame = await this.options.repository.enqueueOutbound(input.deviceId, (sequence) => ({
      ...this.envelope(sequence, input.requestId, "main.provider.upgrade"),
      type: "main.provider.upgrade" as const,
      payload: {
        requestId: input.requestId,
        deviceId: input.deviceId,
        adapterId: input.adapterId,
      },
    }));
    await this.sendFrame(connection, frame);
  }

  private async acceptProviderUpgrade(
    deviceId: string,
    frame: WorkerProviderUpgradedFrameV1,
  ): Promise<void> {
    await this.options.onProviderUpgraded?.({
      authenticatedDeviceId: deviceId,
      receiptMessageId: frame.messageId,
      receipt: frame.payload,
      receivedAtMs: this.now(),
    });
  }

  private async prepareIdentityResponse(
    connection: ActiveConnection,
    frame: WorkerIdentityFrameV1,
  ): Promise<MainIdentityResponseFrameV1> {
    const deviceId = connection.peer.deviceId;
    const durable = await this.findIdentityResponse(deviceId, frame);
    if (durable !== undefined) {
      return durable;
    }
    const outcome = await this.decideIdentityRotation(connection, frame);
    const identity = identityResponseIdentity(frame.messageId);
    const response = await this.options.repository.enqueueOutbound(deviceId, (sequence) => {
      const envelope = this.envelope(sequence, frame.messageId, "main.identity.rejected", {
        messageId: identity,
        idempotencyKey: identity,
      });
      if (outcome.status === "pending") {
        return {
          ...envelope,
          type: "main.identity.pending",
          payload: {
            requestMessageId: frame.messageId,
            deviceId,
            certificatePem: outcome.identity.certificatePem,
            certificateAuthorityPem: outcome.identity.certificateAuthorityPem,
            serialNumber: outcome.identity.serialNumber,
            generation: outcome.identity.generation,
            activationChallenge: outcome.identity.activationChallenge,
            activationExpiresAtMs: outcome.identity.activationExpiresAt,
          },
        };
      }
      if (outcome.status === "renewed") {
        return {
          ...envelope,
          type: "main.identity.renewed",
          payload: {
            requestMessageId: frame.messageId,
            deviceId,
            serialNumber: outcome.identity.serialNumber,
            generation: outcome.identity.generation,
            overlapEndsAtMs: outcome.identity.overlapEndsAt,
          },
        };
      }
      return {
        ...envelope,
        type: "main.identity.rejected",
        payload: {
          requestMessageId: frame.messageId,
          deviceId,
          code: outcome.code,
          retryable: outcome.retryable,
        },
      };
    });
    return assertIdentityResponseReplay(response, this.options.mainDeviceId, deviceId, frame);
  }

  private async decideIdentityRotation(
    connection: ActiveConnection,
    frame: WorkerIdentityFrameV1,
  ): Promise<
    | { readonly status: "pending"; readonly identity: IssuedPendingDeviceIdentity }
    | { readonly status: "renewed"; readonly identity: ConfirmedDeviceIdentity }
    | {
        readonly status: "rejected";
        readonly code: IdentityRotationRejectionCodeV1;
        readonly retryable: boolean;
      }
  > {
    try {
      if (frame.type === "worker.identity.rotate") {
        return {
          status: "pending",
          identity: await this.options.authority.issueCertificateRotation({
            deviceId: connection.peer.deviceId,
            currentCertificatePem: connection.certificatePem,
            newCertificateRequestPem: frame.payload.certificateRequestPem,
          }),
        };
      }
      return {
        status: "renewed",
        identity: await this.options.authority.confirmCertificateRotation({
          deviceId: connection.peer.deviceId,
          certificatePem: frame.payload.certificatePem,
          activationChallenge: frame.payload.activationChallenge,
          signature: frame.payload.signature,
        }),
      };
    } catch (error) {
      const code = identityRejectionCode(error);
      return {
        status: "rejected",
        code,
        // Only an unavailable service is worth another attempt; an invalid
        // rotation stays invalid however many times the Worker asks.
        retryable: code === "SERVICE_UNAVAILABLE",
      };
    }
  }

  private async findIdentityResponse(
    deviceId: string,
    frame: WorkerIdentityFrameV1,
  ): Promise<MainIdentityResponseFrameV1 | undefined> {
    const durable = await this.options.repository.outboundByIdempotencyKey(
      deviceId,
      identityResponseIdentity(frame.messageId),
    );
    return durable === undefined
      ? undefined
      : assertIdentityResponseReplay(durable, this.options.mainDeviceId, deviceId, frame);
  }

  private async prepareArtifactResponse(
    deviceId: string,
    frame: WorkerArtifactPrepareFrameV1,
  ): Promise<MainArtifactPrepareResponseFrameV1> {
    const durable = await this.findArtifactResponse(deviceId, frame);
    if (durable !== undefined) {
      return durable;
    }
    const decision =
      this.options.onArtifactPrepare === undefined
        ? ({
            status: "rejected",
            code: "SERVICE_UNAVAILABLE",
            retryable: true,
          } as const)
        : await this.options.onArtifactPrepare({
            authenticatedDeviceId: deviceId,
            requestMessageId: frame.messageId,
            correlationId: frame.correlationId,
            idempotencyKey: frame.idempotencyKey,
            manifest: frame.payload,
          });
    const identity = artifactResponseIdentity(frame.messageId);
    const response = await this.options.repository.enqueueOutbound(deviceId, (sequence) => {
      const envelope = this.envelope(sequence, frame.messageId, "main.artifact.rejected", {
        messageId: identity,
        idempotencyKey: identity,
      });
      if (decision.status === "granted") {
        if (
          decision.grant.artifactId !== frame.payload.artifactId ||
          decision.grant.declaredSizeBytes !== frame.payload.declaredSizeBytes ||
          decision.grant.expectedSha256 !== frame.payload.expectedSha256
        ) {
          throw new DeviceChannelServerError(
            "The Artifact grant escaped its authenticated prepare manifest.",
          );
        }
        return {
          ...envelope,
          type: "main.artifact.grant",
          payload: {
            requestMessageId: frame.messageId,
            deviceId,
            grant: decision.grant,
          },
        };
      }
      if (decision.status !== "rejected") {
        throw new DeviceChannelServerError("The Artifact prepare decision is invalid.");
      }
      return {
        ...envelope,
        type: "main.artifact.rejected",
        payload: {
          requestMessageId: frame.messageId,
          deviceId,
          artifactId: frame.payload.artifactId,
          code: decision.code,
          retryable: decision.retryable,
        },
      };
    });
    return assertArtifactResponseReplay(response, this.options.mainDeviceId, deviceId, frame);
  }

  private async findArtifactResponse(
    deviceId: string,
    frame: WorkerArtifactPrepareFrameV1,
  ): Promise<MainArtifactPrepareResponseFrameV1 | undefined> {
    const durable = await this.options.repository.outboundByIdempotencyKey(
      deviceId,
      artifactResponseIdentity(frame.messageId),
    );
    return durable === undefined
      ? undefined
      : assertArtifactResponseReplay(durable, this.options.mainDeviceId, deviceId, frame);
  }

  private async prepareActionAuthorizationResponse(
    deviceId: string,
    frame: WorkerActionAuthorizeFrameV1,
  ): Promise<MainActionAuthorizationFrameV1> {
    const durable = await this.findActionResponse(deviceId, frame);
    if (durable !== undefined) {
      if (durable.type !== "main.action.authorization") {
        throw new DeviceChannelServerError("The durable action response kind is invalid.");
      }
      return durable;
    }
    const decision =
      this.options.onActionAuthorize === undefined
        ? ({
            decision: "deny",
            authorizationId: `unavailable:${frame.payload.authorizationRequestId}`,
            reasonCode: "SERVICE_UNAVAILABLE",
          } as const)
        : await this.options.onActionAuthorize({
            authenticatedDeviceId: deviceId,
            requestMessageId: frame.messageId,
            idempotencyKey: frame.idempotencyKey,
            request: frame.payload,
          });
    validateIdentifier(decision.authorizationId, "authorization ID");
    validateIdentifier(decision.reasonCode, "authorization reason code");
    if (
      decision.decision !== "allow" &&
      decision.decision !== "deny" &&
      decision.decision !== "require-approval"
    ) {
      throw new DeviceChannelServerError("The action authorization decision is invalid.");
    }
    const identity = actionResponseIdentity(frame.messageId);
    const response = await this.options.repository.enqueueOutbound(deviceId, (sequence) => ({
      ...this.envelope(sequence, frame.messageId, "main.action.authorization", {
        messageId: identity,
        idempotencyKey: identity,
      }),
      type: "main.action.authorization",
      payload: {
        requestMessageId: frame.messageId,
        authorizationRequestId: frame.payload.authorizationRequestId,
        authorizationId: decision.authorizationId,
        actionFingerprint: frame.payload.actionFingerprint,
        decision: decision.decision,
        reasonCode: decision.reasonCode,
      },
    }));
    return assertActionResponseReplay(
      response,
      this.options.mainDeviceId,
      deviceId,
      frame,
    ) as MainActionAuthorizationFrameV1;
  }

  private async prepareActionConsumptionResponse(
    deviceId: string,
    frame: WorkerActionConsumeFrameV1,
  ): Promise<MainActionConsumptionFrameV1> {
    const durable = await this.findActionResponse(deviceId, frame);
    if (durable !== undefined) {
      if (durable.type !== "main.action.consumption") {
        throw new DeviceChannelServerError("The durable action response kind is invalid.");
      }
      return durable;
    }
    const decision =
      this.options.onActionConsume === undefined
        ? ({ decision: "deny", reasonCode: "SERVICE_UNAVAILABLE" } as const)
        : await this.options.onActionConsume({
            authenticatedDeviceId: deviceId,
            requestMessageId: frame.messageId,
            idempotencyKey: frame.idempotencyKey,
            request: frame.payload,
          });
    validateIdentifier(decision.reasonCode, "consumption reason code");
    if (decision.decision !== "consumed" && decision.decision !== "deny") {
      throw new DeviceChannelServerError("The action consumption decision is invalid.");
    }
    const identity = actionResponseIdentity(frame.messageId);
    const response = await this.options.repository.enqueueOutbound(deviceId, (sequence) => ({
      ...this.envelope(sequence, frame.messageId, "main.action.consumption", {
        messageId: identity,
        idempotencyKey: identity,
      }),
      type: "main.action.consumption",
      payload: {
        requestMessageId: frame.messageId,
        authorizationRequestId: frame.payload.authorizationRequestId,
        authorizationId: frame.payload.authorizationId,
        actionFingerprint: frame.payload.actionFingerprint,
        decision: decision.decision,
        reasonCode: decision.reasonCode,
      },
    }));
    return assertActionResponseReplay(
      response,
      this.options.mainDeviceId,
      deviceId,
      frame,
    ) as MainActionConsumptionFrameV1;
  }

  private async findActionResponse(
    deviceId: string,
    frame: WorkerActionAuthorizeFrameV1 | WorkerActionConsumeFrameV1,
  ): Promise<MainActionResponseFrameV1 | undefined> {
    const durable = await this.options.repository.outboundByIdempotencyKey(
      deviceId,
      actionResponseIdentity(frame.messageId),
    );
    return durable === undefined
      ? undefined
      : assertActionResponseReplay(durable, this.options.mainDeviceId, deviceId, frame);
  }

  private async prepareRunLeaseResponse(
    deviceId: string,
    frame: WorkerRunLeaseRenewFrameV1,
  ): Promise<MainRunLeaseFrameV1> {
    const durable = await this.findRunLeaseResponse(deviceId, frame);
    if (durable !== undefined) {
      return durable;
    }
    const decision =
      this.options.onRunLeaseRenew === undefined
        ? ({
            status: "rejected",
            renewalId: frame.payload.renewalId,
            decidedAtMs: this.now(),
            priorLeaseExpiresAtMs: frame.payload.priorLeaseExpiresAtMs,
            reasonCode: "RUN_NOT_ACTIVE",
          } as const)
        : await this.options.onRunLeaseRenew({
            authenticatedDeviceId: deviceId,
            requestMessageId: frame.messageId,
            idempotencyKey: frame.idempotencyKey,
            request: frame.payload,
          });
    if (
      decision.renewalId !== frame.payload.renewalId ||
      decision.priorLeaseExpiresAtMs !== frame.payload.priorLeaseExpiresAtMs
    ) {
      throw new DeviceChannelServerError(
        "The Run lease renewal decision changed the exact command identity.",
      );
    }
    const identity = runLeaseResponseIdentity(frame.messageId);
    return (await this.options.repository.enqueueOutbound(deviceId, (sequence) => ({
      ...this.envelope(sequence, frame.messageId, "main.run.lease", {
        messageId: identity,
        idempotencyKey: identity,
      }),
      type: "main.run.lease",
      payload:
        decision.status === "renewed"
          ? {
              requestMessageId: frame.messageId,
              ...frame.payload,
              status: "renewed",
              renewedAtMs: decision.renewedAtMs,
              leaseExpiresAtMs: decision.leaseExpiresAtMs,
            }
          : {
              requestMessageId: frame.messageId,
              ...frame.payload,
              status: "rejected",
              decidedAtMs: decision.decidedAtMs,
              reasonCode: decision.reasonCode,
            },
    }))) as MainRunLeaseFrameV1;
  }

  private async findRunLeaseResponse(
    deviceId: string,
    frame: WorkerRunLeaseRenewFrameV1,
  ): Promise<MainRunLeaseFrameV1 | undefined> {
    const durable = await this.options.repository.outboundByIdempotencyKey(
      deviceId,
      runLeaseResponseIdentity(frame.messageId),
    );
    return durable === undefined
      ? undefined
      : assertRunLeaseResponseReplay(durable, this.options.mainDeviceId, deviceId, frame);
  }

  private async sweepConnections(): Promise<void> {
    const deadline = this.now() - this.options.heartbeatIntervalMs * 3;
    await Promise.all(
      [...this.connections.entries()].map(async ([deviceId, connection]) => {
        if (connection.lastObservedAtMs < deadline) {
          this.closeConnection(deviceId, connection, 4008, "Heartbeat timed out");
          return;
        }
        try {
          await this.options.authority.validatePeerIdentity({
            certificatePem: connection.certificatePem,
            claimedDeviceId: deviceId,
          });
        } catch {
          this.closeConnection(deviceId, connection, 4003, "Device identity invalid");
        }
      }),
    );
  }

  private async sendIfConnected(deviceId: string, frame: MainToWorkerFrameV1): Promise<void> {
    const connection = this.connections.get(deviceId);
    if (connection !== undefined) {
      await this.sendFrame(connection, frame);
    }
  }

  private async sendFrame(connection: ActiveConnection, frame: MainToWorkerFrameV1): Promise<void> {
    if (connection.closed || connection.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    const encoded = encodeDeviceChannelFrame(frame);
    if (connection.socket.bufferedAmount + encoded.byteLength > this.options.maximumBufferedBytes) {
      this.closeConnection(connection.peer.deviceId, connection, 1013, "Channel backpressure");
      return;
    }
    try {
      connection.socket.send(encoded, { binary: false, compress: false });
    } catch {
      throw new DeviceChannelServerError("A Device channel frame could not be sent.");
    }
  }

  private closeConnection(
    deviceId: string,
    connection: ActiveConnection,
    code: number,
    reason: string,
  ): void {
    if (connection.closed) {
      return;
    }
    connection.closed = true;
    if (this.connections.get(deviceId) === connection) {
      this.connections.delete(deviceId);
    }
    connection.socket.close(code, reason);
    const termination = setTimeout(() => connection.socket.terminate(), 1_000);
    termination.unref();
  }

  private envelope(
    sequence: number,
    correlationId: string,
    type: MainToWorkerFrameV1["type"],
    identity?: {
      readonly messageId: string;
      readonly idempotencyKey: string;
    },
  ): Omit<MainToWorkerFrameV1, "payload" | "type"> & { readonly type: typeof type } {
    const messageId = identity?.messageId ?? this.nextId();
    return {
      protocolVersion: PROTOCOL_VERSION,
      messageId,
      senderDeviceId: this.options.mainDeviceId,
      correlationId,
      createdAt: new Date(this.now()).toISOString(),
      idempotencyKey: identity?.idempotencyKey ?? messageId,
      sequence,
      type,
    };
  }

  private nextId(): string {
    const value = (this.options.idSource ?? randomUUID)();
    validateIdentifier(value, "message ID");
    return value;
  }

  private now(): number {
    const value = (this.options.clock ?? { now: () => Date.now() }).now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new DeviceChannelServerError("The Device channel clock is invalid.");
    }
    return value;
  }
}

function assertDispatchReplay(
  frame: MainToWorkerFrameV1,
  mainDeviceId: string,
  correlationId: string,
  idempotencyKey: string,
  assignment: WorkerRunAssignmentV1,
): MainDispatchFrameV1 {
  if (
    frame.type !== "main.dispatch" ||
    frame.senderDeviceId !== mainDeviceId ||
    frame.correlationId !== correlationId ||
    frame.messageId !== idempotencyKey ||
    frame.idempotencyKey !== idempotencyKey ||
    !isDeepStrictEqual(frame.payload, assignment)
  ) {
    throw new DeviceChannelServerError(
      "The dispatch idempotency key conflicts with another durable command.",
    );
  }
  return frame;
}

function assertControlReplay(
  frame: MainToWorkerFrameV1,
  mainDeviceId: string,
  correlationId: string,
  idempotencyKey: string,
  control: MainDeviceControl,
): MainControlFrameV1 {
  if (
    frame.type !== "main.control" ||
    frame.senderDeviceId !== mainDeviceId ||
    frame.correlationId !== correlationId ||
    frame.messageId !== idempotencyKey ||
    frame.idempotencyKey !== idempotencyKey ||
    !isDeepStrictEqual(frame.payload, control)
  ) {
    throw new DeviceChannelServerError(
      "The control idempotency key conflicts with another durable command.",
    );
  }
  return frame;
}

function assertRunSteeringReplay(
  frame: MainToWorkerFrameV1,
  mainDeviceId: string,
  command: WorkerRunSteeringCommandV1,
): MainRunSteerFrameV1 {
  if (
    frame.type !== "main.run.steer" ||
    frame.senderDeviceId !== mainDeviceId ||
    frame.correlationId !== command.taskId ||
    frame.messageId !== command.requestId ||
    frame.idempotencyKey !== command.requestId ||
    !isDeepStrictEqual(frame.payload, command)
  ) {
    throw new DeviceChannelServerError(
      "The Run steering request ID conflicts with another durable command.",
    );
  }
  return frame;
}

function sameRunSteeringReceiptScope(
  command: WorkerRunSteeringCommandV1,
  receipt: WorkerRunSteeringReceiptV1,
): boolean {
  return (
    command.requestId === receipt.requestId &&
    command.taskId === receipt.taskId &&
    command.workOrderId === receipt.workOrderId &&
    command.deviceId === receipt.deviceId &&
    command.workerId === receipt.workerId &&
    command.routeId === receipt.routeId &&
    command.runId === receipt.runId &&
    command.leaseId === receipt.leaseId &&
    command.fencingToken === receipt.fencingToken &&
    isDeepStrictEqual(command.agentSession, receipt.agentSession)
  );
}

function identityResponseIdentity(requestMessageId: string): string {
  validateIdentifier(requestMessageId, "identity rotation request message ID");
  return `identity-response:${createHash("sha256").update(requestMessageId).digest("hex")}`;
}

function assertIdentityResponseReplay(
  frame: MainToWorkerFrameV1,
  mainDeviceId: string,
  deviceId: string,
  request: WorkerIdentityFrameV1,
): MainIdentityResponseFrameV1 {
  const identity = identityResponseIdentity(request.messageId);
  if (
    (frame.type !== "main.identity.pending" &&
      frame.type !== "main.identity.renewed" &&
      frame.type !== "main.identity.rejected") ||
    frame.senderDeviceId !== mainDeviceId ||
    frame.correlationId !== request.messageId ||
    frame.messageId !== identity ||
    frame.idempotencyKey !== identity ||
    frame.payload.requestMessageId !== request.messageId ||
    frame.payload.deviceId !== deviceId
  ) {
    throw new DeviceChannelServerError(
      "The Device identity response conflicts with another durable command.",
    );
  }
  return frame;
}

function artifactResponseIdentity(requestMessageId: string): string {
  validateIdentifier(requestMessageId, "Artifact request message ID");
  return `artifact-response:${createHash("sha256").update(requestMessageId).digest("hex")}`;
}

function assertArtifactResponseReplay(
  frame: MainToWorkerFrameV1,
  mainDeviceId: string,
  deviceId: string,
  request: WorkerArtifactPrepareFrameV1,
): MainArtifactPrepareResponseFrameV1 {
  const identity = artifactResponseIdentity(request.messageId);
  if (
    (frame.type !== "main.artifact.grant" && frame.type !== "main.artifact.rejected") ||
    frame.senderDeviceId !== mainDeviceId ||
    frame.correlationId !== request.messageId ||
    frame.messageId !== identity ||
    frame.idempotencyKey !== identity ||
    frame.payload.requestMessageId !== request.messageId ||
    frame.payload.deviceId !== deviceId
  ) {
    throw new DeviceChannelServerError(
      "The Artifact response identity conflicts with another durable command.",
    );
  }
  if (
    (frame.type === "main.artifact.grant" &&
      (frame.payload.grant.artifactId !== request.payload.artifactId ||
        frame.payload.grant.declaredSizeBytes !== request.payload.declaredSizeBytes ||
        frame.payload.grant.expectedSha256 !== request.payload.expectedSha256)) ||
    (frame.type === "main.artifact.rejected" &&
      frame.payload.artifactId !== request.payload.artifactId)
  ) {
    throw new DeviceChannelServerError(
      "The durable Artifact response escaped its prepare manifest.",
    );
  }
  return frame;
}

function actionResponseIdentity(requestMessageId: string): string {
  validateIdentifier(requestMessageId, "action request message ID");
  return `action-response:${createHash("sha256").update(requestMessageId).digest("hex")}`;
}

function runLeaseResponseIdentity(requestMessageId: string): string {
  validateIdentifier(requestMessageId, "Run lease request message ID");
  return `run-lease-response:${createHash("sha256").update(requestMessageId).digest("hex")}`;
}

function assertRunLeaseResponseReplay(
  frame: MainToWorkerFrameV1,
  mainDeviceId: string,
  deviceId: string,
  request: WorkerRunLeaseRenewFrameV1,
): MainRunLeaseFrameV1 {
  const identity = runLeaseResponseIdentity(request.messageId);
  if (
    frame.type !== "main.run.lease" ||
    frame.senderDeviceId !== mainDeviceId ||
    frame.messageId !== identity ||
    frame.idempotencyKey !== identity ||
    frame.correlationId !== request.messageId ||
    frame.payload.requestMessageId !== request.messageId ||
    frame.payload.deviceId !== deviceId ||
    !isDeepStrictEqual(
      {
        taskId: frame.payload.taskId,
        workOrderId: frame.payload.workOrderId,
        deviceId: frame.payload.deviceId,
        workerId: frame.payload.workerId,
        routeId: frame.payload.routeId,
        runId: frame.payload.runId,
        leaseId: frame.payload.leaseId,
        fencingToken: frame.payload.fencingToken,
        renewalId: frame.payload.renewalId,
        priorLeaseExpiresAtMs: frame.payload.priorLeaseExpiresAtMs,
      },
      request.payload,
    )
  ) {
    throw new DeviceChannelServerError(
      "The durable Run lease response escaped its exact authenticated request.",
    );
  }
  return frame;
}

function assertActionResponseReplay(
  frame: MainToWorkerFrameV1,
  mainDeviceId: string,
  deviceId: string,
  request: WorkerActionAuthorizeFrameV1 | WorkerActionConsumeFrameV1,
): MainActionResponseFrameV1 {
  const identity = actionResponseIdentity(request.messageId);
  if (
    request.payload.deviceId !== deviceId ||
    frame.senderDeviceId !== mainDeviceId ||
    frame.correlationId !== request.messageId ||
    frame.messageId !== identity ||
    frame.idempotencyKey !== identity ||
    (frame.type !== "main.action.authorization" && frame.type !== "main.action.consumption") ||
    frame.payload.requestMessageId !== request.messageId ||
    frame.payload.authorizationRequestId !== request.payload.authorizationRequestId ||
    frame.payload.actionFingerprint !== request.payload.actionFingerprint ||
    (request.type === "worker.action.authorize" && frame.type !== "main.action.authorization") ||
    (request.type === "worker.action.consume" &&
      (frame.type !== "main.action.consumption" ||
        frame.payload.authorizationId !== request.payload.authorizationId))
  ) {
    throw new DeviceChannelServerError(
      "The durable action response escaped its exact authenticated request.",
    );
  }
  return frame;
}

export class DeviceChannelServerError extends Error {
  public readonly code = "DEVICE_CHANNEL_SERVER_ERROR" as const;

  public constructor(message: string) {
    super(message);
    this.name = "DeviceChannelServerError";
  }
}

function readClaimedSender(bytes: RawData): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(toFrameBytes(bytes).toString("utf8"));
  } catch {
    throw new DeviceChannelServerError("The Worker hello is invalid.");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof (parsed as { senderDeviceId?: unknown }).senderDeviceId !== "string"
  ) {
    throw new DeviceChannelServerError("The Worker hello sender is invalid.");
  }
  const claimed = (parsed as { senderDeviceId: string }).senderDeviceId;
  validateIdentifier(claimed, "claimed Device ID");
  return claimed;
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

function validateControl(control: MainDeviceControl): void {
  if (control.reason.trim().length === 0 || control.reason.length > 262_144) {
    throw new DeviceChannelServerError("The control reason is invalid.");
  }
  if (control.action === "cancel") {
    validateIdentifier(control.runId, "Run ID");
    validateIdentifier(control.leaseId, "lease ID");
    readBoundedPositiveInteger(control.fencingToken, "fencing token", Number.MAX_SAFE_INTEGER);
  }
}

function validateRunSteeringCommand(
  deviceId: string,
  input: WorkerRunSteeringCommandV1,
): WorkerRunSteeringCommandV1 {
  let command: WorkerRunSteeringCommandV1;
  try {
    command = validateWorkerRunSteeringCommand(input);
  } catch {
    throw new DeviceChannelServerError("The Run steering command is invalid.");
  }
  if (command.deviceId !== deviceId) {
    throw new DeviceChannelServerError("The Run steering command targets another Device.");
  }
  return command;
}

function validateTlsMaterial(tls: MainDeviceChannelTlsOptions): void {
  if (
    typeof tls.certificateAuthorityPem !== "string" ||
    !tls.certificateAuthorityPem.includes("BEGIN CERTIFICATE") ||
    tls.certificate === undefined ||
    tls.privateKey === undefined
  ) {
    throw new DeviceChannelServerError("The Device channel TLS configuration is invalid.");
  }
}

function validateIdentifier(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value !== value.trim() ||
    hasControlCharacter(value)
  ) {
    throw new DeviceChannelServerError(`${label} is invalid.`);
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

function validatePath(value: string): string {
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,1023}$/u.test(value)) {
    throw new DeviceChannelServerError("The Device channel path is invalid.");
  }
  return value;
}

function readBoundedPositiveInteger(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new DeviceChannelServerError(`The ${label} is invalid.`);
  }
  return value;
}

function readPort(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new DeviceChannelServerError("The Device channel port is invalid.");
  }
  return value;
}

function normalizeAddressHost(address: AddressInfo, configuredHost: string): string {
  if (configuredHost === "0.0.0.0" || configuredHost === "::") {
    return address.family === "IPv6" ? "::1" : "127.0.0.1";
  }
  return configuredHost;
}

function formatUrlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}
