import type {
  CandidateExclusion,
  CandidateExplanation,
  CandidateScore,
  DeviceCandidate,
  ScheduleRequest,
  ScheduleSelection,
  TransportRoute,
} from "./contracts.ts";
import { SchedulerError } from "./scheduler-error.ts";

export function scheduleWorkOrder(
  request: ScheduleRequest,
  devices: readonly DeviceCandidate[],
): ScheduleSelection {
  if (!isScheduleRequest(request)) {
    throw new SchedulerError(scheduleRequestWorkOrderId(request), [], "SCHEDULER_INPUT_INVALID");
  }
  if (!Array.isArray(devices)) {
    throw new SchedulerError(request.workOrderId, [], "SCHEDULER_INPUT_INVALID");
  }
  const snapshots = devices.map((device, index) => inspectDeviceSnapshot(device, index));
  const deviceIds = snapshots
    .filter((snapshot) => snapshot.deviceIdValid)
    .map((snapshot) => snapshot.deviceId);
  if (new Set(deviceIds).size !== deviceIds.length) {
    throw new SchedulerError(request.workOrderId, [], "SCHEDULER_INPUT_INVALID");
  }

  const evaluations = snapshots
    .sort(
      (left, right) =>
        compareStableString(left.deviceId, right.deviceId) ||
        left.originalIndex - right.originalIndex,
    )
    .map((snapshot) => evaluateDevice(request, snapshot));
  const rankedCandidates = evaluations
    .filter(
      (evaluation): evaluation is EligibleDeviceEvaluation =>
        evaluation.score !== null && evaluation.route !== undefined,
    )
    .sort(compareCandidates);
  const eligiblePreferredDeviceIds = new Set(
    request.preferredDeviceIds.filter((deviceId) =>
      rankedCandidates.some((candidate) => candidate.device.deviceId === deviceId),
    ),
  );
  const preferredCandidates = rankedCandidates.filter((candidate) =>
    eligiblePreferredDeviceIds.has(candidate.device.deviceId),
  );
  const selectionPool = preferredCandidates.length === 0 ? rankedCandidates : preferredCandidates;
  const selected = selectionPool[0];
  const explanations = evaluations.map(({ deviceId, exclusions, score }): CandidateExplanation => ({
    deviceId,
    eligible: exclusions.length === 0,
    exclusions,
    score,
  }));

  if (selected === undefined) {
    throw new SchedulerError(request.workOrderId, explanations);
  }
  const semanticSelectionCandidates =
    preferredCandidates.length > 0
      ? []
      : selectionPool
          .filter((candidate) => compareCandidateMerit(candidate, selected) === 0)
          .map((candidate) => candidate.device);

  return {
    selectedDevice: selected.device,
    selectedRoute: selected.route,
    semanticSelectionCandidates:
      semanticSelectionCandidates.length <= 1 ? [] : semanticSelectionCandidates,
    explanations,
  };
}

export function isWorkOrderAssignmentEligible(
  request: ScheduleRequest,
  device: DeviceCandidate,
  routeId: string,
): boolean {
  if (!isScheduleRequest(request) || !isCanonicalNonBlankString(routeId)) {
    return false;
  }
  const snapshot = inspectDeviceSnapshot(device, 0);
  const evaluation = evaluateDevice(request, snapshot);
  return (
    evaluation.exclusions.length === 0 &&
    device.transports.some(
      (route) =>
        route.routeId === routeId &&
        route.health === "healthy" &&
        Number.isSafeInteger(route.priority) &&
        route.priority >= 0,
    )
  );
}

interface DeviceEvaluation {
  readonly device: DeviceCandidate;
  readonly deviceId: string;
  readonly route: TransportRoute | undefined;
  readonly exclusions: readonly CandidateExclusion[];
  readonly score: CandidateScore | null;
}

interface EligibleDeviceEvaluation extends DeviceEvaluation {
  readonly route: TransportRoute;
  readonly score: CandidateScore;
}

