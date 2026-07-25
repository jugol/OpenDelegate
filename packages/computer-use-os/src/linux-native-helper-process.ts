import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { posix } from "node:path";

import {
  NativeDriverError,
  SUPPORTED_GRAPHICAL_LINUX_TARGET,
  type NativeActionReceipt,
  type NativeCapture,
  type NativeComputerUseAction,
  type NativeDriverControlContext,
  type NativeDriverErrorCode,
  type NativeDriverExecutionContext,
  type NativeDriverProbe,
  type NativeObservation,
  type ReadinessCheck,
  type ReadinessCheckName,
} from "./contracts.ts";
import {
  LINUX_NATIVE_BACKEND_ID,
  type LinuxAuthenticatedHelperSession,
  type LinuxNativeHelperPort,
} from "./linux-native-driver.ts";

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 128 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_EVIDENCE_BYTES = 4 * 1024;
const MAX_ACCESSIBILITY_CONTROLS = 2_048;
const MAX_CONTROL_VALUE_BYTES = 4 * 1024;
const MAX_FIXTURE_RESULT_BYTES = 1024 * 1024;
const FORCE_KILL_AFTER_MS = 1_000;
const READINESS_CHECK_NAMES = new Set<ReadinessCheckName>([
  "interactive-session",
  "unlocked-session",
  "screen-capture",
  "accessibility",
  "input",
  "helper-authentication",
]);

export type LinuxNativeHelperWireOperation =
  "act" | "cancel" | "capture" | "emergency-stop" | "observe" | "probe";

interface LinuxWireExecutionContext {
  readonly executionHandleId: string;
  readonly taskId: string;
  readonly deviceId: string;
  readonly runId: string;
  readonly helperInstanceId: string;
  readonly serviceEpoch: number;
  readonly persistenceGeneration: number;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly expectedDisplayFingerprint: string;
}

export interface LinuxNativeHelperWireRequest {
  readonly protocolVersion: 1;
  readonly requestId: string;
  readonly sequence: number;
  readonly binding: LinuxAuthenticatedHelperSession;
  readonly operation: LinuxNativeHelperWireOperation;
  readonly execution?: LinuxWireExecutionContext;
  readonly control?: NativeDriverControlContext;
  readonly action?: NativeComputerUseAction;
}

export interface LinuxNativeHelperWireResponse {
  readonly protocolVersion: 1;
  readonly requestId: string;
  readonly sequence: number;
  readonly binding: LinuxAuthenticatedHelperSession;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: {
    readonly code: NativeDriverErrorCode;
    readonly message?: string;
  };
  readonly wireBytes: number;
}

export interface LinuxNativeHelperBinaryVerificationRequest {
  readonly executablePath: string;
  readonly expectedSha256: `sha256:${string}`;
  readonly requireOwnerOnlyMutation: true;
}

export interface LinuxNativeHelperBinaryVerifier {
  verify(request: LinuxNativeHelperBinaryVerificationRequest): Promise<void>;
}

export interface LinuxNativeHelperDesktopEnvironment {
  readonly DBUS_SESSION_BUS_ADDRESS: string;
  readonly WAYLAND_DISPLAY: string;
  readonly XDG_CURRENT_DESKTOP: string;
  readonly XDG_RUNTIME_DIR: string;
  readonly XDG_SESSION_TYPE: "wayland";
}

export interface LinuxNativeHelperChildStartRequest {
  readonly executablePath: string;
  readonly arguments: readonly string[];
  readonly environment: LinuxNativeHelperDesktopEnvironment;
  readonly exposeListener: false;
}

export interface LinuxNativeHelperChildTransport {
  request(
    request: LinuxNativeHelperWireRequest,
    signal?: AbortSignal,
  ): Promise<LinuxNativeHelperWireResponse>;
  close(): Promise<void>;
}

export interface LinuxNativeHelperChildTransportFactory {
  start(request: LinuxNativeHelperChildStartRequest): Promise<LinuxNativeHelperChildTransport>;
}

export interface LinuxNativeHelperRequestIdSource {
  nextRequestId(): string;
}

