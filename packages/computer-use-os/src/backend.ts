import { createHash } from "node:crypto";

import {
  ComputerUseOsError,
  NativeDriverError,
  SUPPORTED_GRAPHICAL_LINUX_TARGET,
  type AuthorizedComputerUseAction,
  type ClickInput,
  type ComputerUseActionSummary,
  type ComputerUseActionSummaryEvidence,
  type ComputerUseActionSummaryEntry,
  type ComputerUseClock,
  type ComputerUseEvidence,
  type ComputerUseInputAuthorizationRequest,
  type ComputerUseInputAuthorizer,
  type ComputerUseLogger,
  type ComputerUseOsFamily,
  type ComputerUseReadinessReport,
  type ComputerUseReadinessRequest,
  type ComputerUseSession,
  type ComputerUseSessionStatus,
  type ComputerUseStartHistory,
  type DesktopAuthorityPort,
  type DesktopLeasePort,
  type NativeComputerUseAction,
  type NativeComputerUseDriver,
  type NativeDriverAuthorizedInputContext,
  type NativeDriverControlContext,
  type NativeDriverExecutionContext,
  type NativeDriverProbe,
  type NativeObservation,
  type ReadinessCheck,
  type ReadinessCheckName,
  type StartComputerUseInput,
  type TypeTextInput,
} from "./contracts.ts";
import { createActionFingerprint, describeNativeComputerUseAction } from "./input-authorization.ts";

const NATIVE_READINESS_CHECKS = [
  "interactive-session",
  "unlocked-session",
  "screen-capture",
  "accessibility",
  "input",
  "helper-authentication",
] as const satisfies readonly ReadinessCheckName[];

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_INPUT_TEXT_LENGTH = 1_000_000;
const MAX_TIMEOUT_MS = 86_400_000;
const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

export interface ComputerUseOsBackendOptions {
  readonly osFamily: ComputerUseOsFamily;
  readonly driver: NativeComputerUseDriver;
  readonly authority: DesktopAuthorityPort;
  readonly leases: DesktopLeasePort;
  readonly startHistory: ComputerUseStartHistory;
  readonly authorizer: ComputerUseInputAuthorizer;
  readonly clock: ComputerUseClock;
  readonly logger: ComputerUseLogger;
  readonly operationTimeoutMs?: number;
}

export class ComputerUseOsBackend {
  private readonly osFamily: ComputerUseOsFamily;
  private readonly driver: NativeComputerUseDriver;
  private readonly authority: DesktopAuthorityPort;
  private readonly leases: DesktopLeasePort;
  private readonly startHistory: ComputerUseStartHistory;
  private readonly authorizer: ComputerUseInputAuthorizer;
  private readonly clock: ComputerUseClock;
  private readonly logger: ComputerUseLogger;
  private readonly operationTimeoutMs: number;
  private readonly liveSessions = new Map<
    string,
    { readonly startFingerprint: `sha256:${string}`; readonly session: ManagedComputerUseSession }
  >();
  private readonly startsInFlight = new Map<
    string,
    {
      readonly startFingerprint: `sha256:${string}`;
      readonly promise: Promise<ManagedComputerUseSession>;
    }
  >();

  public constructor(options: ComputerUseOsBackendOptions) {
    if (options.driver.osFamily !== options.osFamily) {
      throw new ComputerUseOsError(
        "DRIVER_OS_MISMATCH",
        "The native Computer Use driver does not match the backend OS family.",
      );
    }
    this.osFamily = options.osFamily;
    this.driver = options.driver;
    this.authority = options.authority;
    this.leases = options.leases;
    this.startHistory = options.startHistory;
    this.authorizer = options.authorizer;
    this.clock = options.clock;
    this.logger = options.logger;
    this.operationTimeoutMs = options.operationTimeoutMs ?? 10_000;
    requirePositiveInteger(this.operationTimeoutMs, "operation timeout", MAX_TIMEOUT_MS);
  }

