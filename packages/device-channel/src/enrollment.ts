import { request as httpsRequest } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TLSSocket } from "node:tls";

import {
  DeviceIdentityError,
  type DeviceDiscoveryBootstrap,
  type DeviceIdentityAuthority,
  type IssuedDeviceIdentity,
  type VerifiedIssuedDeviceIdentity,
  type WorkerDeviceIdentity,
} from "@opendelegate/device-identity";

import {
  parseEnrollmentGrantFile,
  type EnrollmentChannelEndpoint,
  type EnrollmentGrantFileDocument,
} from "./enrollment-grant-file.ts";

const MAXIMUM_ENROLLMENT_BODY_BYTES = 256 * 1024;
const ENROLLMENT_PATH = "/api/v1/device/enroll";

export interface EnrollWorkerDeviceOptions {
  readonly clock?: { now(): number };
  readonly discovery: DeviceDiscoveryBootstrap;
  readonly grant: EnrollmentGrantFileDocument;
  readonly identity: Pick<
    WorkerDeviceIdentity,
    "createEnrollmentRequest" | "verifyIssuedDeviceIdentity" | "verifyMainIdentity"
  >;
  readonly requestTimeoutMs?: number;
}

export interface EnrolledWorkerIdentity extends VerifiedIssuedDeviceIdentity {
  readonly mainDeviceId: string;
  readonly channelEndpoints: readonly EnrollmentChannelEndpoint[];
}

export type EnrollmentClientErrorCode =
  | "ENROLLMENT_CONFIGURATION_INVALID"
  | "ENROLLMENT_REJECTED"
  | "ENROLLMENT_RESPONSE_INVALID"
  | "ENROLLMENT_UNAVAILABLE";

export class EnrollmentClientError extends Error {
  public readonly code: EnrollmentClientErrorCode;

  public constructor(code: EnrollmentClientErrorCode, message: string) {
    super(message);
    this.name = "EnrollmentClientError";
    this.code = code;
  }
}

export interface CreateEnrollmentRequestHandlerOptions {
  readonly authority: Pick<DeviceIdentityAuthority, "enrollDevice">;
}

export async function enrollWorkerDevice(
  options: EnrollWorkerDeviceOptions,
): Promise<EnrolledWorkerIdentity> {
  const clock = options.clock ?? { now: () => Date.now() };
  const grant = validateGrant(options.grant, clock);
  const requestTimeoutMs = validateRequestTimeout(options.requestTimeoutMs ?? 30_000);
  const discovery = validateDiscovery(options.discovery);
  try {
    await options.identity.verifyMainIdentity({
      certificatePem: grant.certificateAuthorityPem,
      expectedSpkiSha256: grant.expectedMainSpkiSha256,
    });
  } catch {
    throw clientError(
      "ENROLLMENT_CONFIGURATION_INVALID",
      "The Enrollment Grant Main identity could not be verified.",
    );
  }
  const certificateRequest = await options.identity.createEnrollmentRequest({
    deviceId: grant.deviceId,
    expectedMainSpkiSha256: grant.expectedMainSpkiSha256,
  });
  const requestBody = Buffer.from(
    JSON.stringify({
      grantId: grant.grantId,
      token: grant.token,
      deviceId: grant.deviceId,
      protocolVersion: 1,
      certificateRequestPem: certificateRequest.certificateRequestPem,
      discovery,
    }),
    "utf8",
  );
  let issued: IssuedDeviceIdentity;
  try {
    issued = await postEnrollment({
      body: requestBody,
      certificateAuthorityPem: grant.certificateAuthorityPem,
      requestTimeoutMs,
      url: grant.enrollmentUrl,
    });
  } finally {
    requestBody.fill(0);
  }
  let verified: VerifiedIssuedDeviceIdentity;
  try {
    verified = await options.identity.verifyIssuedDeviceIdentity({
      certificateAuthorityPem: issued.certificateAuthorityPem,
      certificatePem: issued.certificatePem,
      certificateRequestPem: certificateRequest.certificateRequestPem,
      deviceId: issued.deviceId,
      expectedMainSpkiSha256: grant.expectedMainSpkiSha256,
      generation: issued.generation,
      keyId: certificateRequest.keyId,
    });
  } catch {
    throw clientError(
      "ENROLLMENT_RESPONSE_INVALID",
      "Main returned an invalid Device identity response.",
    );
  }
  if (
    issued.deviceId !== grant.deviceId ||
    issued.status !== "active" ||
    issued.generation !== verified.generation ||
    issued.serialNumber !== verified.serialNumber
  ) {
    throw clientError(
      "ENROLLMENT_RESPONSE_INVALID",
      "Main returned an identity outside the Enrollment Grant scope.",
    );
  }
  return deepFreeze({
    ...verified,
    mainDeviceId: grant.mainDeviceId,
    channelEndpoints: grant.channelEndpoints.map((endpoint) => ({ ...endpoint })),
  });
}

