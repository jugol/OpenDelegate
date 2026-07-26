import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { posix } from "node:path";

import {
  NativeDriverError,
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
import type {
  MacOsAuthenticatedHelperSession,
  MacOsNativeHelperPort,
} from "./macos-native-driver.ts";

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 128 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_EVIDENCE_BYTES = 4 * 1024;
const MAX_ACCESSIBILITY_CONTROLS = 2_048;
const MAX_CONTROL_VALUE_BYTES = 4 * 1024;
const MAX_FIXTURE_RESULT_BYTES = 1024 * 1024;
const DEFAULT_CODESIGN_PATH = "/usr/bin/codesign";
const DEFAULT_VERIFY_TIMEOUT_MS = 30_000;
const FORCE_KILL_AFTER_MS = 1_000;
const MACOS_BACKEND_ID = "macos-ax-screencapturekit-cgevent";
const READINESS_CHECK_NAMES = new Set<ReadinessCheckName>([
  "interactive-session",
  "unlocked-session",
  "screen-capture",
  "accessibility",
  "input",
  "helper-authentication",
  "service-epoch",
]);

export type MacOsNativeHelperWireOperation =
  "act" | "cancel" | "capture" | "emergency-stop" | "observe" | "probe";

interface WireExecutionContext {
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

export interface MacOsNativeHelperWireRequest {
  readonly protocolVersion: 1;
  readonly requestId: string;
  readonly sequence: number;
  readonly binding: MacOsAuthenticatedHelperSession;
  readonly operation: MacOsNativeHelperWireOperation;
  readonly execution?: WireExecutionContext;
  readonly control?: NativeDriverControlContext;
  readonly action?: NativeComputerUseAction;
}

export interface MacOsNativeHelperWireResponse {
  readonly protocolVersion: 1;
  readonly requestId: string;
  readonly sequence: number;
  readonly binding: MacOsAuthenticatedHelperSession;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: {
    readonly code: NativeDriverErrorCode;
    readonly message?: string;
  };
  /**
   * Set by the private transport from the exact received bytes. The Swift child
   * does not control this accounting field.
   */
  readonly wireBytes: number;
}

export interface MacOsNativeHelperBinaryVerificationRequest {
  readonly executablePath: string;
  readonly expectedSha256: `sha256:${string}`;
  readonly requireSignedCode: true;
}

export interface MacOsNativeHelperBinaryVerifier {
  verify(request: MacOsNativeHelperBinaryVerificationRequest): Promise<void>;
}

export interface MacOsNativeHelperChildStartRequest {
  readonly executablePath: string;
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly exposeListener: false;
}

export interface MacOsNativeHelperChildTransport {
  request(
    request: MacOsNativeHelperWireRequest,
    signal?: AbortSignal,
  ): Promise<MacOsNativeHelperWireResponse>;
  close(): Promise<void>;
}

export interface MacOsNativeHelperChildTransportFactory {
  start(request: MacOsNativeHelperChildStartRequest): Promise<MacOsNativeHelperChildTransport>;
}

export interface MacOsNativeHelperRequestIdSource {
  nextRequestId(): string;
}

export interface StartMacOsNativeHelperChildProcessOptions {
  readonly authenticatedSession: MacOsAuthenticatedHelperSession;
  readonly executablePath: string;
  readonly expectedExecutableSha256: `sha256:${string}`;
  readonly hostPlatform?: NodeJS.Platform;
  readonly binaryVerifier?: MacOsNativeHelperBinaryVerifier;
  readonly transportFactory?: MacOsNativeHelperChildTransportFactory;
  readonly parentProcessId?: number;
  readonly fixtureResultDirectory?: string;
  readonly requestIdSource?: MacOsNativeHelperRequestIdSource;
}

/**
 * Starts a target-native Swift child inside an already authenticated session
 * helper. The child gets inherited anonymous pipes only; it never binds a named
 * pipe, Unix socket, TCP port, or other independently reachable endpoint.
 */
export async function startMacOsNativeHelperChildProcess(
  options: StartMacOsNativeHelperChildProcessOptions,
): Promise<MacOsNativeHelperChildProcessPort> {
  if ((options.hostPlatform ?? process.platform) !== "darwin") {
    throw nativeFailure("UNAVAILABLE", "The macOS native helper can run only on macOS.");
  }
  const session = validateAuthenticatedSession(options.authenticatedSession);
  const executablePath = validateAbsolutePath(options.executablePath, "native helper executable");
  if (!/^sha256:[0-9a-f]{64}$/u.test(options.expectedExecutableSha256)) {
    throw nativeFailure("UNAVAILABLE", "The macOS native helper digest is invalid.");
  }
  const parentProcessId = options.parentProcessId ?? process.pid;
  if (!Number.isSafeInteger(parentProcessId) || parentProcessId <= 0) {
    throw nativeFailure("UNAVAILABLE", "The macOS session-helper process identity is invalid.");
  }
  const fixtureResultDirectory =
    options.fixtureResultDirectory === undefined
      ? undefined
      : validateAbsolutePath(options.fixtureResultDirectory, "fixture result directory");
  const verifier = options.binaryVerifier ?? new NodeMacOsNativeHelperBinaryVerifier();
  try {
    await verifier.verify({
      executablePath,
      expectedSha256: options.expectedExecutableSha256,
      requireSignedCode: true,
    });
  } catch {
    throw nativeFailure(
      "UNAVAILABLE",
      "The signed macOS native helper failed integrity verification.",
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
  const factory = options.transportFactory ?? new NodeMacOsNativeHelperChildTransportFactory();
  let transport: MacOsNativeHelperChildTransport;
  try {
    transport = await factory.start({
      executablePath,
      arguments: arguments_,
      environment: Object.freeze({}),
      exposeListener: false,
    });
  } catch {
    throw nativeFailure("HELPER_CRASHED", "The macOS native helper child could not start.");
  }
  return new MacOsNativeHelperChildProcessPort({
    session,
    transport,
    requestIds: options.requestIdSource ?? { nextRequestId: () => randomUUID() },
  });
}

export class MacOsNativeHelperChildProcessPort implements MacOsNativeHelperPort {
  readonly #session: MacOsAuthenticatedHelperSession;
  readonly #transport: MacOsNativeHelperChildTransport;
  readonly #requestIds: MacOsNativeHelperRequestIdSource;
  #nextSequence = 1;
  #closed = false;

  public constructor(options: {
    readonly session: MacOsAuthenticatedHelperSession;
    readonly transport: MacOsNativeHelperChildTransport;
    readonly requestIds: MacOsNativeHelperRequestIdSource;
  }) {
    this.#session = options.session;
    this.#transport = options.transport;
    this.#requestIds = options.requestIds;
  }

  public currentSession(): MacOsAuthenticatedHelperSession {
    return this.#session;
  }

  public async probe(): Promise<NativeDriverProbe> {
    const response = await this.#request({ operation: "probe" });
    return this.#parseResult(response.result, parseProbe, "readiness result");
  }

  public async observe(context: NativeDriverExecutionContext): Promise<NativeObservation> {
    const response = await this.#request(
      { operation: "observe", execution: wireExecutionContext(context) },
      context.signal,
    );
    return this.#parseResult(response.result, parseObservation, "observation result");
  }

  public async capture(context: NativeDriverExecutionContext): Promise<NativeCapture> {
    const response = await this.#request(
      { operation: "capture", execution: wireExecutionContext(context) },
      context.signal,
    );
    return this.#parseResult(response.result, parseCapture, "capture result");
  }

  public async act(
    context: NativeDriverExecutionContext,
    action: NativeComputerUseAction,
  ): Promise<NativeActionReceipt> {
    const response = await this.#request(
      { operation: "act", execution: wireExecutionContext(context), action },
      context.signal,
    );
    return this.#parseResult(response.result, parseActionReceipt, "action receipt");
  }

  public async cancel(context: NativeDriverControlContext): Promise<void> {
    const response = await this.#request({ operation: "cancel", control: context });
    await this.#parseResult(response.result, parseStopReceipt, "cancellation receipt");
  }

  public async emergencyStop(context: NativeDriverControlContext): Promise<void> {
    const response = await this.#request({ operation: "emergency-stop", control: context });
    await this.#parseResult(response.result, parseStopReceipt, "emergency-stop receipt");
  }

  public async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.#transport.close().catch(() => undefined);
  }

  async #request(
    body:
      | { readonly operation: "probe" }
      | {
          readonly operation: "observe" | "capture";
          readonly execution: WireExecutionContext;
        }
      | {
          readonly operation: "act";
          readonly execution: WireExecutionContext;
          readonly action: NativeComputerUseAction;
        }
      | {
          readonly operation: "cancel" | "emergency-stop";
          readonly control: NativeDriverControlContext;
        },
    signal?: AbortSignal,
  ): Promise<MacOsNativeHelperWireResponse> {
    if (this.#closed) {
      throw nativeFailure("HELPER_CRASHED", "The macOS native helper child is closed.");
    }
    if (signal?.aborted === true) {
      await this.close();
      throw nativeFailure("CANCELLED", "The macOS native operation was cancelled.");
    }
    const sequence = this.#nextSequence;
    this.#nextSequence += 1;
    const requestId = this.#requestIds.nextRequestId();
    requireIdentifier(requestId, "native request ID");
    const request: MacOsNativeHelperWireRequest = {
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      sequence,
      binding: this.#session,
      ...body,
    };
    let response: MacOsNativeHelperWireResponse;
    try {
      response = await this.#transport.request(request, signal);
    } catch (error: unknown) {
      await this.close();
      if (error instanceof NativeDriverError && error.code === "CANCELLED") {
        throw nativeFailure("CANCELLED", "The macOS native operation was cancelled.");
      }
      throw nativeFailure("HELPER_CRASHED", "The macOS native helper stopped responding.");
    }
    try {
      validateResponseEnvelope(response, request, this.#session);
    } catch {
      throw await this.#failClosed("The macOS native helper response was invalid.");
    }
    if (!response.ok) {
      const code = validateNativeErrorCode(response.error?.code);
      if (code === undefined) {
        throw await this.#failClosed("The macOS native helper returned an invalid error code.");
      }
      throw nativeFailure(code, nativeMessage(code));
    }
    if (response.result === undefined) {
      throw await this.#failClosed("The macOS native helper omitted its result.");
    }
    return response;
  }

  async #failClosed(message: string): Promise<NativeDriverError> {
    await this.close();
    return nativeFailure("HELPER_CRASHED", message);
  }

  async #parseResult<T>(value: unknown, parse: (value: unknown) => T, name: string): Promise<T> {
    try {
      return parse(value);
    } catch {
      throw await this.#failClosed(`The macOS native helper ${name} was invalid.`);
    }
  }
}