export interface StartLinuxNativeHelperChildProcessOptions {
  readonly authenticatedSession: LinuxAuthenticatedHelperSession;
  readonly executablePath: string;
  readonly expectedExecutableSha256: `sha256:${string}`;
  readonly desktopEnvironment: Readonly<Record<string, string | undefined>>;
  readonly hostPlatform?: NodeJS.Platform;
  readonly binaryVerifier?: LinuxNativeHelperBinaryVerifier;
  readonly transportFactory?: LinuxNativeHelperChildTransportFactory;
  readonly parentProcessId?: number;
  readonly fixtureResultDirectory?: string;
  readonly requestIdSource?: LinuxNativeHelperRequestIdSource;
}

/**
 * Starts the GNOME portal child from inside the already-authenticated graphical
 * user-session helper. Only anonymous inherited stdio is exposed. The child never
 * binds the ADR-0011 Unix socket and cannot be reached by another local process.
 */
export async function startLinuxNativeHelperChildProcess(
  options: StartLinuxNativeHelperChildProcessOptions,
): Promise<LinuxNativeHelperChildProcessPort> {
  if ((options.hostPlatform ?? process.platform) !== "linux") {
    throw nativeFailure("UNAVAILABLE", "The Linux native helper can run only on Linux.");
  }
  const desktopEnvironment = validateDesktopEnvironment(options.desktopEnvironment);
  const session = validateAuthenticatedSession(options.authenticatedSession);
  const executablePath = validateAbsolutePath(options.executablePath, "native helper executable");
  if (!/^sha256:[0-9a-f]{64}$/u.test(options.expectedExecutableSha256)) {
    throw nativeFailure("UNAVAILABLE", "The Linux native helper digest is invalid.");
  }
  const parentProcessId = options.parentProcessId ?? process.pid;
  if (!Number.isSafeInteger(parentProcessId) || parentProcessId <= 0) {
    throw nativeFailure("UNAVAILABLE", "The Linux session-helper process identity is invalid.");
  }
  const fixtureResultDirectory =
    options.fixtureResultDirectory === undefined
      ? undefined
      : validateAbsolutePath(options.fixtureResultDirectory, "fixture result directory");
  const verifier = options.binaryVerifier ?? new NodeLinuxNativeHelperBinaryVerifier();
  try {
    await verifier.verify({
      executablePath,
      expectedSha256: options.expectedExecutableSha256,
      requireOwnerOnlyMutation: true,
    });
  } catch {
    throw nativeFailure(
      "UNAVAILABLE",
      "The Linux native helper failed integrity and ownership verification.",
    );
  }

  const arguments_ = [
    "--stdio-child",
    "--helper-instance-id",
    session.helperInstanceId,
    "--service-epoch",
    String(session.serviceEpoch),
    "--os-session-identity",
    session.osSessionIdentity,
    "--release-version",
    session.releaseVersion,
    "--parent-pid",
    String(parentProcessId),
    ...(fixtureResultDirectory === undefined
      ? []
      : ["--fixture-result-directory", fixtureResultDirectory]),
  ];
  let transport: LinuxNativeHelperChildTransport;
  try {
    transport = await (
      options.transportFactory ?? new NodeLinuxNativeHelperChildTransportFactory()
    ).start({
      executablePath,
      arguments: arguments_,
      environment: desktopEnvironment,
      exposeListener: false,
    });
  } catch {
    throw nativeFailure("HELPER_CRASHED", "The Linux native helper child could not start.");
  }
  return new LinuxNativeHelperChildProcessPort({
    session,
    transport,
    requestIds: options.requestIdSource ?? { nextRequestId: () => randomUUID() },
  });
}

export class LinuxNativeHelperChildProcessPort implements LinuxNativeHelperPort {
  readonly #session: LinuxAuthenticatedHelperSession;
  readonly #transport: LinuxNativeHelperChildTransport;
  readonly #requestIds: LinuxNativeHelperRequestIdSource;
  #sequence = 0;
  #closed = false;

  public constructor(input: {
    readonly session: LinuxAuthenticatedHelperSession;
    readonly transport: LinuxNativeHelperChildTransport;
    readonly requestIds: LinuxNativeHelperRequestIdSource;
  }) {
    this.#session = input.session;
    this.#transport = input.transport;
    this.#requestIds = input.requestIds;
  }

