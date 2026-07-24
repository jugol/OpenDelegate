export type TransportEndpointKind = "https" | "wss";

export interface TransportEndpoint {
  readonly endpointId: string;
  readonly label: string;
  readonly kind: TransportEndpointKind;
  readonly url: string;
  readonly credentialRef: string;
}

export interface TransportProfile {
  readonly deviceId: string;
  readonly endpoints: readonly TransportEndpoint[];
}

export interface TransportBoundaryRequest {
  readonly deviceId: string;
  readonly endpoint: TransportEndpoint;
}

export interface TransportProbeResult {
  readonly healthy: boolean;
  readonly authenticated: boolean;
  readonly peerDeviceId?: string;
  readonly diagnostic?: unknown;
}

export interface TransportConnected<TConnection> {
  readonly connected: true;
  readonly authenticated: boolean;
  readonly peerDeviceId?: string;
  readonly connection: TConnection;
  readonly diagnostic?: unknown;
}

export interface TransportConnectionFailed {
  readonly connected: false;
  readonly authenticated?: boolean;
  readonly peerDeviceId?: string;
  readonly diagnostic?: unknown;
}

export type TransportConnectResult<TConnection> =
  TransportConnected<TConnection> | TransportConnectionFailed;

export interface TransportClock {
  now(): number;
}

export interface TransportResolverDependencies<TConnection> {
  readonly probeTtlMs: number;
  readonly clock: TransportClock;
  readonly probe: (request: TransportBoundaryRequest) => Promise<TransportProbeResult>;
  readonly connect: (
    request: TransportBoundaryRequest,
  ) => Promise<TransportConnectResult<TConnection>>;
}

export type RedactedDiagnostic =
  | boolean
  | number
  | string
  | null
  | readonly RedactedDiagnostic[]
  | { readonly [key: string]: RedactedDiagnostic };

export interface TransportAttemptTrace {
  readonly endpointId: string;
  readonly label: string;
  readonly kind: TransportEndpointKind;
  readonly probeSource: "cache" | "live" | "not-run";
  readonly outcome:
    | "authentication-rejected"
    | "connect-failed"
    | "connected"
    | "identity-rejected"
    | "probe-unhealthy"
    | "skipped-incompatible";
  readonly failureStage?: "connect" | "probe";
  readonly diagnostic?: RedactedDiagnostic;
}

export interface TransportResolution<TConnection> {
  readonly deviceId: string;
  readonly endpointId: string;
  readonly kind: TransportEndpointKind;
  readonly connection: TConnection;
  readonly attemptTrace: readonly TransportAttemptTrace[];
}

export interface TransportExhaustionDiagnostics {
  readonly deviceId: string;
  readonly attempts: readonly TransportAttemptTrace[];
}

export class TransportRoutesExhaustedError extends Error {
  public readonly code = "TRANSPORT_ROUTES_EXHAUSTED" as const;
  public readonly deviceId: string;
  public readonly agentEscalationRecommended = true as const;
  public readonly diagnostics: TransportExhaustionDiagnostics;

  public constructor(deviceId: string, attempts: readonly TransportAttemptTrace[]) {
    super(`All configured transport routes failed for Device ${deviceId}.`);
    this.name = "TransportRoutesExhaustedError";
    this.deviceId = deviceId;
    this.diagnostics = Object.freeze({
      deviceId,
      attempts: freezeAttemptTrace(attempts),
    });
  }
}

const SAFE_DIAGNOSTIC_FIELDS = ["code", "retryable", "status"] as const;

type SafeDiagnosticField = (typeof SAFE_DIAGNOSTIC_FIELDS)[number];

const GENERIC_BOUNDARY_ERROR_CODE = "TRANSPORT_BOUNDARY_ERROR";
const SAFE_DIAGNOSTIC_CODES = new Set([
  GENERIC_BOUNDARY_ERROR_CODE,
  "CERTIFICATE_EXPIRED",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "TLS_HANDSHAKE_FAILED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

function redactDiagnosticString(value: string): string {
  return value
    .replace(/\b((?:https?|wss):\/\/)[^/\s@]+@/gi, "$1[REDACTED]@")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bBasic\s+[A-Za-z0-9+/=-]+/gi, "Basic [REDACTED]")
    .replace(/\b(token|password|secret|api[_-]?key)=([^&\s]+)/gi, "$1=[REDACTED]");
}

function redactDiagnostic(value: unknown): RedactedDiagnostic {
  if (value instanceof Error || value === null || typeof value !== "object") {
    return Object.freeze({
      code: GENERIC_BOUNDARY_ERROR_CODE,
    });
  }

  if (Array.isArray(value)) {
    return Object.freeze({
      code: GENERIC_BOUNDARY_ERROR_CODE,
    });
  }

  const source = value as Record<string, unknown>;
  const redacted: Record<string, RedactedDiagnostic> = {};
  for (const key of SAFE_DIAGNOSTIC_FIELDS) {
    const safeValue = readSafeDiagnosticField(source, key);
    if (safeValue !== undefined) {
      redacted[key] = safeValue;
    }
  }

  if (Object.keys(redacted).length === 0) {
    redacted.code = GENERIC_BOUNDARY_ERROR_CODE;
  }

  return Object.freeze(redacted);
}

function readSafeDiagnosticField(
  source: Record<string, unknown>,
  key: SafeDiagnosticField,
): RedactedDiagnostic | undefined {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(source, key);
  } catch {
    return undefined;
  }

  if (descriptor === undefined || !("value" in descriptor)) {
    return undefined;
  }

  const value: unknown = descriptor.value;
  switch (key) {
    case "code":
      return typeof value === "string" && SAFE_DIAGNOSTIC_CODES.has(value) ? value : undefined;
    case "retryable":
      return typeof value === "boolean" ? value : undefined;
    case "status":
      return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
        ? value
        : undefined;
  }
}

