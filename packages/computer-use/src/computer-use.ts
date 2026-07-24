import { createHash } from "node:crypto";

import {
  ResourceLockError,
  type AcquireCommandSnapshot,
  type Clock,
  type ResourceLease,
  type ResourceLockKernel,
  type ResourceLockSnapshot,
} from "@opendelegate/resource-locks";

export type ComputerUseErrorCode =
  | "COMPUTER_USE_AUTHORIZATION_INVALID"
  | "COMPUTER_USE_CLOCK_INVALID"
  | "COMPUTER_USE_ID_INVALID"
  | "COMPUTER_USE_INPUT_NOT_AUTHORIZED"
  | "COMPUTER_USE_NOT_READY"
  | "COMPUTER_USE_EMERGENCY_STOPPED"
  | "COMPUTER_USE_RUN_CANCELLED"
  | "COMPUTER_USE_RUN_RELEASED"
  | "COMPUTER_USE_DESKTOP_RESOURCE_INVALID"
  | "COMPUTER_USE_START_COMMAND_CONFLICT"
  | "COMPUTER_USE_START_HISTORY_INVALID"
  | "COMPUTER_USE_START_HISTORY_UNAVAILABLE"
  | "DESKTOP_SESSION_BUSY"
  | "DESKTOP_SESSION_LEASE_LOST";

export class ComputerUseError extends Error {
  public readonly code: ComputerUseErrorCode;
  public readonly readiness: ComputerUseReadiness | undefined;

  public constructor(
    code: ComputerUseErrorCode,
    message: string,
    readiness?: ComputerUseReadiness,
  ) {
    super(message);
    this.name = "ComputerUseError";
    this.code = code;
    this.readiness = readiness;
  }
}

export type OsFamily = "linux" | "macos" | "windows";

export type ComputerUseReadinessStatus =
  "ready" | "no-user-session" | "locked-session" | "permission-denied" | "helper-unavailable";

export interface ReadyComputerUseReadiness {
  readonly status: "ready";
  readonly osFamily: OsFamily;
}

export interface UnavailableComputerUseReadiness {
  readonly status: Exclude<ComputerUseReadinessStatus, "ready">;
  readonly osFamily: OsFamily;
  readonly message: string;
  readonly remediation: string;
}

export type ComputerUseReadiness = ReadyComputerUseReadiness | UnavailableComputerUseReadiness;

export interface ComputerUseReadinessInput {
  readonly status: ComputerUseReadinessStatus;
  readonly osFamily: OsFamily;
}

export interface StartComputerUseRunInput {
  readonly commandId: string;
  readonly taskId: string;
  readonly deviceId: string;
  readonly runId: string;
  readonly leaseDurationMs: number;
}

export interface TypeTextInput {
  readonly controlId: string;
  readonly text: string;
}

export interface ClickInput {
  readonly controlId: string;
}

export interface ComputerUseClickAction {
  readonly kind: "click";
  readonly controlId: string;
}

export interface ComputerUseTypeTextAction {
  readonly kind: "type-text";
  readonly controlId: string;
  readonly textSha256: string;
  readonly textLength: number;
}

export type ComputerUseInputAction = ComputerUseClickAction | ComputerUseTypeTextAction;
export type ComputerUseActionFingerprint = `sha256:${string}`;
export type ComputerUseDesktopLockHistoryDigest = `sha256:${string}`;

export interface ComputerUseInputScope {
  readonly taskId: string;
  readonly deviceId: string;
  readonly runId: string;
  readonly action: ComputerUseInputAction;
}

export interface ComputerUseInputAuthorizationRequest extends ComputerUseInputScope {
  readonly actionCategory: "computer-use-input";
  readonly requestedAtMs: number;
  readonly fingerprint: ComputerUseActionFingerprint;
}

export type ComputerUseInputAuthorizationDecision = "allow" | "deny" | "require-approval";

export interface ComputerUseInputAuthorizationProof {
  readonly decision: ComputerUseInputAuthorizationDecision;
  readonly authorizationId: string;
  readonly fingerprint: ComputerUseActionFingerprint;
}

export interface ComputerUseInputAuthorizer {
  authorize(request: ComputerUseInputAuthorizationRequest): ComputerUseInputAuthorizationProof;
}

export interface FixtureTextInput {
  readonly controlId: "text-input";
  readonly label: "Task text";
  readonly value: string;
}

export interface FixtureOption {
  readonly controlId: "option-alpha" | "option-beta";
  readonly label: "Alpha" | "Beta";
  readonly selected: boolean;
}