  public currentSession(): LinuxAuthenticatedHelperSession {
    return this.#session;
  }

  public async probe(): Promise<NativeDriverProbe> {
    const result = await this.#request("probe");
    return this.#parse(() => parseProbe(result));
  }

  public async observe(context: NativeDriverExecutionContext): Promise<NativeObservation> {
    const result = await this.#request("observe", {
      execution: wireExecutionContext(context),
      signal: context.signal,
    });
    return this.#parse(() => parseObservation(result));
  }

  public async capture(context: NativeDriverExecutionContext): Promise<NativeCapture> {
    const result = await this.#request("capture", {
      execution: wireExecutionContext(context),
      signal: context.signal,
    });
    return this.#parse(() => parseCapture(result));
  }

  public async act(
    context: NativeDriverExecutionContext,
    action: NativeComputerUseAction,
  ): Promise<NativeActionReceipt> {
    const result = await this.#request("act", {
      execution: wireExecutionContext(context),
      action,
      signal: context.signal,
    });
    return this.#parse(() => parseActionReceipt(result));
  }

  public async cancel(context: NativeDriverControlContext): Promise<void> {
    const result = await this.#request("cancel", { control: context });
    this.#parse(() => parseStopReceipt(result));
  }

  public async emergencyStop(context: NativeDriverControlContext): Promise<void> {
    const result = await this.#request("emergency-stop", { control: context });
    this.#parse(() => parseStopReceipt(result));
  }

  public async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.#transport.close().catch(() => undefined);
  }

  async #request(
    operation: LinuxNativeHelperWireOperation,
    options: {
      readonly execution?: LinuxWireExecutionContext;
      readonly control?: NativeDriverControlContext;
      readonly action?: NativeComputerUseAction;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<unknown> {
    if (this.#closed) {
      throw nativeFailure("HELPER_CRASHED", "The Linux native helper child is closed.");
    }
    if (options.signal?.aborted === true) {
      await this.close();
      throw nativeFailure("CANCELLED", "The Linux native operation was cancelled.");
    }
    this.#sequence += 1;
    const request: LinuxNativeHelperWireRequest = {
      protocolVersion: PROTOCOL_VERSION,
      requestId: validateRequestId(this.#requestIds.nextRequestId()),
      sequence: this.#sequence,
      binding: this.#session,
      operation,
      ...(options.execution === undefined ? {} : { execution: options.execution }),
      ...(options.control === undefined ? {} : { control: options.control }),
      ...(options.action === undefined ? {} : { action: options.action }),
    };
    let response: LinuxNativeHelperWireResponse;
    try {
      response = await this.#transport.request(request, options.signal);
      validateResponseEnvelope(response, request, this.#session);
      if (!response.ok) {
        const code = validateNativeErrorCode(response.error?.code);
        if (code === undefined) {
          throw new Error("Native error code is invalid.");
        }
        throw nativeFailure(code, nativeMessage(code));
      }
      if (response.result === undefined) {
        throw new Error("Native result is missing.");
      }
      return response.result;
    } catch (error: unknown) {
      await this.close();
      if (error instanceof NativeDriverError) {
        throw error;
      }
      throw nativeFailure(
        "HELPER_CRASHED",
        "The Linux native helper returned an invalid or unavailable response.",
      );
    }
  }

  #parse<T>(parser: () => T): T {
    try {
      return parser();
    } catch (error: unknown) {
      void this.close();
      if (error instanceof NativeDriverError) {
        throw error;
      }
      throw nativeFailure("HELPER_CRASHED", "The Linux native helper returned an invalid result.");
    }
  }
}

export class NodeLinuxNativeHelperBinaryVerifier implements LinuxNativeHelperBinaryVerifier {
  public async verify(request: LinuxNativeHelperBinaryVerificationRequest): Promise<void> {
    const canonical = await realpath(request.executablePath);
    if (canonical !== request.executablePath) {
      throw new Error("Native helper path is not canonical.");
    }
    const before = await lstat(canonical);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size <= 0 ||
      before.size > MAX_EXECUTABLE_BYTES ||
      (before.mode & 0o111) === 0 ||
      (request.requireOwnerOnlyMutation && (before.mode & 0o022) !== 0) ||
      (currentUid !== undefined && before.uid !== currentUid && before.uid !== 0)
    ) {
      throw new Error("Native helper metadata is unsafe.");
    }
    const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let bytes: Buffer;
    try {
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    try {
      const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      if (digest !== request.expectedSha256) {
        throw new Error("Native helper digest mismatch.");
      }
    } finally {
      bytes.fill(0);
    }
    const after = await lstat(canonical);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new Error("Native helper changed during verification.");
    }
  }
}