interface InspectedDeviceSnapshot {
  readonly device: DeviceCandidate;
  readonly deviceId: string;
  readonly workerId: string;
  readonly deviceIdValid: boolean;
  readonly workerIdValid: boolean;
  readonly invalidFields: readonly string[];
  readonly originalIndex: number;
}

function evaluateDevice(
  request: ScheduleRequest,
  snapshot: InspectedDeviceSnapshot,
): DeviceEvaluation {
  const { device } = snapshot;
  if (snapshot.invalidFields.length > 0) {
    return {
      device,
      deviceId: snapshot.deviceId,
      route: undefined,
      exclusions: [
        {
          code: "DEVICE_SNAPSHOT_INVALID",
          fields: snapshot.invalidFields,
        },
      ],
      score: null,
    };
  }

  const exclusions: CandidateExclusion[] = [];
  const verifiedCapabilities = new Set(
    device.capabilities
      .filter((capability) => capability.verification === "verified")
      .map((capability) => capability.name),
  );
  const missingCapabilities = [...new Set(request.requiredCapabilities)]
    .filter((capability) => !verifiedCapabilities.has(capability))
    .sort();
  const availableSecretRefs = new Set(device.availableSecretRefs);
  const missingSecretRefs = [...new Set(request.requiredSecretRefs)]
    .filter((secretRef) => !availableSecretRefs.has(secretRef))
    .sort();
  const route = selectRoute(device);

  if (!device.enabled) {
    exclusions.push({ code: "DEVICE_DISABLED" });
  }

  if (device.status !== "online") {
    exclusions.push({ code: "DEVICE_OFFLINE" });
  }

  if (device.draining) {
    exclusions.push({ code: "DEVICE_DRAINING" });
  }

  if (device.executionPolicyDecision.outcome !== "allow") {
    exclusions.push({
      code: "POLICY_EXECUTION_NOT_ALLOWED",
      outcome: device.executionPolicyDecision.outcome,
      policyCode: device.executionPolicyDecision.code,
    });
  }

  if (request.requiredOsFamily !== undefined && device.osFamily !== request.requiredOsFamily) {
    exclusions.push({
      code: "OS_FAMILY_MISMATCH",
      required: request.requiredOsFamily,
      actual: device.osFamily,
    });
  }

  if (missingCapabilities.length > 0) {
    exclusions.push({
      code: "REQUIRED_CAPABILITY_NOT_VERIFIED",
      capabilities: missingCapabilities,
    });
  }

  if (missingSecretRefs.length > 0) {
    exclusions.push({
      code: "REQUIRED_SECRET_UNAVAILABLE",
      secretRefs: missingSecretRefs,
    });
  }

  if (request.workspaceId !== undefined && !device.workspaceIds.includes(request.workspaceId)) {
    exclusions.push({
      code: "WORKSPACE_UNAVAILABLE",
      workspaceId: request.workspaceId,
    });
  }

  if (route === undefined) {
    exclusions.push({ code: "TRANSPORT_UNHEALTHY" });
  }

  if (device.availableRunSlots <= 0) {
    exclusions.push({ code: "CAPACITY_UNAVAILABLE" });
  }

  if (request.requiredCapabilities.includes("computer-use") && !device.desktopSessionAvailable) {
    exclusions.push({ code: "DESKTOP_SESSION_UNAVAILABLE" });
  }

  return {
    device,
    deviceId: snapshot.deviceId,
    route,
    exclusions,
    score:
      exclusions.length === 0 && route !== undefined ? scoreDevice(request, device, route) : null,
  };
}

function scoreDevice(
  request: ScheduleRequest,
  device: DeviceCandidate,
  route: TransportRoute,
): CandidateScore {
  const matchedRoles = sortedIntersection(request.preferredRoles, device.roles);
  const verifiedCapabilities = new Set(
    device.capabilities
      .filter((capability) => capability.verification === "verified")
      .map((capability) => capability.name),
  );
  const matchedPreferredCapabilities = [...new Set(request.preferredCapabilities)]
    .filter((capability) => verifiedCapabilities.has(capability))
    .sort();

  return {
    matchedRoles,
    matchedPreferredCapabilities,
    roleMatchCount: matchedRoles.length,
    preferredCapabilityMatchCount: matchedPreferredCapabilities.length,
    loadRatio: device.loadRatio,
    routePriority: route.priority,
    routeId: route.routeId,
  };
}