export interface FixtureSubmitButton {
  readonly controlId: "submit";
  readonly label: "Submit";
  readonly enabled: boolean;
}

export interface ComputerUseObservation {
  readonly runId: string;
  readonly osFamily: OsFamily;
  readonly view: "computer-use-fixture";
  readonly state: "editing" | "success";
  readonly visibleRunId: string;
  readonly textInput: FixtureTextInput;
  readonly options: readonly FixtureOption[];
  readonly submitButton: FixtureSubmitButton;
  readonly resultContent: string | null;
}

export interface ComputerUseEvidence {
  readonly evidenceId: string;
  readonly runId: string;
  readonly osFamily: OsFamily;
  readonly kind: "screenshot";
  readonly mediaType: "image/png";
  readonly filename: string;
  readonly capturedAtMs: number;
  readonly sequence: number;
  readonly width: 1280;
  readonly height: 720;
  readonly observation: ComputerUseObservation;
}

export interface ComputerUseRun {
  observe(): ComputerUseObservation;
  click(input: ClickInput): void;
  typeText(input: TypeTextInput): void;
  captureEvidence(): ComputerUseEvidence;
  cancel(): void;
  emergencyStop(): void;
  release(): void;
}

export interface ComputerUseBackend {
  readiness(): ComputerUseReadiness;
  startRun(input: StartComputerUseRunInput): ComputerUseRun;
}

export interface FakeComputerUseBackendOptions {
  readonly clock: Clock;
  readonly locks: ResourceLockKernel;
  readonly authorizer: ComputerUseInputAuthorizer;
  readonly readiness: ComputerUseReadinessInput;
  readonly restoreFrom?: FakeComputerUseBackendSnapshot;
}

export interface FakeComputerUseBackendSnapshot {
  readonly schemaVersion: 3;
  readonly observedAtMs: number;
  readonly desktopLastIssuedFencingToken: number;
  readonly desktopLockHistoryDigest: ComputerUseDesktopLockHistoryDigest;
  readonly desktopActiveLeases: readonly ResourceLease[];
  readonly startCommands: readonly StartComputerUseRunInput[];
}

interface StartCommandRecord {
  readonly input: StartComputerUseRunInput;
  readonly run: ComputerUseRun | undefined;
}

export class FakeComputerUseBackend implements ComputerUseBackend {
  private readonly clock: Clock;
  private readonly locks: ResourceLockKernel;
  private readonly authorizer: ComputerUseInputAuthorizer;
  private readonly readinessState: ComputerUseReadiness;
  private readonly startCommands = new Map<string, StartCommandRecord>();

  public constructor(options: FakeComputerUseBackendOptions) {
    if (
      options.authorizer === null ||
      typeof options.authorizer !== "object" ||
      typeof options.authorizer.authorize !== "function"
    ) {
      throw new ComputerUseError(
        "COMPUTER_USE_AUTHORIZATION_INVALID",
        "A trusted Computer Use input authorizer is required.",
      );
    }
    this.clock = options.clock;
    this.locks = options.locks;
    this.authorizer = options.authorizer;
    this.readinessState = createReadiness(options.readiness);
    const lockSnapshot = this.locks.snapshot();
    requireExclusiveDesktopResource(lockSnapshot);
    if (options.restoreFrom !== undefined) {
      this.restoreStartHistory(options.restoreFrom, lockSnapshot);
    }
  }

  public readiness(): ComputerUseReadiness {
    return this.readinessState;
  }

  public snapshot(): FakeComputerUseBackendSnapshot {
    const lockSnapshot = this.locks.snapshot();
    const desktopResource = requireExclusiveDesktopResource(lockSnapshot);
    const desktopLastIssuedFencingToken = desktopResource.lastIssuedFencingToken;

    if (this.startCommands.size !== desktopLastIssuedFencingToken) {
      throw new ComputerUseError(
        "COMPUTER_USE_START_HISTORY_UNAVAILABLE",
        "Computer Use start-command history does not cover the desktop fencing history.",
      );
    }

    return Object.freeze({
      schemaVersion: 3,
      observedAtMs: lockSnapshot.observedAtMs,
      desktopLastIssuedFencingToken,
      desktopLockHistoryDigest: createDesktopLockHistoryDigest(lockSnapshot),
      desktopActiveLeases: Object.freeze(
        desktopResource.activeLeases.map((lease) => Object.freeze({ ...lease })),
      ),
      startCommands: Object.freeze(
        [...this.startCommands.values()].map((record) => Object.freeze({ ...record.input })),
      ),
    });
  }