export class NodeLinuxNativeHelperChildTransportFactory implements LinuxNativeHelperChildTransportFactory {
  public async start(
    request: LinuxNativeHelperChildStartRequest,
  ): Promise<LinuxNativeHelperChildTransport> {
    if (request.exposeListener !== false) {
      throw new Error("The Linux native child cannot expose a listener.");
    }
    const child = spawn(request.executablePath, request.arguments, {
      env: { ...request.environment },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    return new NodeLinuxNativeHelperChildTransport(child);
  }
}

class NodeLinuxNativeHelperChildTransport implements LinuxNativeHelperChildTransport {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<
    string,
    {
      readonly resolve: (response: LinuxNativeHelperWireResponse) => void;
      readonly reject: (error: Error) => void;
      readonly signal?: AbortSignal;
      readonly abort?: () => void;
    }
  >();
  #stdout = Buffer.alloc(0);
  #stderrBytes = 0;
  #closed = false;

  public constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child;
    child.stdout.on("data", (chunk: Buffer) => this.#consumeStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.#stderrBytes += chunk.byteLength;
      if (this.#stderrBytes > MAX_STDERR_BYTES) {
        void this.close();
      }
    });
    child.once("error", () => void this.close());
    child.once("exit", () => void this.close());
  }

  public request(
    request: LinuxNativeHelperWireRequest,
    signal?: AbortSignal,
  ): Promise<LinuxNativeHelperWireResponse> {
    if (this.#closed || signal?.aborted === true) {
      return Promise.reject(
        nativeFailure(
          signal?.aborted === true ? "CANCELLED" : "HELPER_CRASHED",
          "The Linux native helper child is unavailable.",
        ),
      );
    }
    const frame = Buffer.from(`${JSON.stringify(request)}\n`, "utf8");
    if (frame.byteLength > MAX_FRAME_BYTES) {
      return Promise.reject(nativeFailure("UNAVAILABLE", "The native request is too large."));
    }
    return new Promise((resolve, reject) => {
      if (this.#pending.has(request.requestId)) {
        reject(nativeFailure("HELPER_CRASHED", "The native request ID was reused."));
        void this.close();
        return;
      }
      let abort: (() => void) | undefined;
      if (signal !== undefined) {
        abort = () => {
          this.#pending.delete(request.requestId);
          reject(nativeFailure("CANCELLED", "The Linux native operation was cancelled."));
          void this.close();
        };
        signal.addEventListener("abort", abort, { once: true });
      }
      this.#pending.set(request.requestId, {
        resolve,
        reject,
        ...(signal === undefined ? {} : { signal }),
        ...(abort === undefined ? {} : { abort }),
      });
      this.#child.stdin.write(frame, (error) => {
        if (error !== null && error !== undefined) {
          const pending = this.#pending.get(request.requestId);
          this.#pending.delete(request.requestId);
          pending?.signal?.removeEventListener("abort", pending.abort ?? (() => undefined));
          reject(nativeFailure("HELPER_CRASHED", "The Linux native helper pipe closed."));
        }
      });
    });
  }

  public async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#child.stdin.destroy();
    this.#child.stdout.destroy();
    this.#child.stderr.destroy();
    this.#child.kill("SIGTERM");
    const forceKill = setTimeout(() => {
      if (this.#child.exitCode === null && this.#child.signalCode === null) {
        this.#child.kill("SIGKILL");
      }
    }, FORCE_KILL_AFTER_MS);
    forceKill.unref();
    const error = nativeFailure("HELPER_CRASHED", "The Linux native helper child exited.");
    for (const pending of this.#pending.values()) {
      pending.signal?.removeEventListener("abort", pending.abort ?? (() => undefined));
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #consumeStdout(chunk: Buffer): void {
    if (this.#closed) {
      return;
    }
    this.#stdout = Buffer.concat([this.#stdout, chunk]);
    if (this.#stdout.byteLength > MAX_FRAME_BYTES) {
      void this.close();
      return;
    }
    while (true) {
      const newline = this.#stdout.indexOf(0x0a);
      if (newline < 0) {
        return;
      }
      const frame = this.#stdout.subarray(0, newline);
      this.#stdout = this.#stdout.subarray(newline + 1);
      if (frame.byteLength === 0 || frame.byteLength > MAX_FRAME_BYTES) {
        void this.close();
        return;
      }
      let record: Record<string, unknown>;
      let requestId: string;
      try {
        record = readRecord(JSON.parse(frame.toString("utf8")), "native helper response");
        requestId = readIdentifier(record["requestId"], "native response request ID");
      } catch {
        void this.close();
        return;
      }
      const pending = this.#pending.get(requestId);
      if (pending === undefined) {
        void this.close();
        return;
      }
      this.#pending.delete(requestId);
      pending.signal?.removeEventListener("abort", pending.abort ?? (() => undefined));
      pending.resolve({
        ...(record as unknown as Omit<LinuxNativeHelperWireResponse, "wireBytes">),
        wireBytes: frame.byteLength,
      });
    }
  }
}