export interface TransportResolver<TConnection> {
  connect(
    profile: TransportProfile,
    options?: TransportResolutionOptions,
  ): Promise<TransportResolution<TConnection>>;
}

export interface TransportResolutionOptions {
  readonly acceptedKinds?: readonly TransportEndpointKind[];
}

export type TransportConfigurationErrorCode =
  "TRANSPORT_CLOCK_INVALID" | "TRANSPORT_PROBE_TTL_INVALID" | "TRANSPORT_PROFILE_INVALID";

export class TransportConfigurationError extends Error {
  public readonly code: TransportConfigurationErrorCode;

  public constructor(code: TransportConfigurationErrorCode, message: string) {
    super(message);
    this.name = "TransportConfigurationError";
    this.code = code;
  }
}

export function createTransportResolver<TConnection>(
  dependencies: TransportResolverDependencies<TConnection>,
): TransportResolver<TConnection> {
  const probeTtlMs = dependencies.probeTtlMs;
  if (!Number.isSafeInteger(probeTtlMs) || probeTtlMs <= 0) {
    throw new TransportConfigurationError(
      "TRANSPORT_PROBE_TTL_INVALID",
      "The transport probe TTL must be a positive safe integer.",
    );
  }

  const clock = dependencies.clock;
  const probeBoundary = dependencies.probe;
  const connectBoundary = dependencies.connect;
  const probeCache = new Map<
    string,
    { readonly observedAt: number; readonly result: TransportProbeResult }
  >();

  return {
    async connect(profile, options = {}) {
      const validatedProfile = validateTransportProfile(profile);
      const acceptedKinds = validateAcceptedKinds(options.acceptedKinds);
      const now = readSafeClock(clock);
      const attemptTrace: TransportAttemptTrace[] = [];

      for (const endpoint of validatedProfile.endpoints) {
        if (!acceptedKinds.includes(endpoint.kind)) {
          attemptTrace.push({
            endpointId: endpoint.endpointId,
            label: redactDiagnosticString(endpoint.label),
            kind: endpoint.kind,
            probeSource: "not-run",
            outcome: "skipped-incompatible",
          });
          continue;
        }

        const request = Object.freeze({
          deviceId: validatedProfile.deviceId,
          endpoint,
        });
        const cacheKey = JSON.stringify([
          validatedProfile.deviceId,
          endpoint.endpointId,
          endpoint.kind,
          endpoint.url,
          endpoint.credentialRef,
        ]);
        const cachedProbe = probeCache.get(cacheKey);
        const cacheAge = cachedProbe === undefined ? undefined : now - cachedProbe.observedAt;
        const useCachedProbe =
          cachedProbe !== undefined &&
          cacheAge !== undefined &&
          cacheAge >= 0 &&
          cacheAge < probeTtlMs;
        const probeSource: TransportAttemptTrace["probeSource"] = useCachedProbe ? "cache" : "live";
        let probe: TransportProbeResult;
        if (useCachedProbe) {
          probe = cachedProbe.result;
        } else {
          try {
            probe = snapshotProbeResult(await probeBoundary(request));
          } catch (error: unknown) {
            probe = snapshotProbeResult({
              healthy: false,
              authenticated: false,
              diagnostic: error,
            });
          }
        }
        if (!useCachedProbe) {
          probeCache.set(cacheKey, { observedAt: now, result: probe });
        }

        if (!probe.healthy) {
          const unhealthyAttempt = {
            endpointId: endpoint.endpointId,
            label: redactDiagnosticString(endpoint.label),
            kind: endpoint.kind,
            probeSource,
            outcome: "probe-unhealthy" as const,
          };
          attemptTrace.push(
            probe.diagnostic === undefined
              ? unhealthyAttempt
              : {
                  ...unhealthyAttempt,
                  diagnostic: redactDiagnostic(probe.diagnostic),
                },
          );
          continue;
        }
        if (!probe.authenticated) {
          const rejectedAttempt = {
            endpointId: endpoint.endpointId,
            label: redactDiagnosticString(endpoint.label),
            kind: endpoint.kind,
            probeSource,
            outcome: "authentication-rejected" as const,
            failureStage: "probe" as const,
          };
          attemptTrace.push(
            probe.diagnostic === undefined
              ? rejectedAttempt
              : {
                  ...rejectedAttempt,
                  diagnostic: redactDiagnostic(probe.diagnostic),
                },
          );
          continue;
        }
        if (probe.peerDeviceId !== validatedProfile.deviceId) {
          attemptTrace.push({
            endpointId: endpoint.endpointId,
            label: redactDiagnosticString(endpoint.label),
            kind: endpoint.kind,
            probeSource,
            outcome: "identity-rejected",
            failureStage: "probe",
            diagnostic: identityMismatchDiagnostic(),
          });
          continue;
        }

        let connection: TransportConnectResult<TConnection>;
        try {
          connection = await connectBoundary(request);
        } catch (error: unknown) {
          connection = {
            connected: false,
            diagnostic: error,
          };
        }
        if (!connection.connected) {
          probeCache.delete(cacheKey);
          const failedAttempt = {
            endpointId: endpoint.endpointId,
            label: redactDiagnosticString(endpoint.label),
            kind: endpoint.kind,
            probeSource,
            outcome: "connect-failed" as const,
          };
          attemptTrace.push(
            connection.diagnostic === undefined
              ? failedAttempt
              : {
                  ...failedAttempt,
                  diagnostic: redactDiagnostic(connection.diagnostic),
                },
          );
          continue;
        }
        if (!connection.authenticated) {
          probeCache.delete(cacheKey);
          const rejectedAttempt = {
            endpointId: endpoint.endpointId,
            label: redactDiagnosticString(endpoint.label),
            kind: endpoint.kind,
            probeSource,
            outcome: "authentication-rejected" as const,
            failureStage: "connect" as const,
          };
          attemptTrace.push(
            connection.diagnostic === undefined
              ? rejectedAttempt
              : {
                  ...rejectedAttempt,
                  diagnostic: redactDiagnostic(connection.diagnostic),
                },
          );
          continue;
        }
        if (connection.peerDeviceId !== validatedProfile.deviceId) {
          probeCache.delete(cacheKey);
          attemptTrace.push({
            endpointId: endpoint.endpointId,
            label: redactDiagnosticString(endpoint.label),
            kind: endpoint.kind,
            probeSource,
            outcome: "identity-rejected",
            failureStage: "connect",
            diagnostic: identityMismatchDiagnostic(),
          });
          continue;
        }

        return Object.freeze({
          deviceId: validatedProfile.deviceId,
          endpointId: endpoint.endpointId,
          kind: endpoint.kind,
          connection: connection.connection,
          attemptTrace: freezeAttemptTrace([
            ...attemptTrace,
            {
              endpointId: endpoint.endpointId,
              label: redactDiagnosticString(endpoint.label),
              kind: endpoint.kind,
              probeSource,
              outcome: "connected",
            },
          ]),
        });
      }

      throw new TransportRoutesExhaustedError(validatedProfile.deviceId, attemptTrace);
    },
  };
}