  public startRun(input: StartComputerUseRunInput): ComputerUseRun {
    requireIdentifier("commandId", input.commandId);
    requireIdentifier("taskId", input.taskId);
    requireIdentifier("deviceId", input.deviceId);
    requireIdentifier("runId", input.runId);
    readClock(this.clock);

    if (this.readinessState.status !== "ready") {
      throw new ComputerUseError(
        "COMPUTER_USE_NOT_READY",
        this.readinessState.message,
        this.readinessState,
      );
    }

    const previousCommand = this.startCommands.get(input.commandId);
    if (previousCommand !== undefined) {
      if (!sameStartCommand(previousCommand.input, input)) {
        throw new ComputerUseError(
          "COMPUTER_USE_START_COMMAND_CONFLICT",
          `Computer Use start command "${input.commandId}" was already used with different input.`,
        );
      }

      if (previousCommand.run === undefined) {
        throw new ComputerUseError(
          "COMPUTER_USE_START_HISTORY_UNAVAILABLE",
          `Computer Use start command "${input.commandId}" was already executed, but its controller cannot be recovered after restart.`,
        );
      }

      return previousCommand.run;
    }

    const lockSnapshotBeforeAcquire = this.locks.snapshot();
    const desktopBeforeAcquire = requireExclusiveDesktopResource(lockSnapshotBeforeAcquire);
    const activeDesktopLeases = desktopBeforeAcquire.activeLeases;
    const lastIssuedFencingToken = desktopBeforeAcquire.lastIssuedFencingToken;

    if (this.startCommands.size !== lastIssuedFencingToken) {
      if (activeDesktopLeases.length > 0) {
        throw new ComputerUseError(
          "DESKTOP_SESSION_BUSY",
          "A live desktop-session lease has no recoverable Computer Use controller.",
        );
      }

      throw new ComputerUseError(
        "COMPUTER_USE_START_HISTORY_UNAVAILABLE",
        "Computer Use start-command history is unavailable for the existing desktop fencing history.",
      );
    }

    let lease: ResourceLease;

    try {
      lease = this.locks.acquire({
        commandId: input.commandId,
        resourceName: "desktop-session",
        holderId: input.runId,
        leaseDurationMs: input.leaseDurationMs,
      });
    } catch (error: unknown) {
      if (error instanceof ResourceLockError && error.code === "RESOURCE_CAPACITY_EXHAUSTED") {
        throw new ComputerUseError(
          "DESKTOP_SESSION_BUSY",
          "Another Computer Use run currently holds desktop-session.",
        );
      }

      throw error;
    }

    if (activeDesktopLeases.some((candidate) => sameLeaseIdentity(candidate, lease))) {
      throw new ComputerUseError(
        "DESKTOP_SESSION_BUSY",
        "A live desktop-session lease is already attached to another Computer Use controller.",
      );
    }

    const issuedNewLease = lease.fencingToken === lastIssuedFencingToken + 1;
    if (issuedNewLease) {
      this.startCommands.set(input.commandId, {
        input: Object.freeze({ ...input }),
        run: undefined,
      });
    }

    const acquiredLeaseIsLive =
      this.locks
        .snapshot()
        .resources.find((candidate) => candidate.resourceName === "desktop-session")
        ?.activeLeases.some((candidate) => sameLeaseIdentity(candidate, lease)) === true;
    if (!acquiredLeaseIsLive) {
      throw new ComputerUseError(
        "DESKTOP_SESSION_LEASE_LOST",
        "The acquired desktop-session lease is no longer live.",
      );
    }

    if (!issuedNewLease) {
      throw new ComputerUseError(
        "DESKTOP_SESSION_LEASE_LOST",
        "The desktop-session lease returned for this start command is stale.",
      );
    }

    const run = new FakeComputerUseRun({
      clock: this.clock,
      locks: this.locks,
      authorizer: this.authorizer,
      lease,
      osFamily: this.readinessState.osFamily,
      taskId: input.taskId,
      deviceId: input.deviceId,
      runId: input.runId,
    });
    this.startCommands.set(input.commandId, {
      input: Object.freeze({ ...input }),
      run,
    });

    return run;
  }