  public async readiness(
    request: ComputerUseReadinessRequest,
  ): Promise<ComputerUseReadinessReport> {
    validateReadinessRequest(request);
    const [probeResult, authorityResult] = await Promise.allSettled([
      withBoundaryTimeout(() => this.driver.probe(), this.operationTimeoutMs),
      withBoundaryTimeout(() => this.authority.verify(request), this.operationTimeoutMs),
    ]);
    if (probeResult.status === "rejected") {
      const checks = Object.freeze([
        ...unavailableNativeChecks(),
        Object.freeze({
          name: "service-epoch" as const,
          status: "fail" as const,
          evidence: "The native helper identity and epoch could not be verified.",
          remediation: "Restart and re-authenticate the logged-in user-session helper.",
        }),
      ]);
      const report: ComputerUseReadinessReport = Object.freeze({
        status: "unavailable",
        osFamily: this.osFamily,
        backendId: `${this.osFamily}-native-driver-unavailable`,
        displayFingerprint: null,
        checks,
      });
      this.writeReadinessLog(request.deviceId, report);
      return report;
    }
    const probe = probeResult.value;
    const authority =
      authorityResult.status === "fulfilled"
        ? authorityResult.value
        : {
            status: "unavailable" as const,
            reason: "The external monotonic desktop authority could not be verified.",
            verifiedAtMs: readClock(this.clock),
          };
    validateProbe(this.osFamily, probe);

    const epochIsCurrent =
      authority.status === "current" &&
      authority.helperInstanceId === request.helperInstanceId &&
      authority.serviceEpoch === request.serviceEpoch &&
      authority.persistenceGeneration === request.persistenceGeneration &&
      probe.helperInstanceId === request.helperInstanceId &&
      probe.serviceEpoch === request.serviceEpoch;
    const serviceEpochCheck: ReadinessCheck = epochIsCurrent
      ? {
          name: "service-epoch",
          status: "pass",
          evidence: `Exclusive helper authority verified at epoch ${request.serviceEpoch}.`,
        }
      : {
          name: "service-epoch",
          status: "fail",
          evidence:
            authority.status === "current"
              ? "Helper identity, epoch, or persistence generation does not match current authority."
              : authority.reason,
          remediation:
            "Stop cloned or stale Device services and complete explicit desktop-authority recovery.",
        };
    const checks = Object.freeze([...probe.checks, Object.freeze(serviceEpochCheck)]);
    const status = checks.every((check) => check.status === "pass") ? "ready" : "unavailable";
    const report: ComputerUseReadinessReport = Object.freeze({
      status,
      osFamily: this.osFamily,
      backendId: probe.backendId,
      displayFingerprint: probe.displayFingerprint,
      checks,
    });
    this.writeReadinessLog(request.deviceId, report);
    return report;
  }

  public async start(input: StartComputerUseInput): Promise<ComputerUseSession> {
    validateStartInput(input);
    const now = readClock(this.clock);
    if (input.lease.expiresAtMs <= now) {
      throw new ComputerUseOsError("LEASE_STALE", "The desktop-session lease is already expired.");
    }
    const startFingerprint = hashCanonical({
      schemaVersion: 1,
      commandId: input.commandId,
      taskId: input.taskId,
      deviceId: input.deviceId,
      runId: input.runId,
      helperInstanceId: input.helperInstanceId,
      serviceEpoch: input.serviceEpoch,
      persistenceGeneration: input.persistenceGeneration,
      lease: input.lease,
      timeoutMs: input.timeoutMs,
    });
    const previous = this.liveSessions.get(input.commandId);
    if (previous !== undefined) {
      if (previous.startFingerprint !== startFingerprint) {
        throw new ComputerUseOsError(
          "START_COMMAND_CONFLICT",
          "The Computer Use start command was already used with different input.",
        );
      }
      return previous.session;
    }

    const existingStart = this.startsInFlight.get(input.commandId);
    if (existingStart !== undefined) {
      if (existingStart.startFingerprint !== startFingerprint) {
        throw new ComputerUseOsError(
          "START_COMMAND_CONFLICT",
          "The Computer Use start command is already running with different input.",
        );
      }
      return existingStart.promise;
    }

    const promise = this.startNew(input, startFingerprint, now);
    this.startsInFlight.set(input.commandId, { startFingerprint, promise });
    try {
      return await promise;
    } finally {
      const current = this.startsInFlight.get(input.commandId);
      if (current?.promise === promise) {
        this.startsInFlight.delete(input.commandId);
      }
    }
  }