export function createEnrollmentRequestHandler(
  options: CreateEnrollmentRequestHandlerOptions,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    void handleEnrollmentRequest(request, response, options.authority).catch(() => {
      if (!response.headersSent) {
        sendJson(response, 500, { code: "ENROLLMENT_UNAVAILABLE" });
      } else {
        response.destroy();
      }
    });
  };
}

async function handleEnrollmentRequest(
  request: IncomingMessage,
  response: ServerResponse,
  authority: Pick<DeviceIdentityAuthority, "enrollDevice">,
): Promise<void> {
  if (request.method !== "POST" || request.url !== ENROLLMENT_PATH) {
    sendJson(response, 404, { code: "NOT_FOUND" });
    return;
  }
  if (!isJsonContentType(request.headers["content-type"])) {
    sendJson(response, 415, { code: "CONTENT_TYPE_REQUIRED" });
    return;
  }
  const declaredLength = readDeclaredLength(request.headers["content-length"]);
  if (declaredLength !== undefined && declaredLength > MAXIMUM_ENROLLMENT_BODY_BYTES) {
    request.resume();
    sendJson(response, 413, { code: "ENROLLMENT_REQUEST_TOO_LARGE" });
    return;
  }
  let bytes: Buffer;
  try {
    bytes = await readBoundedBody(request);
  } catch {
    sendJson(response, 413, { code: "ENROLLMENT_REQUEST_TOO_LARGE" });
    return;
  }
  let enrollment;
  try {
    enrollment = parseEnrollmentRequest(bytes);
  } catch {
    bytes.fill(0);
    sendJson(response, 400, { code: "ENROLLMENT_REQUEST_INVALID" });
    return;
  }
  bytes.fill(0);
  try {
    const issued = await authority.enrollDevice(enrollment);
    sendJson(response, 201, issued);
  } catch (error) {
    const code =
      error instanceof DeviceIdentityError && error.code === "ENROLLMENT_GRANT_INVALID"
        ? "ENROLLMENT_REJECTED"
        : "ENROLLMENT_REQUEST_INVALID";
    sendJson(response, 409, { code });
  }
}

async function postEnrollment(input: {
  readonly body: Buffer;
  readonly certificateAuthorityPem: string;
  readonly requestTimeoutMs: number;
  readonly url: string;
}): Promise<IssuedDeviceIdentity> {
  const url = new URL(input.url);
  return new Promise<IssuedDeviceIdentity>((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: "POST",
        ca: input.certificateAuthorityPem,
        minVersion: "TLSv1.3",
        maxVersion: "TLSv1.3",
        rejectUnauthorized: true,
        headers: {
          accept: "application/json",
          "content-length": String(input.body.byteLength),
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(input.requestTimeoutMs),
      },
      (response) => {
        void readEnrollmentResponse(response).then(resolve, reject);
      },
    );
    request.once("socket", (socket) => {
      socket.once("secureConnect", () => {
        const tlsSocket = socket as TLSSocket;
        if (!tlsSocket.authorized || tlsSocket.getProtocol() !== "TLSv1.3") {
          request.destroy(
            clientError(
              "ENROLLMENT_UNAVAILABLE",
              "The pinned TLS 1.3 enrollment channel could not be authenticated.",
            ),
          );
        }
      });
    });
    request.once("error", () => {
      reject(
        clientError(
          "ENROLLMENT_UNAVAILABLE",
          "The pinned TLS 1.3 enrollment endpoint is unavailable.",
        ),
      );
    });
    request.end(input.body);
  });
}