function sortedIntersection(
  preferred: readonly string[],
  available: readonly string[],
): readonly string[] {
  const availableValues = new Set(available);

  return [...new Set(preferred)].filter((value) => availableValues.has(value)).sort();
}

function selectRoute(device: DeviceCandidate): TransportRoute | undefined {
  const routes = device.transports
    .filter(
      (route) =>
        route.health === "healthy" &&
        route.routeId.trim() !== "" &&
        Number.isSafeInteger(route.priority) &&
        route.priority >= 0,
    )
    .sort(
      (left, right) =>
        left.priority - right.priority || compareStableString(left.routeId, right.routeId),
    );
  return routes[0];
}

function inspectDeviceSnapshot(
  device: DeviceCandidate,
  originalIndex: number,
): InspectedDeviceSnapshot {
  const raw = device as unknown;
  if (!isRecord(raw)) {
    return {
      device,
      deviceId: `<invalid-device:${String(originalIndex)}>`,
      workerId: `<invalid-worker:${String(originalIndex)}>`,
      deviceIdValid: false,
      workerIdValid: false,
      invalidFields: Object.freeze(["candidate"]),
      originalIndex,
    };
  }
  const rawDeviceId = raw["deviceId"];
  const rawWorkerId = raw["workerId"];
  const deviceIdValid = isCanonicalNonBlankString(rawDeviceId);
  const workerIdValid = isCanonicalNonBlankString(rawWorkerId);
  const deviceId =
    typeof rawDeviceId === "string" ? rawDeviceId : `<invalid-device:${String(originalIndex)}>`;
  const workerId =
    typeof rawWorkerId === "string" ? rawWorkerId : `<invalid-worker:${String(originalIndex)}>`;
  return {
    device,
    deviceId,
    workerId,
    deviceIdValid,
    workerIdValid,
    invalidFields: validateDeviceSnapshot(raw),
    originalIndex,
  };
}

function validateDeviceSnapshot(device: Readonly<Record<string, unknown>>): readonly string[] {
  const invalidFields: string[] = [];

  if (!isCanonicalNonBlankString(device["deviceId"])) {
    invalidFields.push("deviceId");
  }
  if (!isCanonicalNonBlankString(device["workerId"])) {
    invalidFields.push("workerId");
  }
  if (typeof device["enabled"] !== "boolean") {
    invalidFields.push("enabled");
  }
  if (device["status"] !== "online" && device["status"] !== "offline") {
    invalidFields.push("status");
  }
  if (typeof device["draining"] !== "boolean") {
    invalidFields.push("draining");
  }
  if (
    device["osFamily"] !== "macos" &&
    device["osFamily"] !== "windows" &&
    device["osFamily"] !== "linux"
  ) {
    invalidFields.push("osFamily");
  }
  if (!isCapabilityArray(device["capabilities"])) {
    invalidFields.push("capabilities");
  }
  if (!isCanonicalUniqueStringArray(device["roles"])) {
    invalidFields.push("roles");
  }
  if (!isCanonicalUniqueStringArray(device["workspaceIds"])) {
    invalidFields.push("workspaceIds");
  }
  if (!isTransportArray(device["transports"])) {
    invalidFields.push("transports");
  }
  if (
    !Number.isSafeInteger(device["availableRunSlots"]) ||
    (device["availableRunSlots"] as number) < 0
  ) {
    invalidFields.push("availableRunSlots");
  }
  if (
    !Number.isFinite(device["loadRatio"]) ||
    (device["loadRatio"] as number) < 0 ||
    (device["loadRatio"] as number) > 1
  ) {
    invalidFields.push("loadRatio");
  }
  if (typeof device["desktopSessionAvailable"] !== "boolean") {
    invalidFields.push("desktopSessionAvailable");
  }
  if (!isExecutablePolicyDecision(device["executionPolicyDecision"])) {
    invalidFields.push("executionPolicyDecision");
  }
  if (!isCanonicalUniqueStringArray(device["availableSecretRefs"])) {
    invalidFields.push("availableSecretRefs");
  }

  return Object.freeze(invalidFields);
}