  private restoreStartHistory(
    snapshot: FakeComputerUseBackendSnapshot,
    lockSnapshot: ResourceLockSnapshot,
  ): void {
    const lockLastIssuedFencingToken =
      lockSnapshot.resources.find((candidate) => candidate.resourceName === "desktop-session")
        ?.lastIssuedFencingToken ?? 0;
    const desktopAcquireOutcomes = lockSnapshot.acquireCommands.filter(
      (candidate) => candidate.input.resourceName === "desktop-session",
    );
    const desktopAcquireOutcomesByCommandId = new Map(
      desktopAcquireOutcomes.map((candidate) => [candidate.input.commandId, candidate] as const),
    );

    if (
      snapshot === null ||
      typeof snapshot !== "object" ||
      snapshot.schemaVersion !== 3 ||
      !Number.isSafeInteger(snapshot.observedAtMs) ||
      snapshot.observedAtMs < 0 ||
      snapshot.observedAtMs > lockSnapshot.observedAtMs ||
      !Number.isSafeInteger(snapshot.desktopLastIssuedFencingToken) ||
      snapshot.desktopLastIssuedFencingToken < 0 ||
      snapshot.desktopLastIssuedFencingToken !== lockLastIssuedFencingToken ||
      typeof snapshot.desktopLockHistoryDigest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(snapshot.desktopLockHistoryDigest) ||
      snapshot.desktopLockHistoryDigest !== createDesktopLockHistoryDigest(lockSnapshot) ||
      !desktopActiveAuthorityIsCompatible(
        snapshot.desktopActiveLeases,
        snapshot.observedAtMs,
        lockSnapshot,
      ) ||
      !Array.isArray(snapshot.startCommands) ||
      snapshot.startCommands.length !== lockLastIssuedFencingToken ||
      desktopAcquireOutcomes.length !== lockLastIssuedFencingToken
    ) {
      throw invalidStartHistory();
    }

    const seenCommandIds = new Set<string>();
    const seenFencingTokens = new Set<number>();
    for (const input of snapshot.startCommands) {
      const desktopAcquireOutcome =
        input !== null && typeof input === "object" && typeof input.commandId === "string"
          ? desktopAcquireOutcomesByCommandId.get(input.commandId)
          : undefined;
      if (
        input === null ||
        typeof input !== "object" ||
        !isIdentifier(input.commandId) ||
        !isIdentifier(input.taskId) ||
        !isIdentifier(input.deviceId) ||
        !isIdentifier(input.runId) ||
        !Number.isSafeInteger(input.leaseDurationMs) ||
        input.leaseDurationMs <= 0 ||
        seenCommandIds.has(input.commandId) ||
        desktopAcquireOutcome === undefined ||
        !sameDesktopAcquireOutcome(input, desktopAcquireOutcome) ||
        seenFencingTokens.has(desktopAcquireOutcome.lease.fencingToken)
      ) {
        throw invalidStartHistory();
      }

      seenCommandIds.add(input.commandId);
      seenFencingTokens.add(desktopAcquireOutcome.lease.fencingToken);
      this.startCommands.set(input.commandId, {
        input: Object.freeze({ ...input }),
        run: undefined,
      });
    }

    if (seenFencingTokens.size !== lockLastIssuedFencingToken) {
      throw invalidStartHistory();
    }
  }
}

interface FakeComputerUseRunOptions {
  readonly clock: Clock;
  readonly locks: ResourceLockKernel;
  readonly authorizer: ComputerUseInputAuthorizer;
  readonly lease: ResourceLease;
  readonly osFamily: OsFamily;
  readonly taskId: string;
  readonly deviceId: string;
  readonly runId: string;
}

class FakeComputerUseRun implements ComputerUseRun {
  private readonly clock: Clock;
  private readonly authorizer: ComputerUseInputAuthorizer;
  private readonly deviceId: string;
  private readonly lease: ResourceLease;
  private readonly locks: ResourceLockKernel;
  private readonly osFamily: OsFamily;
  private readonly runId: string;
  private readonly taskId: string;
  private readonly evidenceFilenameToken: string;
  private evidenceSequence = 0;
  private terminalState: "active" | "cancelled" | "emergency-stopped" | "released" = "active";
  private selectedOptionId: FixtureOption["controlId"] | null = null;
  private state: ComputerUseObservation["state"] = "editing";
  private textInputValue = "";

  public constructor(options: FakeComputerUseRunOptions) {
    this.clock = options.clock;
    this.authorizer = options.authorizer;
    this.deviceId = options.deviceId;
    this.lease = options.lease;
    this.locks = options.locks;
    this.osFamily = options.osFamily;
    this.runId = options.runId;
    this.taskId = options.taskId;
    this.evidenceFilenameToken = sha256(options.runId).slice(0, 16);
  }