function validateResponseEnvelope(
  response: LinuxNativeHelperWireResponse,
  request: LinuxNativeHelperWireRequest,
  session: LinuxAuthenticatedHelperSession,
): void {
  if (
    response.protocolVersion !== PROTOCOL_VERSION ||
    response.requestId !== request.requestId ||
    response.sequence !== request.sequence ||
    !Number.isSafeInteger(response.wireBytes) ||
    response.wireBytes <= 0 ||
    response.wireBytes > MAX_FRAME_BYTES ||
    response.binding.authentication !== session.authentication ||
    response.binding.helperInstanceId !== session.helperInstanceId ||
    response.binding.osSessionIdentity !== session.osSessionIdentity ||
    response.binding.releaseVersion !== session.releaseVersion ||
    response.binding.serviceEpoch !== session.serviceEpoch ||
    typeof response.ok !== "boolean" ||
    (response.ok && response.error !== undefined) ||
    (!response.ok && (response.error === undefined || response.result !== undefined))
  ) {
    throw new Error("Native response envelope mismatch.");
  }
}

function validateAuthenticatedSession(
  session: LinuxAuthenticatedHelperSession,
): LinuxAuthenticatedHelperSession {
  if (session.authentication !== "adr-0011-ed25519-v2") {
    throw nativeFailure("UNAVAILABLE", "The session helper is not mutually authenticated.");
  }
  requireIdentifier(session.helperInstanceId, "helper instance ID");
  requireIdentifier(session.osSessionIdentity, "OS session identity");
  requireIdentifier(session.releaseVersion, "release version");
  if (!Number.isSafeInteger(session.serviceEpoch) || session.serviceEpoch <= 0) {
    throw nativeFailure("UNAVAILABLE", "The helper service epoch is invalid.");
  }
  return Object.freeze({ ...session });
}

function validateDesktopEnvironment(
  input: Readonly<Record<string, string | undefined>>,
): LinuxNativeHelperDesktopEnvironment {
  const sessionType = input["XDG_SESSION_TYPE"];
  const desktop = input["XDG_CURRENT_DESKTOP"];
  if (
    sessionType !== "wayland" ||
    typeof desktop !== "string" ||
    !desktop
      .split(":")
      .map((part) => part.toLowerCase())
      .includes("gnome")
  ) {
    throw nativeFailure(
      "UNAVAILABLE",
      "Computer Use requires the declared GNOME Wayland graphical session.",
    );
  }
  const runtimeDirectory = validateAbsolutePath(
    requireEnvironmentValue(input["XDG_RUNTIME_DIR"], "XDG_RUNTIME_DIR"),
    "XDG runtime directory",
  );
  const bus = requireEnvironmentValue(
    input["DBUS_SESSION_BUS_ADDRESS"],
    "DBUS_SESSION_BUS_ADDRESS",
  );
  if (!bus.startsWith("unix:") || bus.includes("\n") || bus.includes("\r")) {
    throw nativeFailure("UNAVAILABLE", "The graphical session bus address is invalid.");
  }
  const waylandDisplay = requireEnvironmentValue(input["WAYLAND_DISPLAY"], "WAYLAND_DISPLAY");
  if (
    waylandDisplay.includes("/") ||
    waylandDisplay.includes("\\") ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(waylandDisplay)
  ) {
    throw nativeFailure("UNAVAILABLE", "The Wayland display identity is invalid.");
  }
  return Object.freeze({
    DBUS_SESSION_BUS_ADDRESS: bus,
    WAYLAND_DISPLAY: waylandDisplay,
    XDG_CURRENT_DESKTOP: desktop,
    XDG_RUNTIME_DIR: runtimeDirectory,
    XDG_SESSION_TYPE: "wayland" as const,
  });
}