  private async startNew(
    input: StartComputerUseInput,
    startFingerprint: `sha256:${string}`,
    now: number,
  ): Promise<ManagedComputerUseSession> {
    const readiness = await this.readiness(input);
    if (readiness.status !== "ready" || readiness.displayFingerprint === null) {
      throw new ComputerUseOsError(
        "NOT_READY",
        "Computer Use readiness checks did not all pass.",
        readiness,
      );
    }
    await requireCurrentLease(this.leases, input, this.operationTimeoutMs);

    const executionHandleId = `cu_${sha256(input.commandId).slice(0, 24)}`;
    const claim = await this.startHistory.claim({
      commandId: input.commandId,
      startFingerprint,
      executionHandleId,
      recordedAtMs: now,
    });
    if (claim.disposition === "conflict") {
      throw new ComputerUseOsError(
        "START_COMMAND_CONFLICT",
        "The Computer Use start command was already used with different input.",
      );
    }
    if (claim.disposition === "replay") {
      throw new ComputerUseOsError(
        "START_HISTORY_UNRECOVERABLE",
        "The start command was previously executed, but its native controller is not recoverable after restart.",
      );
    }

    const session = new ManagedComputerUseSession({
      executionHandleId,
      input,
      startedAtMs: now,
      initialDisplayFingerprint: readiness.displayFingerprint,
      driver: this.driver,
      authority: this.authority,
      leases: this.leases,
      authorizer: this.authorizer,
      clock: this.clock,
      logger: this.logger,
      operationTimeoutMs: this.operationTimeoutMs,
    });
    this.liveSessions.set(input.commandId, { startFingerprint, session });
    this.logger.write({
      name: "computer_use.session_started",
      taskId: input.taskId,
      deviceId: input.deviceId,
      runId: input.runId,
      executionHandleId,
      serviceEpoch: input.serviceEpoch,
      fencingToken: input.lease.fencingToken,
    });
    return session;
  }

  private writeReadinessLog(deviceId: string, report: ComputerUseReadinessReport): void {
    this.logger.write({
      name: "computer_use.readiness",
      deviceId,
      osFamily: this.osFamily,
      status: report.status,
      failedChecks: Object.freeze(
        report.checks.filter((check) => check.status !== "pass").map((check) => check.name),
      ),
    });
  }
}

interface ManagedComputerUseSessionOptions {
  readonly executionHandleId: string;
  readonly input: StartComputerUseInput;
  readonly startedAtMs: number;
  readonly initialDisplayFingerprint: string;
  readonly driver: NativeComputerUseDriver;
  readonly authority: DesktopAuthorityPort;
  readonly leases: DesktopLeasePort;
  readonly authorizer: ComputerUseInputAuthorizer;
  readonly clock: ComputerUseClock;
  readonly logger: ComputerUseLogger;
  readonly operationTimeoutMs: number;
}

class ManagedComputerUseSession implements ComputerUseSession {
  public readonly executionHandleId: string;
  private readonly input: StartComputerUseInput;
  private readonly deadlineAtMs: number;
  private readonly initialDisplayFingerprint: string;
  private readonly driver: NativeComputerUseDriver;
  private readonly authority: DesktopAuthorityPort;
  private readonly leases: DesktopLeasePort;
  private readonly authorizer: ComputerUseInputAuthorizer;
  private readonly clock: ComputerUseClock;
  private readonly logger: ComputerUseLogger;
  private readonly operationTimeoutMs: number;
  private readonly abortController = new AbortController();
  private readonly summaryEntries: ComputerUseActionSummaryEntry[] = [];
  private currentStatus: ComputerUseSessionStatus = "active";
  private evidenceSequence = 0;
  private inputAttemptSequence = 0;
  private pendingInputAttempt:
    | {
        readonly fingerprint: `sha256:${string}`;
        readonly request: ComputerUseInputAuthorizationRequest;
      }
    | undefined;
  private inputTail: Promise<void> = Promise.resolve();

  public constructor(options: ManagedComputerUseSessionOptions) {
    this.executionHandleId = options.executionHandleId;
    this.input = options.input;
    const requestedDeadline = options.startedAtMs + options.input.timeoutMs;
    if (!Number.isSafeInteger(requestedDeadline)) {
      throw new ComputerUseOsError("INVALID_INPUT", "The Computer Use deadline is invalid.");
    }
    // The Run lease is renewable. The fixed session timeout remains a separate
    // upper bound, while every operation revalidates the live DesktopLeasePort.
    this.deadlineAtMs = requestedDeadline;
    this.initialDisplayFingerprint = options.initialDisplayFingerprint;
    this.driver = options.driver;
    this.authority = options.authority;
    this.leases = options.leases;
    this.authorizer = options.authorizer;
    this.clock = options.clock;
    this.logger = options.logger;
    this.operationTimeoutMs = options.operationTimeoutMs;
  }

  public status(): ComputerUseSessionStatus {
    return this.currentStatus;
  }

  public async observe(): Promise<NativeObservation> {
    await this.requireCurrentBoundary();
    const observation = await this.invokeDriver(() => this.driver.observe(this.driverContext()));
    await this.requireDisplay(observation.displayFingerprint);
    return observation;
  }