export class NodeMacOsNativeHelperBinaryVerifier implements MacOsNativeHelperBinaryVerifier {
  readonly #codesignPath: string;
  readonly #timeoutMs: number;

  public constructor(
    options: { readonly codesignPath?: string; readonly timeoutMs?: number } = {},
  ) {
    this.#codesignPath = options.codesignPath ?? DEFAULT_CODESIGN_PATH;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  }

  public async verify(request: MacOsNativeHelperBinaryVerificationRequest): Promise<void> {
    const path = validateAbsolutePath(request.executablePath, "native helper executable");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer | undefined;
    try {
      const metadata = await handle.stat();
      const canonical = await realpath(path);
      const pathMetadata = await lstat(path);
      if (
        !metadata.isFile() ||
        metadata.nlink !== 1 ||
        metadata.uid !== 0 ||
        (metadata.mode & 0o022) !== 0 ||
        metadata.size <= 0 ||
        metadata.size > MAX_EXECUTABLE_BYTES ||
        (metadata.mode & 0o111) === 0 ||
        canonical !== path ||
        !pathMetadata.isFile() ||
        pathMetadata.isSymbolicLink() ||
        pathMetadata.dev !== metadata.dev ||
        pathMetadata.ino !== metadata.ino ||
        pathMetadata.size !== metadata.size ||
        pathMetadata.mtimeMs !== metadata.mtimeMs
      ) {
        throw new Error("Native helper file identity is invalid.");
      }
      await verifyImmutableParentDirectories(path);
      bytes = await handle.readFile();
      const { createHash } = await import("node:crypto");
      const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      if (digest !== request.expectedSha256) {
        throw new Error("Native helper digest mismatch.");
      }
      await runCodeSignVerify(this.#codesignPath, path, this.#timeoutMs);
      const after = await lstat(path);
      if (
        !after.isFile() ||
        after.isSymbolicLink() ||
        after.dev !== metadata.dev ||
        after.ino !== metadata.ino ||
        after.size !== metadata.size ||
        after.mtimeMs !== metadata.mtimeMs
      ) {
        throw new Error("Native helper file identity changed during verification.");
      }
    } finally {
      bytes?.fill(0);
      await handle.close();
    }
  }
}

async function verifyImmutableParentDirectories(path: string): Promise<void> {
  let current = posix.dirname(path);
  while (true) {
    const metadata = await lstat(current);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== 0 ||
      (metadata.mode & 0o022) !== 0
    ) {
      throw new Error("Native helper parent directory is mutable.");
    }
    if (current === "/") {
      return;
    }
    const parent = posix.dirname(current);
    if (parent === current) {
      throw new Error("Native helper path ancestry is invalid.");
    }
    current = parent;
  }
}

export class NodeMacOsNativeHelperChildTransportFactory implements MacOsNativeHelperChildTransportFactory {
  public async start(
    request: MacOsNativeHelperChildStartRequest,
  ): Promise<MacOsNativeHelperChildTransport> {
    if (request.exposeListener !== false || Object.keys(request.environment).length !== 0) {
      throw new Error("The native child boundary is invalid.");
    }
    const child = spawn(request.executablePath, [...request.arguments], {
      detached: false,
      env: {},
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    return new NodeMacOsNativeHelperChildTransport(child);
  }
}

class NodeMacOsNativeHelperChildTransport implements MacOsNativeHelperChildTransport {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<
    string,
    {
      readonly resolve: (response: MacOsNativeHelperWireResponse) => void;
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
    child.stdin.on("error", () => {
      void this.close();
    });
    child.stdout.on("data", (chunk: Buffer) => this.#consumeStdout(chunk));
    child.stdout.on("error", () => {
      void this.close();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.#stderrBytes += chunk.byteLength;
      if (this.#stderrBytes > MAX_STDERR_BYTES) {
        void this.close();
      }
    });
    child.stderr.on("error", () => {
      void this.close();
    });
    child.once("error", () => {
      void this.close();
    });
    child.once("exit", () => {
      void this.close();
    });
  }

  public request(
    request: MacOsNativeHelperWireRequest,
    signal?: AbortSignal,
  ): Promise<MacOsNativeHelperWireResponse> {
    if (this.#closed || signal?.aborted === true) {
      return Promise.reject(
        nativeFailure(
          signal?.aborted === true ? "CANCELLED" : "HELPER_CRASHED",
          "The macOS native helper child is unavailable.",
        ),
      );
    }
    const frame = Buffer.from(`${JSON.stringify(request)}\n`, "utf8");
    if (frame.byteLength > MAX_FRAME_BYTES) {
      return Promise.reject(nativeFailure("UNAVAILABLE", "The native request is too large."));
    }
    return new Promise((resolve, reject) => {
      const pending: {
        resolve: (response: MacOsNativeHelperWireResponse) => void;
        reject: (error: Error) => void;
        signal?: AbortSignal;
        abort?: () => void;
      } = { resolve, reject, ...(signal === undefined ? {} : { signal }) };
      if (this.#pending.has(request.requestId)) {
        reject(nativeFailure("HELPER_CRASHED", "The native request ID was reused."));
        void this.close();
        return;
      }
      if (signal !== undefined) {
        pending.abort = () => {
          this.#pending.delete(request.requestId);
          signal.removeEventListener("abort", pending.abort ?? (() => undefined));
          reject(nativeFailure("CANCELLED", "The macOS native operation was cancelled."));
          void this.close();
        };
        signal.addEventListener("abort", pending.abort, { once: true });
      }
      this.#pending.set(request.requestId, pending);
      this.#child.stdin.write(frame, (error) => {
        if (error !== null && error !== undefined) {
          this.#pending.delete(request.requestId);
          pending.signal?.removeEventListener("abort", pending.abort ?? (() => undefined));
          reject(nativeFailure("HELPER_CRASHED", "The macOS native helper pipe closed."));
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
    this.#rejectAll();
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
      let parsed: unknown;
      try {
        parsed = JSON.parse(frame.toString("utf8"));
      } catch {
        void this.close();
        return;
      }
      let record: Record<string, unknown>;
      let requestId: string;
      try {
        record = readRecord(parsed, "native helper response");
        requestId = readString(record["requestId"], "native response request ID");
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
        ...(record as unknown as Omit<MacOsNativeHelperWireResponse, "wireBytes">),
        wireBytes: frame.byteLength,
      });
    }
  }

  #rejectAll(): void {
    const error = nativeFailure("HELPER_CRASHED", "The macOS native helper child exited.");
    for (const pending of this.#pending.values()) {
      pending.signal?.removeEventListener("abort", pending.abort ?? (() => undefined));
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function validateResponseEnvelope(
  response: MacOsNativeHelperWireResponse,
  request: MacOsNativeHelperWireRequest,
  session: MacOsAuthenticatedHelperSession,
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
    typeof response.ok !== "boolean"
  ) {
    throw new Error("Native response envelope mismatch.");
  }
  if (response.ok && response.error !== undefined) {
    throw new Error("Successful native response included an error.");
  }
  if (!response.ok && (response.error === undefined || response.result !== undefined)) {
    throw new Error("Failed native response has an invalid shape.");
  }
}

function validateAuthenticatedSession(
  session: MacOsAuthenticatedHelperSession,
): MacOsAuthenticatedHelperSession {
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

function wireExecutionContext(context: NativeDriverExecutionContext): WireExecutionContext {
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
  return {
    osFamily: readLiteral(result["osFamily"], "macos", "probe OS family"),
    backendId: readLiteral(result["backendId"], MACOS_BACKEND_ID, "probe backend ID"),
    helperInstanceId: readIdentifier(result["helperInstanceId"], "probe helper instance ID"),
    serviceEpoch: readPositiveInteger(result["serviceEpoch"], "probe service epoch"),
    displayFingerprint: readNullableIdentifier(
      result["displayFingerprint"],
      "probe display fingerprint",
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
  const status = readOneOf(
    result["status"],
    ["fail", "pass", "unknown"] as const,
    "readiness check status",
  );
  const evidence = readBoundedText(result["evidence"], "readiness evidence", MAX_EVIDENCE_BYTES);
  const remediation =
    result["remediation"] === undefined
      ? undefined
      : readBoundedText(result["remediation"], "readiness remediation", MAX_EVIDENCE_BYTES);
  return {
    name,
    status,
    evidence,
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
  ).map((control, index) => parseAccessibilityControl(control, index));
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

function parseAccessibilityControl(
  value: unknown,
  index: number,
): NativeObservation["accessibilityTree"][number] {
  const result = readRecord(value, `accessibility control ${index}`);
  requireExactKeys(result, ["controlId", "role", "label"], ["value", "selected"]);
  const role = readOneOf(
    result["role"],
    ["button", "radio", "textbox"] as const,
    "accessibility role",
  );
  const controlValue =
    result["value"] === undefined
      ? undefined
      : readBoundedText(result["value"], "accessibility value", MAX_CONTROL_VALUE_BYTES, true);
  const selected =
    result["selected"] === undefined
      ? undefined
      : readBoolean(result["selected"], "accessibility selection");
  return {
    controlId: readIdentifier(result["controlId"], "accessibility control ID"),
    role,
    label: readIdentifier(result["label"], "accessibility label"),
    ...(controlValue === undefined ? {} : { value: controlValue }),
    ...(selected === undefined ? {} : { selected }),
  };
}

function parseFixtureObservation(value: unknown): NonNullable<NativeObservation["fixture"]> {
  const result = readRecord(value, "fixture observation");
  requireExactKeys(result, ["runIdentifier", "state", "textValue", "selectedOption", "resultFile"]);
  const selectedOption =
    result["selectedOption"] === null
      ? null
      : readOneOf(result["selectedOption"], ["Alpha", "Beta"] as const, "fixture selection");
  const resultFile =
    result["resultFile"] === null ? null : parseFixtureResultFile(result["resultFile"]);
  return {
    runIdentifier: readIdentifier(result["runIdentifier"], "fixture run identifier"),
    state: readOneOf(result["state"], ["editing", "success"] as const, "fixture state"),
    textValue: readBoundedText(
      result["textValue"],
      "fixture text value",
      MAX_CONTROL_VALUE_BYTES,
      true,
    ),
    selectedOption,
    resultFile,
  };
}

function parseFixtureResultFile(
  value: unknown,
): NonNullable<NonNullable<NativeObservation["fixture"]>["resultFile"]> {
  const result = readRecord(value, "fixture result file");
  requireExactKeys(result, ["filename", "mediaType", "bytesBase64"]);
  return {
    filename: readIdentifier(result["filename"], "fixture result filename"),
    mediaType: readLiteral(result["mediaType"], "application/json", "fixture result media type"),
    bytes: readBase64(result["bytesBase64"], "fixture result bytes", MAX_FIXTURE_RESULT_BYTES),
  };
}

function parseCapture(value: unknown): NativeCapture {
  const result = readRecord(value, "capture result");
  requireExactKeys(result, ["displayFingerprint", "mediaType", "width", "height", "bytesBase64"]);
  return {
    displayFingerprint: readIdentifier(result["displayFingerprint"], "capture display fingerprint"),
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
    displayFingerprint: readIdentifier(result["displayFingerprint"], "action display fingerprint"),
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

function requireIdentifier(value: string, name: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > MAX_IDENTIFIER_BYTES ||
    containsControlCharacter(value)
  ) {
    throw nativeFailure("UNAVAILABLE", `The ${name} is invalid.`);
  }
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
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

function runCodeSignVerify(path: string, executablePath: string, timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      path,
      ["--verify", "--strict", "--verbose=0", executablePath],
      {
        encoding: "utf8",
        env: {},
        maxBuffer: MAX_STDERR_BYTES,
        timeout: timeoutMs,
        windowsHide: true,
      },
      (error) => {
        if (error !== null) {
          rejectPromise(new Error("Native helper signature verification failed."));
          return;
        }
        resolvePromise();
      },
    );
  });
}

function nativeFailure(code: NativeDriverErrorCode, message: string): NativeDriverError {
  return new NativeDriverError(code, message);
}

function nativeMessage(code: NativeDriverErrorCode): string {
  switch (code) {
    case "CANCELLED":
      return "The macOS native operation was cancelled.";
    case "DISPLAY_CHANGED":
      return "The macOS display configuration changed.";
    case "EMERGENCY_STOPPED":
      return "The macOS native helper emergency stop is active.";
    case "HELPER_CRASHED":
      return "The macOS native helper is unavailable.";
    case "PERMISSION_DENIED":
      return "The macOS native helper lacks a required owner permission.";
    case "SESSION_LOCKED":
      return "The active macOS Aqua session is not safely unlocked.";
    case "TIMEOUT":
      return "The macOS native operation timed out.";
    case "UNAVAILABLE":
      return "The macOS native capability is unavailable.";
  }
}