function requireEnvironmentValue(value: string | undefined, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\0")
  ) {
    throw nativeFailure("UNAVAILABLE", `The ${name} desktop binding is unavailable.`);
  }
  return value;
}

function wireExecutionContext(context: NativeDriverExecutionContext): LinuxWireExecutionContext {
  return {
    executionHandleId: context.executionHandleId,
    taskId: context.taskId,
    deviceId: context.deviceId,
    runId: context.runId,
    helperInstanceId: context.helperInstanceId,
    serviceEpoch: context.serviceEpoch,
    persistenceGeneration: context.persistenceGeneration,
    leaseId: context.leaseId,
    fencingToken: context.fencingToken,
    expectedDisplayFingerprint: context.expectedDisplayFingerprint,
  };
}

function validateNativeErrorCode(value: unknown): NativeDriverErrorCode | undefined {
  if (
    value === "CANCELLED" ||
    value === "DISPLAY_CHANGED" ||
    value === "EMERGENCY_STOPPED" ||
    value === "HELPER_CRASHED" ||
    value === "PERMISSION_DENIED" ||
    value === "SESSION_LOCKED" ||
    value === "TIMEOUT" ||
    value === "UNAVAILABLE"
  ) {
    return value;
  }
  return undefined;
}

function parseProbe(value: unknown): NativeDriverProbe {
  const result = readRecord(value, "probe result");
  requireExactKeys(result, [
    "osFamily",
    "backendId",
    "helperInstanceId",
    "serviceEpoch",
    "displayFingerprint",
    "linuxTarget",
    "checks",
  ]);
  const rawChecks = readArray(result["checks"], "readiness checks", 32);
  const seen = new Set<ReadinessCheckName>();
  const checks = rawChecks.map((check, index) => {
    const parsed = parseReadinessCheck(check, index);
    if (seen.has(parsed.name)) {
      throw nativeFailure("HELPER_CRASHED", "The readiness checks contain a duplicate.");
    }
    seen.add(parsed.name);
    return parsed;
  });
  if (
    seen.size !== READINESS_CHECK_NAMES.size ||
    [...READINESS_CHECK_NAMES].some((name) => !seen.has(name))
  ) {
    throw nativeFailure("HELPER_CRASHED", "The Linux readiness result is incomplete.");
  }
  return {
    osFamily: readLiteral(result["osFamily"], "linux", "probe OS family"),
    backendId: readLiteral(result["backendId"], LINUX_NATIVE_BACKEND_ID, "probe backend ID"),
    helperInstanceId: readIdentifier(result["helperInstanceId"], "probe helper instance ID"),
    serviceEpoch: readPositiveInteger(result["serviceEpoch"], "probe service epoch"),
    displayFingerprint: readNullableIdentifier(
      result["displayFingerprint"],
      "probe display fingerprint",
    ),
    linuxTarget: readLiteral(
      result["linuxTarget"],
      SUPPORTED_GRAPHICAL_LINUX_TARGET,
      "graphical Linux target",
    ),
    checks,
  };
}