  public async capture(): Promise<ComputerUseEvidence> {
    await this.requireCurrentBoundary();
    const capture = await this.invokeDriver(() => this.driver.capture(this.driverContext()));
    await this.requireDisplay(capture.displayFingerprint);
    if (
      capture.mediaType !== "image/png" ||
      !Number.isSafeInteger(capture.width) ||
      capture.width <= 0 ||
      !Number.isSafeInteger(capture.height) ||
      capture.height <= 0 ||
      capture.bytes.length < PNG_SIGNATURE.length ||
      !PNG_SIGNATURE.every((value, index) => capture.bytes[index] === value)
    ) {
      await this.failClosed("display-changed");
      throw new ComputerUseOsError(
        "INVALID_CAPTURE",
        "The native driver returned invalid PNG evidence.",
      );
    }
    this.evidenceSequence += 1;
    const digest = hashBytes(capture.bytes);
    const capturedAtMs = readClock(this.clock);
    const evidence: ComputerUseEvidence = Object.freeze({
      evidenceId: `computer-use-evidence:${this.executionHandleId}:${this.evidenceSequence}`,
      runId: this.input.runId,
      mediaType: "image/png",
      width: capture.width,
      height: capture.height,
      bytes: capture.bytes.slice(),
      sha256: digest,
      capturedAtMs,
      displayFingerprint: capture.displayFingerprint,
    });
    this.logger.write({
      name: "computer_use.capture",
      taskId: this.input.taskId,
      deviceId: this.input.deviceId,
      runId: this.input.runId,
      evidenceId: evidence.evidenceId,
      sha256: evidence.sha256,
    });
    return evidence;
  }

  public async click(input: ClickInput): Promise<void> {
    requireIdentifier(input.controlId, "control ID");
    await this.queueInput({ kind: "click", controlId: input.controlId });
  }

  public async typeText(input: TypeTextInput): Promise<void> {
    requireIdentifier(input.controlId, "control ID");
    if (
      typeof input.text !== "string" ||
      input.text.length === 0 ||
      input.text.length > MAX_INPUT_TEXT_LENGTH
    ) {
      throw new ComputerUseOsError(
        "INVALID_INPUT",
        "Computer Use text must be a non-empty bounded string.",
      );
    }
    await this.queueInput({ kind: "type-text", controlId: input.controlId, text: input.text });
  }

  public actionSummary(): ComputerUseActionSummary {
    return Object.freeze({
      executionHandleId: this.executionHandleId,
      taskId: this.input.taskId,
      deviceId: this.input.deviceId,
      runId: this.input.runId,
      entries: Object.freeze(this.summaryEntries.map((entry) => Object.freeze({ ...entry }))),
    });
  }

  public captureActionSummary(): ComputerUseActionSummaryEvidence {
    const summary = this.actionSummary();
    const bytes = Buffer.from(canonicalJson(summary), "utf8");
    const digest = hashBytes(bytes);
    const evidence: ComputerUseActionSummaryEvidence = Object.freeze({
      evidenceId: `computer-use-actions:${this.executionHandleId}`,
      runId: this.input.runId,
      mediaType: "application/json",
      filename: `computer-use-actions-${this.executionHandleId}.json`,
      bytes,
      sha256: digest,
      createdAtMs: readClock(this.clock),
    });
    this.logger.write({
      name: "computer_use.action_summary",
      taskId: this.input.taskId,
      deviceId: this.input.deviceId,
      runId: this.input.runId,
      evidenceId: evidence.evidenceId,
      sha256: evidence.sha256,
      actionCount: summary.entries.length,
    });
    return evidence;
  }

  public async cancel(): Promise<void> {
    if (this.currentStatus !== "active") {
      return;
    }
    this.currentStatus = "cancelled";
    this.abortController.abort(new Error("Computer Use session cancelled."));
    await this.invokeControl(() => this.driver.cancel(this.controlContext()));
    this.logger.write({
      name: "computer_use.stopped",
      taskId: this.input.taskId,
      deviceId: this.input.deviceId,
      runId: this.input.runId,
      reason: "cancelled",
    });
  }

  public async emergencyStop(): Promise<void> {
    if (this.currentStatus === "emergency-stopped") {
      return;
    }
    if (this.currentStatus !== "active") {
      return;
    }
    this.currentStatus = "emergency-stopped";
    this.abortController.abort(new Error("Computer Use emergency stop."));
    await this.invokeControl(() => this.driver.emergencyStop(this.controlContext()));
    this.logger.write({
      name: "computer_use.stopped",
      taskId: this.input.taskId,
      deviceId: this.input.deviceId,
      runId: this.input.runId,
      reason: "emergency-stop",
    });
  }

  public async release(): Promise<void> {
    if (this.currentStatus !== "active") {
      return;
    }
    this.currentStatus = "released";
    this.abortController.abort(new Error("Computer Use session released."));
    await this.invokeControl(() => this.driver.cancel(this.controlContext()));
    this.logger.write({
      name: "computer_use.stopped",
      taskId: this.input.taskId,
      deviceId: this.input.deviceId,
      runId: this.input.runId,
      reason: "released",
    });
  }