  public observe(): ComputerUseObservation {
    this.requireDesktopLease();

    return this.createObservation();
  }

  public click(input: ClickInput): void {
    const requestedAtMs = this.requireDesktopLease();
    requireIdentifier("controlId", input.controlId);
    this.authorizeInput(
      Object.freeze({
        kind: "click",
        controlId: input.controlId,
      }),
      requestedAtMs,
    );
    this.requireDesktopLease();

    if (input.controlId === "option-alpha" || input.controlId === "option-beta") {
      this.selectedOptionId = input.controlId;
      return;
    }

    if (input.controlId === "submit" && this.canSubmit()) {
      const selectedLabel = this.selectedOptionId === "option-alpha" ? "Alpha" : "Beta";
      this.state = "success";
      this.resultContent = `${this.runId} | ${selectedLabel} | ${this.textInputValue}`;
    }
  }

  public typeText(input: TypeTextInput): void {
    const requestedAtMs = this.requireDesktopLease();
    requireIdentifier("controlId", input.controlId);
    if (typeof input.text !== "string") {
      throw new ComputerUseError("COMPUTER_USE_ID_INVALID", "Input text must be a string.");
    }
    this.authorizeInput(
      Object.freeze({
        kind: "type-text",
        controlId: input.controlId,
        textSha256: sha256(input.text),
        textLength: input.text.length,
      }),
      requestedAtMs,
    );
    this.requireDesktopLease();

    if (input.controlId === "text-input") {
      this.textInputValue += input.text;
    }
  }

  public captureEvidence(): ComputerUseEvidence {
    const capturedAtMs = this.requireDesktopLease();
    this.evidenceSequence += 1;
    const sequence = this.evidenceSequence;

    return Object.freeze({
      evidenceId: `computer-use-evidence:${this.evidenceFilenameToken}:${sequence}`,
      runId: this.runId,
      osFamily: this.osFamily,
      kind: "screenshot",
      mediaType: "image/png",
      filename: `computer-use-${this.evidenceFilenameToken}-screenshot-${sequence}.png`,
      capturedAtMs,
      sequence,
      width: 1280,
      height: 720,
      observation: this.createObservation(),
    });
  }

  public cancel(): void {
    this.stop("cancelled");
  }

  public emergencyStop(): void {
    this.stop("emergency-stopped");
  }

  public release(): void {
    if (this.terminalState !== "active") {
      return;
    }

    readClock(this.clock);
    this.locks.release({
      resourceName: this.lease.resourceName,
      holderId: this.lease.holderId,
      fencingToken: this.lease.fencingToken,
    });
    this.terminalState = "released";
  }

  private resultContent: string | null = null;

  private canSubmit(): boolean {
    return this.textInputValue.length > 0 && this.selectedOptionId !== null;
  }

  private createObservation(): ComputerUseObservation {
    return Object.freeze({
      runId: this.runId,
      osFamily: this.osFamily,
      view: "computer-use-fixture",
      state: this.state,
      visibleRunId: this.runId,
      textInput: Object.freeze({
        controlId: "text-input",
        label: "Task text",
        value: this.textInputValue,
      }),
      options: Object.freeze([
        Object.freeze({
          controlId: "option-alpha",
          label: "Alpha",
          selected: this.selectedOptionId === "option-alpha",
        }),
        Object.freeze({
          controlId: "option-beta",
          label: "Beta",
          selected: this.selectedOptionId === "option-beta",
        }),
      ]),
      submitButton: Object.freeze({
        controlId: "submit",
        label: "Submit",
        enabled: this.canSubmit(),
      }),
      resultContent: this.resultContent,
    });
  }

  private authorizeInput(action: ComputerUseInputAction, requestedAtMs: number): void {
    const scope = Object.freeze({
      taskId: this.taskId,
      deviceId: this.deviceId,
      runId: this.runId,
      action,
    });
    const request = Object.freeze({
      actionCategory: "computer-use-input" as const,
      ...scope,
      requestedAtMs,
      fingerprint: createComputerUseInputFingerprint(scope),
    });
    const proof = this.authorizer.authorize(request);

    if (
      proof === null ||
      typeof proof !== "object" ||
      !isAuthorizationDecision(proof.decision) ||
      !isIdentifier(proof.authorizationId) ||
      typeof proof.fingerprint !== "string" ||
      proof.fingerprint !== request.fingerprint
    ) {
      throw new ComputerUseError(
        "COMPUTER_USE_AUTHORIZATION_INVALID",
        "The trusted Computer Use authorizer returned an invalid or mismatched proof.",
      );
    }

    if (proof.decision !== "allow") {
      throw new ComputerUseError(
        "COMPUTER_USE_INPUT_NOT_AUTHORIZED",
        `Computer Use input was not authorized (${proof.decision}).`,
      );
    }
  }