function parseReadinessCheck(value: unknown, index: number): ReadinessCheck {
  const result = readRecord(value, `readiness check ${index}`);
  requireExactKeys(result, ["name", "status", "evidence"], ["remediation"]);
  const name = readString(result["name"], "readiness check name") as ReadinessCheckName;
  if (!READINESS_CHECK_NAMES.has(name)) {
    throw nativeFailure("HELPER_CRASHED", "The readiness check name is invalid.");
  }
  const remediation =
    result["remediation"] === undefined
      ? undefined
      : readBoundedText(result["remediation"], "readiness remediation", MAX_EVIDENCE_BYTES);
  return {
    name,
    status: readOneOf(
      result["status"],
      ["fail", "pass", "unknown"] as const,
      "readiness check status",
    ),
    evidence: readBoundedText(result["evidence"], "readiness evidence", MAX_EVIDENCE_BYTES),
    ...(remediation === undefined ? {} : { remediation }),
  };
}

function parseObservation(value: unknown): NativeObservation {
  const result = readRecord(value, "observation result");
  requireExactKeys(result, ["displayFingerprint", "accessibilityTree"], ["fixture"]);
  const accessibilityTree = readArray(
    result["accessibilityTree"],
    "accessibility tree",
    MAX_ACCESSIBILITY_CONTROLS,
  ).map((control, index) => {
    const record = readRecord(control, `accessibility control ${index}`);
    requireExactKeys(record, ["controlId", "role", "label"], ["value", "selected"]);
    const controlValue =
      record["value"] === undefined
        ? undefined
        : readBoundedText(record["value"], "accessibility value", MAX_CONTROL_VALUE_BYTES, true);
    const selected =
      record["selected"] === undefined
        ? undefined
        : readBoolean(record["selected"], "accessibility selection");
    return {
      controlId: readIdentifier(record["controlId"], "accessibility control ID"),
      role: readOneOf(
        record["role"],
        ["button", "radio", "textbox"] as const,
        "accessibility role",
      ),
      label: readIdentifier(record["label"], "accessibility label"),
      ...(controlValue === undefined ? {} : { value: controlValue }),
      ...(selected === undefined ? {} : { selected }),
    };
  });
  const fixture =
    result["fixture"] === undefined ? undefined : parseFixtureObservation(result["fixture"]);
  return {
    displayFingerprint: readIdentifier(
      result["displayFingerprint"],
      "observation display fingerprint",
    ),
    accessibilityTree,
    ...(fixture === undefined ? {} : { fixture }),
  };
}

function parseFixtureObservation(value: unknown): NonNullable<NativeObservation["fixture"]> {
  const result = readRecord(value, "fixture observation");
  requireExactKeys(result, ["runIdentifier", "state", "textValue", "selectedOption", "resultFile"]);
  return {
    runIdentifier: readIdentifier(result["runIdentifier"], "fixture run identifier"),
    state: readOneOf(result["state"], ["editing", "success"] as const, "fixture state"),
    textValue: readBoundedText(
      result["textValue"],
      "fixture text value",
      MAX_CONTROL_VALUE_BYTES,
      true,
    ),
    selectedOption:
      result["selectedOption"] === null
        ? null
        : readOneOf(result["selectedOption"], ["Alpha", "Beta"] as const, "fixture selection"),
    resultFile:
      result["resultFile"] === null
        ? null
        : (() => {
            const file = readRecord(result["resultFile"], "fixture result file");
            requireExactKeys(file, ["filename", "mediaType", "bytesBase64"]);
            return {
              filename: readIdentifier(file["filename"], "fixture result filename"),
              mediaType: readLiteral(
                file["mediaType"],
                "application/json",
                "fixture result media type",
              ),
              bytes: readBase64(
                file["bytesBase64"],
                "fixture result bytes",
                MAX_FIXTURE_RESULT_BYTES,
              ),
            };
          })(),
  };
}

function parseCapture(value: unknown): NativeCapture {
  const result = readRecord(value, "capture result");
  requireExactKeys(result, ["displayFingerprint", "mediaType", "width", "height", "bytesBase64"]);
  return {
    displayFingerprint: readIdentifier(result["displayFingerprint"], "capture fingerprint"),
    mediaType: readLiteral(result["mediaType"], "image/png", "capture media type"),
    width: readPositiveInteger(result["width"], "capture width"),
    height: readPositiveInteger(result["height"], "capture height"),
    bytes: readBase64(result["bytesBase64"], "capture bytes", MAX_FRAME_BYTES),
  };
}