  private async executeInput(action: NativeComputerUseAction): Promise<void> {
    await this.requireCurrentBoundary();
    const authorizedAction = normalizeAction(action);
    const fingerprint = createActionFingerprint({
      action: authorizedAction,
    });
    const request = this.authorizationRequest(authorizedAction, fingerprint);
    const proof = await this.authorizer.authorize(request);
    if (proof.fingerprint !== fingerprint || !isIdentifier(proof.authorizationId)) {
      throw new ComputerUseOsError(
        "AUTHORIZATION_INVALID",
        "The Computer Use authorization proof did not match the exact action fingerprint.",
      );
    }
    if (proof.decision !== "allow") {
      if (proof.decision === "deny") {
        this.clearPendingInputAttempt(request);
        throw new ComputerUseOsError("AUTHORIZATION_DENIED", "Computer Use input was denied.");
      }
      throw new ComputerUseOsError(
        "AUTHORIZATION_REQUIRED",
        "Computer Use input requires an exact Task-scoped grant.",
      );
    }

    // D-035/D-037: revalidate both roots after authorization and immediately
    // before atomically consuming the permit.
    await this.requireCurrentBoundary();
    const consumption = await this.authorizer.consume(request, proof);
    if (
      consumption.decision !== "consumed" ||
      consumption.authorizationRequestId !== request.authorizationRequestId ||
      consumption.authorizationId !== proof.authorizationId ||
      consumption.fingerprint !== fingerprint
    ) {
      throw new ComputerUseOsError(
        "AUTHORIZATION_INVALID",
        "The Computer Use authorization consumption did not match the exact mutation.",
      );
    }

    // The final authority read happens after durable permit consumption and
    // immediately before the native mutation. A permit may be safely wasted by
    // revocation; it can never authorize stale input.
    await this.requireCurrentBoundary();
    const receipt = await this.invokeDriver(() =>
      this.driver.act(this.authorizedDriverContext(proof, authorizedAction), action),
    );
    this.requireActive();
    await this.requireDisplay(receipt.displayFingerprint);
    const executedAtMs = readClock(this.clock);
    const entry: ComputerUseActionSummaryEntry = Object.freeze({
      sequence: receipt.sequence,
      kind: authorizedAction.kind,
      controlId: authorizedAction.controlId,
      fingerprint,
      authorizationId: proof.authorizationId,
      executedAtMs,
    });
    this.summaryEntries.push(entry);
    this.clearPendingInputAttempt(request);
    this.logger.write({
      name: "computer_use.input",
      taskId: this.input.taskId,
      deviceId: this.input.deviceId,
      runId: this.input.runId,
      kind: authorizedAction.kind,
      fingerprint,
      authorizationId: proof.authorizationId,
      outcome: "executed",
    });
  }

  private authorizationRequest(
    action: AuthorizedComputerUseAction,
    fingerprint: `sha256:${string}`,
  ): ComputerUseInputAuthorizationRequest {
    if (this.pendingInputAttempt?.fingerprint === fingerprint) {
      return this.pendingInputAttempt.request;
    }
    this.inputAttemptSequence += 1;
    if (!Number.isSafeInteger(this.inputAttemptSequence)) {
      throw new ComputerUseOsError(
        "AUTHORIZATION_INVALID",
        "The Computer Use input attempt sequence is exhausted.",
      );
    }
    const request: ComputerUseInputAuthorizationRequest = Object.freeze({
      authorizationRequestId: `${this.executionHandleId}:input:${String(
        this.inputAttemptSequence,
      )}`,
      actionCategory: "computer-use-input",
      taskId: this.input.taskId,
      deviceId: this.input.deviceId,
      runId: this.input.runId,
      requestedAtMs: readClock(this.clock),
      action,
      fingerprint,
    });
    this.pendingInputAttempt = Object.freeze({ fingerprint, request });
    return request;
  }

  private clearPendingInputAttempt(request: ComputerUseInputAuthorizationRequest): void {
    if (
      this.pendingInputAttempt?.request.authorizationRequestId === request.authorizationRequestId
    ) {
      this.pendingInputAttempt = undefined;
    }
  }

  private queueInput(action: NativeComputerUseAction): Promise<void> {
    const operation = this.inputTail.then(() => this.executeInput(action));
    this.inputTail = operation.catch(() => undefined);
    return operation;
  }