  private requireDesktopLease(): number {
    if (this.terminalState === "cancelled") {
      throw new ComputerUseError(
        "COMPUTER_USE_RUN_CANCELLED",
        `Computer Use run "${this.runId}" was cancelled.`,
      );
    }

    if (this.terminalState === "emergency-stopped") {
      throw new ComputerUseError(
        "COMPUTER_USE_EMERGENCY_STOPPED",
        `Computer Use run "${this.runId}" was stopped by emergency control.`,
      );
    }

    if (this.terminalState === "released") {
      throw new ComputerUseError(
        "COMPUTER_USE_RUN_RELEASED",
        `Computer Use run "${this.runId}" has been released.`,
      );
    }

    const currentTimeMs = readClock(this.clock);
    const resource = this.locks
      .snapshot()
      .resources.find((candidate) => candidate.resourceName === "desktop-session");
    const ownsLease = resource?.activeLeases.some(
      (candidate) =>
        candidate.holderId === this.runId &&
        candidate.fencingToken === this.lease.fencingToken &&
        candidate.expiresAtMs > currentTimeMs,
    );

    if (ownsLease !== true) {
      throw new ComputerUseError(
        "DESKTOP_SESSION_LEASE_LOST",
        `Computer Use run "${this.runId}" no longer owns desktop-session.`,
      );
    }

    return currentTimeMs;
  }

  private stop(terminalState: "cancelled" | "emergency-stopped"): void {
    if (this.terminalState !== "active") {
      return;
    }

    readClock(this.clock);
    this.locks.cancel({
      resourceName: this.lease.resourceName,
      holderId: this.lease.holderId,
      fencingToken: this.lease.fencingToken,
    });
    this.terminalState = terminalState;
  }
}

export function createComputerUseInputFingerprint(
  scope: ComputerUseInputScope,
): ComputerUseActionFingerprint {
  if (scope === null || typeof scope !== "object") {
    throw new ComputerUseError(
      "COMPUTER_USE_AUTHORIZATION_INVALID",
      "Computer Use input authorization scope is invalid.",
    );
  }
  requireIdentifier("taskId", scope.taskId);
  requireIdentifier("deviceId", scope.deviceId);
  requireIdentifier("runId", scope.runId);
  if (
    scope.action === null ||
    typeof scope.action !== "object" ||
    (scope.action.kind !== "click" && scope.action.kind !== "type-text")
  ) {
    throw new ComputerUseError(
      "COMPUTER_USE_AUTHORIZATION_INVALID",
      "Computer Use input action is invalid.",
    );
  }
  requireIdentifier("controlId", scope.action.controlId);
  if (
    scope.action.kind === "type-text" &&
    (!Number.isSafeInteger(scope.action.textLength) ||
      scope.action.textLength < 0 ||
      !/^[a-f0-9]{64}$/.test(scope.action.textSha256))
  ) {
    throw new ComputerUseError(
      "COMPUTER_USE_AUTHORIZATION_INVALID",
      "Computer Use type-text authorization metadata is invalid.",
    );
  }

  const normalizedAction =
    scope.action.kind === "click"
      ? `click:${scope.action.controlId}`
      : `type-text:${scope.action.controlId}:${scope.action.textLength}:${scope.action.textSha256}`;
  const canonical = [
    "computer-use-input",
    "v1",
    scope.taskId,
    scope.deviceId,
    scope.runId,
    normalizedAction,
  ].join("\u001f");

  return `sha256:${sha256(canonical)}`;
}

function isAuthorizationDecision(value: unknown): value is ComputerUseInputAuthorizationDecision {
  return value === "allow" || value === "deny" || value === "require-approval";
}

function requireIdentifier(field: string, value: unknown): asserts value is string {
  if (!isIdentifier(value)) {
    throw new ComputerUseError("COMPUTER_USE_ID_INVALID", `Computer Use ${field} is invalid.`);
  }
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
}