function isCapabilityArray(
  value: unknown,
): value is readonly DeviceCandidate["capabilities"][number][] {
  if (!Array.isArray(value)) {
    return false;
  }
  const capabilityNames: string[] = [];
  for (const capability of value) {
    if (
      !isRecord(capability) ||
      !isCanonicalNonBlankString(capability["name"]) ||
      (capability["verification"] !== "detected" &&
        capability["verification"] !== "verified" &&
        capability["verification"] !== "degraded" &&
        capability["verification"] !== "unavailable" &&
        capability["verification"] !== "disabled")
    ) {
      return false;
    }
    capabilityNames.push(capability["name"]);
  }
  return new Set(capabilityNames).size === capabilityNames.length;
}

function isTransportArray(value: unknown): value is readonly TransportRoute[] {
  if (!Array.isArray(value)) {
    return false;
  }
  const routeIds: string[] = [];
  for (const route of value) {
    if (
      !isRecord(route) ||
      !isCanonicalNonBlankString(route["routeId"]) ||
      !Number.isSafeInteger(route["priority"]) ||
      (route["priority"] as number) < 0 ||
      (route["health"] !== "healthy" && route["health"] !== "unhealthy")
    ) {
      return false;
    }
    routeIds.push(route["routeId"]);
  }
  return new Set(routeIds).size === routeIds.length;
}

function isExecutablePolicyDecision(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value["outcome"] === "allow" ||
      value["outcome"] === "require-approval" ||
      value["outcome"] === "deny") &&
    isCanonicalNonBlankString(value["code"])
  );
}

function isScheduleRequest(value: unknown): value is ScheduleRequest {
  return (
    isRecord(value) &&
    isCanonicalNonBlankString(value["workOrderId"]) &&
    isCanonicalUniqueStringArray(value["requiredCapabilities"]) &&
    isCanonicalUniqueStringArray(value["preferredCapabilities"]) &&
    isCanonicalUniqueStringArray(value["preferredDeviceIds"]) &&
    isCanonicalUniqueStringArray(value["preferredRoles"]) &&
    isCanonicalUniqueStringArray(value["requiredSecretRefs"]) &&
    (value["requiredOsFamily"] === undefined ||
      value["requiredOsFamily"] === "macos" ||
      value["requiredOsFamily"] === "windows" ||
      value["requiredOsFamily"] === "linux") &&
    (value["workspaceId"] === undefined || isCanonicalNonBlankString(value["workspaceId"]))
  );
}

function scheduleRequestWorkOrderId(value: unknown): string {
  if (isRecord(value) && isCanonicalNonBlankString(value["workOrderId"])) {
    return value["workOrderId"];
  }
  return "<invalid-work-order>";
}

function isCanonicalUniqueStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every(isCanonicalNonBlankString) &&
    new Set(value).size === value.length
  );
}

function isCanonicalNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value === value.trim();
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareCandidates(
  left: EligibleDeviceEvaluation,
  right: EligibleDeviceEvaluation,
): number {
  return (
    compareCandidateMerit(left, right) ||
    compareStableString(left.device.deviceId, right.device.deviceId)
  );
}

function compareCandidateMerit(
  left: EligibleDeviceEvaluation,
  right: EligibleDeviceEvaluation,
): number {
  return (
    right.score.roleMatchCount - left.score.roleMatchCount ||
    right.score.preferredCapabilityMatchCount - left.score.preferredCapabilityMatchCount ||
    left.score.loadRatio - right.score.loadRatio ||
    left.score.routePriority - right.score.routePriority
  );
}

function compareStableString(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}