function identityMismatchDiagnostic(): RedactedDiagnostic {
  return Object.freeze({
    code: "PEER_IDENTITY_MISMATCH",
    reason: "Authenticated peer identity did not match the target Device.",
  });
}

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_URL_LENGTH = 2_048;

function validateTransportProfile(profile: TransportProfile): TransportProfile {
  assertProfileIdentifier(profile.deviceId, "Device ID");
  if (!Array.isArray(profile.endpoints)) {
    throw invalidProfile("Transport endpoints must be an array.");
  }

  const endpointIds = new Set<string>();
  const endpoints = profile.endpoints.map((endpoint) => {
    assertProfileIdentifier(endpoint.endpointId, "endpoint ID");
    assertProfileIdentifier(endpoint.label, "endpoint label");
    assertProfileIdentifier(endpoint.credentialRef, "credential reference");
    if (endpointIds.has(endpoint.endpointId)) {
      throw invalidProfile("Transport endpoint IDs must be unique within a profile.");
    }
    endpointIds.add(endpoint.endpointId);

    if (endpoint.kind !== "https" && endpoint.kind !== "wss") {
      throw invalidProfile("Transport endpoint kind must be https or wss.");
    }
    validateEndpointUrl(endpoint.url, endpoint.kind);

    return Object.freeze({
      endpointId: endpoint.endpointId,
      label: endpoint.label,
      kind: endpoint.kind,
      url: endpoint.url,
      credentialRef: endpoint.credentialRef,
    });
  });

  return Object.freeze({
    deviceId: profile.deviceId,
    endpoints: Object.freeze(endpoints),
  });
}