function readClock(clock: Clock): number {
  const value = clock.now();

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ComputerUseError(
      "COMPUTER_USE_CLOCK_INVALID",
      "Computer Use clock must return a non-negative safe integer.",
    );
  }

  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sameStartCommand(
  first: StartComputerUseRunInput,
  second: StartComputerUseRunInput,
): boolean {
  return (
    first.commandId === second.commandId &&
    first.taskId === second.taskId &&
    first.deviceId === second.deviceId &&
    first.runId === second.runId &&
    first.leaseDurationMs === second.leaseDurationMs
  );
}

function sameLeaseIdentity(first: ResourceLease, second: ResourceLease): boolean {
  return (
    first.resourceName === second.resourceName &&
    first.holderId === second.holderId &&
    first.fencingToken === second.fencingToken
  );
}

function sameDesktopAcquireOutcome(
  input: StartComputerUseRunInput,
  outcome: AcquireCommandSnapshot,
): boolean {
  return (
    outcome.input.commandId === input.commandId &&
    outcome.input.resourceName === "desktop-session" &&
    outcome.input.holderId === input.runId &&
    outcome.input.leaseDurationMs === input.leaseDurationMs &&
    outcome.lease.resourceName === "desktop-session" &&
    outcome.lease.holderId === input.runId &&
    Number.isSafeInteger(outcome.lease.fencingToken) &&
    outcome.lease.fencingToken > 0
  );
}

function requireExclusiveDesktopResource(snapshot: ResourceLockSnapshot) {
  const desktopResource = snapshot.resources.find(
    (candidate) => candidate.resourceName === "desktop-session",
  );
  if (desktopResource === undefined || desktopResource.capacity !== 1) {
    throw new ComputerUseError(
      "COMPUTER_USE_DESKTOP_RESOURCE_INVALID",
      'Computer Use requires one "desktop-session" resource with capacity exactly 1.',
    );
  }

  return desktopResource;
}

function createDesktopLockHistoryDigest(
  snapshot: ResourceLockSnapshot,
): ComputerUseDesktopLockHistoryDigest {
  const desktopResource = snapshot.resources.find(
    (candidate) => candidate.resourceName === "desktop-session",
  );
  const canonicalDesktopResource =
    desktopResource === undefined
      ? null
      : [
          desktopResource.resourceName,
          desktopResource.capacity,
          desktopResource.lastIssuedFencingToken,
        ];
  const canonicalDesktopAcquireOutcomes = snapshot.acquireCommands
    .filter((candidate) => candidate.input.resourceName === "desktop-session")
    .sort(
      (left, right) =>
        left.lease.fencingToken - right.lease.fencingToken ||
        compareCanonicalStrings(left.input.commandId, right.input.commandId),
    )
    .map((outcome) => [
      outcome.input.commandId,
      outcome.input.resourceName,
      outcome.input.holderId,
      outcome.input.leaseDurationMs,
      outcome.lease.resourceName,
      outcome.lease.holderId,
      outcome.lease.fencingToken,
      outcome.lease.acquiredAtMs,
      outcome.lease.expiresAtMs,
    ]);
  const canonicalDesktopRenewals = snapshot.leaseRenewals
    .filter((candidate) => candidate.input.resourceName === "desktop-session")
    .sort(
      (left, right) =>
        left.input.fencingToken - right.input.fencingToken ||
        left.renewalSequence - right.renewalSequence,
    )
    .map((renewal) => [
      renewal.input.commandId,
      renewal.renewalSequence,
      renewal.input.resourceName,
      renewal.input.holderId,
      renewal.input.fencingToken,
      renewal.input.leaseDurationMs,
      renewal.renewedAtMs,
      renewal.previousExpiresAtMs,
      renewal.lease.resourceName,
      renewal.lease.holderId,
      renewal.lease.fencingToken,
      renewal.lease.acquiredAtMs,
      renewal.lease.expiresAtMs,
    ]);
  const canonicalAuthority = JSON.stringify([
    "opendelegate-computer-use-desktop-lock-authority",
    1,
    canonicalDesktopResource,
    canonicalDesktopAcquireOutcomes,
    canonicalDesktopRenewals,
  ]);

  return `sha256:${sha256(canonicalAuthority)}`;
}