  private async requireCurrentBoundary(): Promise<void> {
    this.requireActive();
    const now = readClock(this.clock);
    if (now >= this.deadlineAtMs) {
      await this.failClosed("timeout");
      throw new ComputerUseOsError("SESSION_TIMEOUT", "The Computer Use session timed out.");
    }

    let authority;
    try {
      authority = await withBoundaryTimeout(
        () => this.authority.verify(this.input),
        this.operationTimeoutMs,
      );
    } catch {
      await this.failClosed("stale-authority");
      throw new ComputerUseOsError(
        "EPOCH_STALE",
        "The exclusive Device-service epoch could not be verified.",
      );
    }
    if (
      authority.status !== "current" ||
      authority.helperInstanceId !== this.input.helperInstanceId ||
      authority.serviceEpoch !== this.input.serviceEpoch ||
      authority.persistenceGeneration !== this.input.persistenceGeneration
    ) {
      await this.failClosed("stale-authority");
      throw new ComputerUseOsError(
        "EPOCH_STALE",
        "The exclusive Device-service epoch is stale or cannot be verified.",
      );
    }
    let lease;
    try {
      lease = await withBoundaryTimeout(
        () =>
          this.leases.verify({
            taskId: this.input.taskId,
            deviceId: this.input.deviceId,
            runId: this.input.runId,
            lease: this.input.lease,
          }),
        this.operationTimeoutMs,
      );
    } catch {
      await this.failClosed("stale-lease");
      throw new ComputerUseOsError(
        "LEASE_STALE",
        "The exact desktop-session lease and fencing identity could not be verified.",
      );
    }
    if (
      lease.status !== "current" ||
      lease.leaseId !== this.input.lease.leaseId ||
      lease.fencingToken !== this.input.lease.fencingToken
    ) {
      await this.failClosed("stale-lease");
      throw new ComputerUseOsError(
        "LEASE_STALE",
        "The exact desktop-session lease and fencing identity is no longer current.",
      );
    }
    const probe = await this.invokeDriver(() => this.driver.probe());
    validateProbe(this.driver.osFamily, probe);
    const failed = probe.checks.find((check) => check.status !== "pass");
    if (
      failed !== undefined ||
      probe.helperInstanceId !== this.input.helperInstanceId ||
      probe.serviceEpoch !== this.input.serviceEpoch
    ) {
      const reason =
        failed?.name === "unlocked-session"
          ? "session-locked"
          : failed?.name === "accessibility" ||
              failed?.name === "input" ||
              failed?.name === "screen-capture"
            ? "permission-denied"
            : failed?.name === "interactive-session" || failed?.name === "helper-authentication"
              ? "helper-crashed"
              : "stale-authority";
      await this.failClosed(reason);
      const message = failed?.remediation ?? "The authenticated desktop helper is no longer ready.";
      if (reason === "helper-crashed") {
        throw new ComputerUseOsError("HELPER_CRASHED", message);
      }
      if (reason === "session-locked") {
        throw new ComputerUseOsError("SESSION_LOCKED", message);
      }
      if (reason === "permission-denied") {
        throw new ComputerUseOsError("PERMISSION_DENIED", message);
      }
      throw new ComputerUseOsError("EPOCH_STALE", message);
    }
    await this.requireDisplay(probe.displayFingerprint);
  }

  private requireActive(): void {
    switch (this.currentStatus) {
      case "active":
        return;
      case "cancelled":
        throw new ComputerUseOsError("SESSION_CANCELLED", "Computer Use was cancelled.");
      case "emergency-stopped":
        throw new ComputerUseOsError(
          "SESSION_EMERGENCY_STOPPED",
          "Computer Use was emergency-stopped.",
        );
      case "released":
        throw new ComputerUseOsError("SESSION_RELEASED", "Computer Use was released.");
      case "timed-out":
        throw new ComputerUseOsError("SESSION_TIMEOUT", "Computer Use timed out.");
      case "failed":
        throw new ComputerUseOsError("DRIVER_FAILURE", "Computer Use failed closed.");
    }
  }

  private async requireDisplay(actual: string | null): Promise<void> {
    if (actual !== this.initialDisplayFingerprint) {
      await this.failClosed("display-changed");
      throw new ComputerUseOsError(
        "DISPLAY_CHANGED",
        "The display topology changed; a new observation and authorization are required.",
      );
    }
  }