function validateAcceptedKinds(
  acceptedKinds: readonly TransportEndpointKind[] | undefined,
): readonly TransportEndpointKind[] {
  if (acceptedKinds === undefined) {
    return Object.freeze(["https", "wss"] as const);
  }
  if (
    !Array.isArray(acceptedKinds) ||
    acceptedKinds.some((kind) => kind !== "https" && kind !== "wss")
  ) {
    throw invalidProfile("Accepted transport kinds must contain only https or wss.");
  }

  return Object.freeze([...acceptedKinds]);
}

function assertProfileIdentifier(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value !== value.trim() ||
    hasControlCharacter(value)
  ) {
    throw invalidProfile(`${label} must be a trimmed, non-empty value without control characters.`);
  }
}

function validateEndpointUrl(value: string, kind: TransportEndpointKind): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_URL_LENGTH ||
    value !== value.trim() ||
    hasControlCharacter(value)
  ) {
    throw invalidProfile("Transport endpoint URL is invalid.");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalidProfile("Transport endpoint URL must be an absolute URL.");
  }

  const expectedProtocol = kind === "https" ? "https:" : "wss:";
  if (
    parsed.protocol !== expectedProtocol ||
    parsed.hostname.length === 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    containsCredentialAssignment(parsed.pathname) ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw invalidProfile(
      "Transport endpoint URL must match its kind and contain no credentials, query, or fragment.",
    );
  }
}

function containsCredentialAssignment(pathname: string): boolean {
  const credentialAssignment =
    /(?:^|[/;])\s*(?:x[-_])?(?:api[-_]?key|access[-_]?token|auth(?:orization)?|auth[-_]?token|bearer|client[-_]?secret|credential|key|password|passwd|private[-_]?token|proxy[-_]?authorization|refresh[-_]?token|secret|session[-_]?token|signature|token)\s*[:=]\s*[^/;]+/i;
  if (credentialAssignment.test(pathname) || /%25/i.test(pathname)) {
    return true;
  }

  try {
    return credentialAssignment.test(decodeURIComponent(pathname));
  } catch {
    return true;
  }
}

function invalidProfile(message: string): TransportConfigurationError {
  return new TransportConfigurationError("TRANSPORT_PROFILE_INVALID", message);
}

function readSafeClock(clock: TransportClock): number {
  let now: number;
  try {
    now = clock.now();
  } catch {
    throw new TransportConfigurationError(
      "TRANSPORT_CLOCK_INVALID",
      "The transport clock failed to return a timestamp.",
    );
  }
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TransportConfigurationError(
      "TRANSPORT_CLOCK_INVALID",
      "The transport clock must return a non-negative safe-integer timestamp.",
    );
  }

  return now;
}

function snapshotProbeResult(result: TransportProbeResult): TransportProbeResult {
  const peerDeviceId =
    typeof result.peerDeviceId === "string" &&
    result.peerDeviceId.length > 0 &&
    result.peerDeviceId.length <= MAX_IDENTIFIER_LENGTH &&
    result.peerDeviceId === result.peerDeviceId.trim() &&
    !hasControlCharacter(result.peerDeviceId)
      ? result.peerDeviceId
      : undefined;
  const snapshot: {
    healthy: boolean;
    authenticated: boolean;
    peerDeviceId?: string;
    diagnostic?: RedactedDiagnostic;
  } = {
    healthy: result.healthy === true,
    authenticated: result.authenticated === true,
  };
  if (peerDeviceId !== undefined) {
    snapshot.peerDeviceId = peerDeviceId;
  }
  if (result.diagnostic !== undefined) {
    snapshot.diagnostic = redactDiagnostic(result.diagnostic);
  }

  return Object.freeze(snapshot);
}

function freezeAttemptTrace(
  attempts: readonly TransportAttemptTrace[],
): readonly TransportAttemptTrace[] {
  return Object.freeze(
    attempts.map((attempt) =>
      Object.freeze(
        attempt.diagnostic === undefined
          ? { ...attempt }
          : {
              ...attempt,
              diagnostic: freezeRedactedDiagnostic(attempt.diagnostic),
            },
      ),
    ),
  );
}

function freezeRedactedDiagnostic(value: RedactedDiagnostic): RedactedDiagnostic {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => freezeRedactedDiagnostic(item)));
  }
  if (value !== null && typeof value === "object") {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, freezeRedactedDiagnostic(item)]),
      ),
    );
  }

  return value;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}