function parseActionReceipt(value: unknown): NativeActionReceipt {
  const result = readRecord(value, "action receipt");
  requireExactKeys(result, ["displayFingerprint", "sequence"]);
  return {
    displayFingerprint: readIdentifier(result["displayFingerprint"], "action fingerprint"),
    sequence: readPositiveInteger(result["sequence"], "action sequence"),
  };
}

function parseStopReceipt(value: unknown): void {
  const result = readRecord(value, "stop receipt");
  requireExactKeys(result, ["stopped"]);
  if (readBoolean(result["stopped"], "stop acknowledgement") !== true) {
    throw nativeFailure("HELPER_CRASHED", "The native stop was not acknowledged.");
  }
}

function readRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw nativeFailure("HELPER_CRASHED", `The ${name} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw nativeFailure("HELPER_CRASHED", "The native result shape is invalid.");
  }
}

function readArray(value: unknown, name: string, maximumLength: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximumLength) {
    throw nativeFailure("HELPER_CRASHED", `The ${name} is invalid.`);
  }
  return value;
}

function readString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw nativeFailure("HELPER_CRASHED", `The ${name} is invalid.`);
  }
  return value;
}

function readIdentifier(value: unknown, name: string): string {
  const result = readString(value, name);
  requireIdentifier(result, name);
  return result;
}

function readNullableIdentifier(value: unknown, name: string): string | null {
  return value === null ? null : readIdentifier(value, name);
}

function readBoundedText(
  value: unknown,
  name: string,
  maximumBytes: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    value.includes("\0")
  ) {
    throw nativeFailure("HELPER_CRASHED", `The ${name} is invalid.`);
  }
  return value;
}

function readBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw nativeFailure("HELPER_CRASHED", `The ${name} is invalid.`);
  }
  return value;
}

function readOneOf<const T extends readonly string[]>(
  value: unknown,
  values: T,
  name: string,
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw nativeFailure("HELPER_CRASHED", `The ${name} is invalid.`);
  }
  return value as T[number];
}

function readBase64(value: unknown, name: string, maximumBytes: number): Uint8Array {
  const encoded = readString(value, name);
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > maximumBytes ||
    bytes.toString("base64") !== encoded
  ) {
    throw nativeFailure("HELPER_CRASHED", `The ${name} is invalid.`);
  }
  return bytes;
}

function readPositiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw nativeFailure("HELPER_CRASHED", `The ${name} is invalid.`);
  }
  return value as number;
}

function readLiteral<T extends string>(value: unknown, literal: T, name: string): T {
  if (value !== literal) {
    throw nativeFailure("HELPER_CRASHED", `The ${name} is invalid.`);
  }
  return literal;
}

function validateRequestId(value: string): string {
  requireIdentifier(value, "native request ID");
  return value;
}

function requireIdentifier(value: string, name: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > MAX_IDENTIFIER_BYTES ||
    Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    })
  ) {
    throw nativeFailure("UNAVAILABLE", `The ${name} is invalid.`);
  }
}

function validateAbsolutePath(value: string, name: string): string {
  if (
    typeof value !== "string" ||
    !posix.isAbsolute(value) ||
    value !== value.trim() ||
    value.includes("\0") ||
    posix.normalize(value) !== value
  ) {
    throw nativeFailure("UNAVAILABLE", `The ${name} path is invalid.`);
  }
  return value;
}

function nativeFailure(code: NativeDriverErrorCode, message: string): NativeDriverError {
  return new NativeDriverError(code, message);
}

function nativeMessage(code: NativeDriverErrorCode): string {
  switch (code) {
    case "CANCELLED":
      return "The Linux native operation was cancelled.";
    case "DISPLAY_CHANGED":
      return "The GNOME portal display stream changed.";
    case "EMERGENCY_STOPPED":
      return "The Linux native helper emergency stop is active.";
    case "HELPER_CRASHED":
      return "The Linux native helper is unavailable.";
    case "PERMISSION_DENIED":
      return "The Linux portal or AT-SPI permission is unavailable.";
    case "SESSION_LOCKED":
      return "The active GNOME Wayland session is not safely unlocked.";
    case "TIMEOUT":
      return "The Linux native operation timed out.";
    case "UNAVAILABLE":
      return "The Linux native capability is unavailable.";
  }
}