async function readEnrollmentResponse(response: IncomingMessage): Promise<IssuedDeviceIdentity> {
  const bytes = await readBoundedBody(response);
  try {
    if (response.statusCode !== 201) {
      throw clientError("ENROLLMENT_REJECTED", "Main rejected the Enrollment Grant.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw clientError(
        "ENROLLMENT_RESPONSE_INVALID",
        "Main returned an invalid enrollment response.",
      );
    }
    return parseIssuedIdentity(parsed);
  } finally {
    bytes.fill(0);
  }
}

function parseIssuedIdentity(input: unknown): IssuedDeviceIdentity {
  const record = readRecord(input);
  assertExactKeys(record, [
    "deviceId",
    "certificatePem",
    "certificateAuthorityPem",
    "serialNumber",
    "publicKeySpkiSha256",
    "generation",
    "status",
    "issuedAt",
    "notBefore",
    "notAfter",
  ]);
  if (
    record["status"] !== "active" ||
    typeof record["deviceId"] !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(record["deviceId"]) ||
    typeof record["certificatePem"] !== "string" ||
    typeof record["certificateAuthorityPem"] !== "string" ||
    typeof record["serialNumber"] !== "string" ||
    !/^[0-9a-f]{32}$/u.test(record["serialNumber"]) ||
    typeof record["publicKeySpkiSha256"] !== "string" ||
    !/^sha256:[A-Za-z0-9_-]{43}$/u.test(record["publicKeySpkiSha256"])
  ) {
    throw clientError(
      "ENROLLMENT_RESPONSE_INVALID",
      "Main returned an invalid Device identity response.",
    );
  }
  const generation = readPositiveInteger(record["generation"]);
  const issuedAt = readTimestamp(record["issuedAt"]);
  const notBefore = readSignedTimestamp(record["notBefore"]);
  const notAfter = readTimestamp(record["notAfter"]);
  if (notBefore > issuedAt || notAfter <= issuedAt) {
    throw clientError(
      "ENROLLMENT_RESPONSE_INVALID",
      "Main returned inconsistent certificate validity.",
    );
  }
  return {
    deviceId: record["deviceId"],
    certificatePem: readPublicCertificate(record["certificatePem"]),
    certificateAuthorityPem: readPublicCertificate(record["certificateAuthorityPem"]),
    serialNumber: record["serialNumber"],
    publicKeySpkiSha256: record["publicKeySpkiSha256"],
    generation,
    status: "active",
    issuedAt,
    notBefore,
    notAfter,
  };
}

function parseEnrollmentRequest(bytes: Buffer) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("invalid");
  }
  const record = readRecord(parsed);
  assertExactKeys(record, [
    "grantId",
    "token",
    "deviceId",
    "protocolVersion",
    "certificateRequestPem",
    "discovery",
  ]);
  if (
    typeof record["grantId"] !== "string" ||
    !/^grant_[A-Za-z0-9_-]{22}$/u.test(record["grantId"]) ||
    typeof record["token"] !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(record["token"]) ||
    typeof record["deviceId"] !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(record["deviceId"]) ||
    record["protocolVersion"] !== 1 ||
    typeof record["certificateRequestPem"] !== "string" ||
    Buffer.byteLength(record["certificateRequestPem"], "utf8") > 65_536 ||
    !record["certificateRequestPem"].startsWith("-----BEGIN CERTIFICATE REQUEST-----")
  ) {
    throw new Error("invalid");
  }
  return {
    grantId: record["grantId"],
    token: record["token"],
    deviceId: record["deviceId"],
    protocolVersion: 1,
    certificateRequestPem: record["certificateRequestPem"],
    discovery: validateDiscovery(record["discovery"]),
  };
}