function desktopActiveAuthorityIsCompatible(
  capturedValue: unknown,
  capturedAtMs: number,
  currentSnapshot: ResourceLockSnapshot,
): boolean {
  if (!Array.isArray(capturedValue)) {
    return false;
  }

  const currentDesktopResource = currentSnapshot.resources.find(
    (candidate) => candidate.resourceName === "desktop-session",
  );
  if (capturedValue.length > (currentDesktopResource?.capacity ?? 0)) {
    return false;
  }
  const lastIssuedFencingToken = currentDesktopResource?.lastIssuedFencingToken ?? 0;
  const latestDurableLeases = new Map<number, ResourceLease>();

  for (const outcome of currentSnapshot.acquireCommands) {
    if (outcome.input.resourceName === "desktop-session") {
      latestDurableLeases.set(outcome.lease.fencingToken, outcome.lease);
    }
  }
  for (const renewal of currentSnapshot.leaseRenewals) {
    if (renewal.input.resourceName === "desktop-session") {
      latestDurableLeases.set(renewal.lease.fencingToken, renewal.lease);
    }
  }

  const capturedLeases = new Map<number, ResourceLease>();
  for (const candidate of capturedValue) {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      candidate.resourceName !== "desktop-session" ||
      !isIdentifier(candidate.holderId) ||
      !Number.isSafeInteger(candidate.fencingToken) ||
      candidate.fencingToken <= 0 ||
      candidate.fencingToken > lastIssuedFencingToken ||
      !Number.isSafeInteger(candidate.acquiredAtMs) ||
      candidate.acquiredAtMs < 0 ||
      candidate.acquiredAtMs > capturedAtMs ||
      !Number.isSafeInteger(candidate.expiresAtMs) ||
      candidate.expiresAtMs <= capturedAtMs ||
      candidate.expiresAtMs <= candidate.acquiredAtMs ||
      capturedLeases.has(candidate.fencingToken)
    ) {
      return false;
    }

    const latestDurableLease = latestDurableLeases.get(candidate.fencingToken);
    if (
      latestDurableLease === undefined ||
      !sameLeaseAuthority(candidate as ResourceLease, latestDurableLease)
    ) {
      return false;
    }
    capturedLeases.set(candidate.fencingToken, Object.freeze({ ...(candidate as ResourceLease) }));
  }

  const currentActiveLeases = currentDesktopResource?.activeLeases ?? [];
  const currentActiveLeasesByFence = new Map(
    currentActiveLeases.map((lease) => [lease.fencingToken, lease] as const),
  );
  for (const currentLease of currentActiveLeases) {
    const capturedLease = capturedLeases.get(currentLease.fencingToken);
    if (capturedLease === undefined || !sameLeaseAuthority(capturedLease, currentLease)) {
      return false;
    }
  }
  for (const capturedLease of capturedLeases.values()) {
    const currentLease = currentActiveLeasesByFence.get(capturedLease.fencingToken);
    if (capturedLease.expiresAtMs > currentSnapshot.observedAtMs) {
      if (currentLease === undefined || !sameLeaseAuthority(capturedLease, currentLease)) {
        return false;
      }
    } else if (currentLease !== undefined) {
      return false;
    }
  }

  return true;
}

function sameLeaseAuthority(first: ResourceLease, second: ResourceLease): boolean {
  return (
    first.resourceName === second.resourceName &&
    first.holderId === second.holderId &&
    first.fencingToken === second.fencingToken &&
    first.acquiredAtMs === second.acquiredAtMs &&
    first.expiresAtMs === second.expiresAtMs
  );
}

function compareCanonicalStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function invalidStartHistory(): ComputerUseError {
  return new ComputerUseError(
    "COMPUTER_USE_START_HISTORY_INVALID",
    "Computer Use start-command history is malformed or does not match the desktop fencing history.",
  );
}

function createReadiness(input: ComputerUseReadinessInput): ComputerUseReadiness {
  switch (input.status) {
    case "ready":
      return Object.freeze({ ...input, status: "ready" });
    case "no-user-session":
      return Object.freeze({
        ...input,
        status: "no-user-session",
        message: "No interactive user session is available.",
        remediation: "Sign in to an interactive desktop session on this Device.",
      });
    case "locked-session":
      return Object.freeze({
        ...input,
        status: "locked-session",
        message: "The interactive desktop session is locked.",
        remediation: "Unlock the desktop session before retrying Computer Use.",
      });
    case "permission-denied":
      return Object.freeze({
        ...input,
        status: "permission-denied",
        message: "Screen capture or input permission is not granted.",
        remediation: "Grant the required screen capture and accessibility/input permissions.",
      });
    case "helper-unavailable":
      return Object.freeze({
        ...input,
        status: "helper-unavailable",
        message: "The OpenDelegate user-session helper is unavailable.",
        remediation: "Start or reinstall the OpenDelegate user-session helper.",
      });
  }
}