  private async invokeDriver<T>(operation: () => Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            this.abortController.abort(new Error("Native Computer Use operation timed out."));
            reject(new NativeDriverError("TIMEOUT", "Native Computer Use operation timed out."));
          }, this.operationTimeoutMs);
        }),
      ]);
    } catch (error: unknown) {
      if (error instanceof ComputerUseOsError) {
        throw error;
      }
      if (error instanceof NativeDriverError) {
        await this.handleNativeDriverError(error);
      }
      await this.failClosed("helper-crashed");
      throw new ComputerUseOsError(
        "DRIVER_FAILURE",
        "The native Computer Use driver failed without exposing sensitive details.",
      );
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  private async handleNativeDriverError(error: NativeDriverError): Promise<never> {
    switch (error.code) {
      case "CANCELLED":
        if (this.currentStatus === "cancelled") {
          throw new ComputerUseOsError("SESSION_CANCELLED", "Computer Use was cancelled.");
        }
        await this.failClosed("helper-crashed");
        throw new ComputerUseOsError(
          "DRIVER_FAILURE",
          "The native driver reported an unexpected cancellation.",
        );
      case "DISPLAY_CHANGED":
        await this.failClosed("display-changed");
        throw new ComputerUseOsError("DISPLAY_CHANGED", "The display topology changed.");
      case "HELPER_CRASHED":
      case "UNAVAILABLE":
        await this.failClosed("helper-crashed");
        throw new ComputerUseOsError(
          "HELPER_CRASHED",
          "The authenticated desktop helper stopped responding.",
        );
      case "PERMISSION_DENIED":
        await this.failClosed("permission-denied");
        throw new ComputerUseOsError(
          "PERMISSION_DENIED",
          "Required desktop permission is not available.",
        );
      case "SESSION_LOCKED":
        await this.failClosed("session-locked");
        throw new ComputerUseOsError("SESSION_LOCKED", "The interactive session is locked.");
      case "TIMEOUT":
        await this.failClosed("timeout");
        throw new ComputerUseOsError("SESSION_TIMEOUT", "Computer Use timed out.");
      case "EMERGENCY_STOPPED":
        if (this.currentStatus === "emergency-stopped") {
          throw new ComputerUseOsError(
            "SESSION_EMERGENCY_STOPPED",
            "Computer Use was emergency-stopped.",
          );
        }
        await this.failClosed("helper-crashed");
        throw new ComputerUseOsError(
          "DRIVER_FAILURE",
          "The native driver reported an unexpected emergency stop.",
        );
    }
  }

  private async failClosed(
    reason:
      | "display-changed"
      | "helper-crashed"
      | "permission-denied"
      | "session-locked"
      | "stale-authority"
      | "stale-lease"
      | "timeout",
  ): Promise<void> {
    if (this.currentStatus === "active") {
      this.currentStatus = reason === "timeout" ? "timed-out" : "failed";
      this.abortController.abort(new Error(`Computer Use failed closed: ${reason}.`));
      await this.invokeControl(() => this.driver.emergencyStop(this.controlContext()));
      this.logger.write({
        name: "computer_use.stopped",
        taskId: this.input.taskId,
        deviceId: this.input.deviceId,
        runId: this.input.runId,
        reason,
      });
    }
  }

  private driverContext(): NativeDriverExecutionContext {
    return {
      executionHandleId: this.executionHandleId,
      taskId: this.input.taskId,
      deviceId: this.input.deviceId,
      runId: this.input.runId,
      helperInstanceId: this.input.helperInstanceId,
      serviceEpoch: this.input.serviceEpoch,
      persistenceGeneration: this.input.persistenceGeneration,
      leaseId: this.input.lease.leaseId,
      fencingToken: this.input.lease.fencingToken,
      expectedDisplayFingerprint: this.initialDisplayFingerprint,
      signal: this.abortController.signal,
    };
  }

  private authorizedDriverContext(
    proof: Extract<
      Awaited<ReturnType<ComputerUseInputAuthorizer["authorize"]>>,
      { readonly decision: "allow" }
    >,
    action: AuthorizedComputerUseAction,
  ): NativeDriverAuthorizedInputContext {
    return {
      ...this.driverContext(),
      authorization: Object.freeze({
        authorizationId: proof.authorizationId,
        fingerprint: proof.fingerprint,
        action,
      }),
    };
  }

  private controlContext(): NativeDriverControlContext {
    return {
      executionHandleId: this.executionHandleId,
      taskId: this.input.taskId,
      deviceId: this.input.deviceId,
      runId: this.input.runId,
    };
  }

  private async invokeControl(operation: () => Promise<void>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.resolve()
          .then(operation)
          .catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.operationTimeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}

function normalizeAction(action: NativeComputerUseAction): AuthorizedComputerUseAction {
  return describeNativeComputerUseAction(action);
}

async function requireCurrentLease(
  leases: DesktopLeasePort,
  input: StartComputerUseInput,
  timeoutMs: number,
): Promise<void> {
  let result;
  try {
    result = await withBoundaryTimeout(
      () =>
        leases.verify({
          taskId: input.taskId,
          deviceId: input.deviceId,
          runId: input.runId,
          lease: input.lease,
        }),
      timeoutMs,
    );
  } catch {
    throw new ComputerUseOsError(
      "LEASE_STALE",
      "The exact desktop-session lease and fencing identity could not be verified.",
    );
  }
  if (
    result.status !== "current" ||
    result.leaseId !== input.lease.leaseId ||
    result.fencingToken !== input.lease.fencingToken
  ) {
    throw new ComputerUseOsError(
      "LEASE_STALE",
      "The exact desktop-session lease and fencing identity is no longer current.",
    );
  }
}

function unavailableNativeChecks(): readonly ReadinessCheck[] {
  return Object.freeze(
    NATIVE_READINESS_CHECKS.map((name) =>
      Object.freeze({
        name,
        status: "fail" as const,
        evidence: "The native user-session helper readiness probe did not complete.",
        remediation: "Restart and diagnose the logged-in user-session helper.",
      }),
    ),
  );
}

async function withBoundaryTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Computer Use boundary verification timed out.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function validateReadinessRequest(request: ComputerUseReadinessRequest): void {
  requireIdentifier(request.deviceId, "device ID");
  requireIdentifier(request.helperInstanceId, "helper instance ID");
  requirePositiveInteger(request.serviceEpoch, "service epoch", Number.MAX_SAFE_INTEGER);
  requirePositiveInteger(
    request.persistenceGeneration,
    "persistence generation",
    Number.MAX_SAFE_INTEGER,
  );
}

function validateStartInput(input: StartComputerUseInput): void {
  validateReadinessRequest(input);
  requireIdentifier(input.commandId, "command ID");
  requireIdentifier(input.taskId, "Task ID");
  requireIdentifier(input.runId, "Run ID");
  if (input.lease.resourceName !== "desktop-session" || input.lease.capacity !== 1) {
    throw new ComputerUseOsError(
      "INVALID_INPUT",
      "Computer Use requires the capacity-one desktop-session resource.",
    );
  }
  requireIdentifier(input.lease.leaseId, "lease ID");
  requirePositiveInteger(input.lease.fencingToken, "lease fencing token", Number.MAX_SAFE_INTEGER);
  requirePositiveInteger(input.lease.expiresAtMs, "lease expiry", Number.MAX_SAFE_INTEGER);
  requirePositiveInteger(input.timeoutMs, "session timeout", MAX_TIMEOUT_MS);
}

function validateProbe(osFamily: ComputerUseOsFamily, probe: NativeDriverProbe): void {
  if (probe.osFamily !== osFamily) {
    throw new ComputerUseOsError(
      "DRIVER_OS_MISMATCH",
      "The native driver probe changed OS identity.",
    );
  }
  requireIdentifier(probe.backendId, "backend ID");
  requireIdentifier(probe.helperInstanceId, "helper instance ID");
  requirePositiveInteger(probe.serviceEpoch, "service epoch", Number.MAX_SAFE_INTEGER);
  const names = new Set(probe.checks.map((check) => check.name));
  if (
    probe.checks.length !== NATIVE_READINESS_CHECKS.length ||
    NATIVE_READINESS_CHECKS.some((name) => !names.has(name)) ||
    probe.checks.some((check) => check.name === "service-epoch")
  ) {
    throw new ComputerUseOsError(
      "DRIVER_FAILURE",
      "The native driver must report each non-epoch readiness check exactly once.",
    );
  }
  if (
    osFamily === "linux" &&
    probe.linuxTarget !== SUPPORTED_GRAPHICAL_LINUX_TARGET &&
    probe.linuxTarget !== "headless"
  ) {
    throw new ComputerUseOsError(
      "NOT_READY",
      "The Linux driver did not declare the supported graphical target or headless state.",
    );
  }
}

function requireIdentifier(value: unknown, label: string): asserts value is string {
  if (!isIdentifier(value)) {
    throw new ComputerUseOsError("INVALID_INPUT", `The ${label} is invalid.`);
  }
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    value === value.trim() &&
    [...value].every((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint > 31 && codePoint !== 127;
    })
  );
}

function requirePositiveInteger(value: number, label: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new ComputerUseOsError("INVALID_INPUT", `The ${label} must be a positive integer.`);
  }
}

function readClock(clock: ComputerUseClock): number {
  const now = clock.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new ComputerUseOsError("INVALID_INPUT", "The Computer Use clock is invalid.");
  }
  return now;
}

function hashCanonical(value: unknown): `sha256:${string}` {
  return `sha256:${sha256(canonicalJson(value))}`;
}

function hashBytes(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