function validateGrant(
  input: EnrollmentGrantFileDocument,
  clock: { now(): number },
): EnrollmentGrantFileDocument {
  let now: number;
  try {
    now = clock.now();
  } catch {
    throw clientError("ENROLLMENT_CONFIGURATION_INVALID", "The enrollment clock is invalid.");
  }
  let encoded: Buffer | undefined;
  try {
    encoded = Buffer.from(JSON.stringify(input), "utf8");
    return parseEnrollmentGrantFile(encoded, now);
  } catch (error) {
    if (error instanceof EnrollmentClientError) {
      throw error;
    }
    throw clientError(
      "ENROLLMENT_CONFIGURATION_INVALID",
      "The Enrollment Grant configuration is invalid.",
    );
  } finally {
    encoded?.fill(0);
  }
}

function validateDiscovery(input: unknown): DeviceDiscoveryBootstrap {
  const record = readRecord(input);
  assertExactKeys(record, ["osFamily", "architecture", "hostname"]);
  if (
    record["osFamily"] !== "macos" &&
    record["osFamily"] !== "windows" &&
    record["osFamily"] !== "linux"
  ) {
    throw new Error("invalid");
  }
  return {
    osFamily: record["osFamily"],
    architecture: readBoundedText(record["architecture"]),
    hostname: readBoundedText(record["hostname"]),
  };
}

function validateRequestTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 120_000) {
    throw clientError(
      "ENROLLMENT_CONFIGURATION_INVALID",
      "The enrollment request timeout is invalid.",
    );
  }
  return value;
}

async function readBoundedBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > MAXIMUM_ENROLLMENT_BODY_BYTES) {
      for (const existing of chunks) {
        existing.fill(0);
      }
      throw new Error("too large");
    }
    chunks.push(Buffer.from(bytes));
  }
  return Buffer.concat(chunks, length);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": String(body.byteLength),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function readDeclaredLength(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^(?:0|[1-9]\d{0,9})$/u.test(value)) {
    return MAXIMUM_ENROLLMENT_BODY_BYTES + 1;
  }
  return Number(value);
}

function isJsonContentType(value: string | undefined): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function readRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid");
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  if (
    keys.some((key) => !Object.prototype.hasOwnProperty.call(record, key)) ||
    Object.keys(record).some((key) => !allowed.has(key))
  ) {
    throw new Error("invalid");
  }
}

function readPublicCertificate(value: string): string {
  if (
    Buffer.byteLength(value, "utf8") > 65_536 ||
    !value.startsWith("-----BEGIN CERTIFICATE-----\n") ||
    !value.trimEnd().endsWith("-----END CERTIFICATE-----") ||
    value.includes("PRIVATE KEY")
  ) {
    throw clientError(
      "ENROLLMENT_RESPONSE_INVALID",
      "Main returned an invalid public certificate.",
    );
  }
  return value;
}

function readPositiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error("invalid");
  }
  return value as number;
}

function readTimestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 8.64e15) {
    throw new Error("invalid");
  }
  return value as number;
}

function readSignedTimestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < -8.64e15 || (value as number) > 8.64e15) {
    throw new Error("invalid");
  }
  return value as number;
}

function readBoundedText(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    value !== value.trim() ||
    hasControlCharacter(value)
  ) {
    throw new Error("invalid");
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point <= 31 || point === 127);
  });
}

function clientError(code: EnrollmentClientErrorCode, message: string): EnrollmentClientError {
  return new EnrollmentClientError(code, message);
}

function deepFreeze<TValue>(value: TValue): TValue {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}
