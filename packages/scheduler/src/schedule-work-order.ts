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
  const deviceIds = devices.map((device) => device.deviceId);
  if (new Set(deviceIds).size !== deviceIds.length) {
    throw new SchedulerError(request.workOrderId, [], "SCHEDULER_INPUT_INVALID");
  }

  const evaluations = [...devices]
    .sort((left, right) => compareStableString(left.deviceId, right.deviceId))
    .map((device) => evaluateDevice(request, device));
  const rankedCandidates = evaluations
    .filter(
      (evaluation): evaluation is EligibleDeviceEvaluation =>
        evaluation.score !== null && evaluation.route !== undefined,
    )
    .sort(compareCandidates);
  const selected = rankedCandidates[0];
  const explanations = evaluations.map(({ device, exclusions, score }): CandidateExplanation => ({
    deviceId: device.deviceId,
    eligible: exclusions.length === 0,
    exclusions,
    score,
  }));

  if (selected === undefined) {
    throw new SchedulerError(request.workOrderId, explanations);
  }

  return {
    selectedDevice: selected.device,
    selectedRoute: selected.route,
    explanations,
  };
}

interface DeviceEvaluation {
  readonly device: DeviceCandidate;
  readonly route: TransportRoute | undefined;
  readonly exclusions: readonly CandidateExclusion[];
  readonly score: CandidateScore | null;
}

interface EligibleDeviceEvaluation extends DeviceEvaluation {
  readonly route: TransportRoute;
  readonly score: CandidateScore;
}

function evaluateDevice(request: ScheduleRequest, device: DeviceCandidate): DeviceEvaluation {
  const exclusions: CandidateExclusion[] = [];
  const invalidFields = validateDeviceSnapshot(device);
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

  if (invalidFields.length > 0) {
    exclusions.push({
      code: "DEVICE_SNAPSHOT_INVALID",
      fields: invalidFields,
    });
  }

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

function validateDeviceSnapshot(device: DeviceCandidate): readonly string[] {
  const invalidFields: string[] = [];

  if (device.deviceId.trim() === "") {
    invalidFields.push("deviceId");
  }
  if (!Number.isSafeInteger(device.availableRunSlots) || device.availableRunSlots < 0) {
    invalidFields.push("availableRunSlots");
  }
  if (!Number.isFinite(device.loadRatio) || device.loadRatio < 0 || device.loadRatio > 1) {
    invalidFields.push("loadRatio");
  }
  if (
    device.transports.some(
      (route) =>
        route.routeId.trim() === "" || !Number.isSafeInteger(route.priority) || route.priority < 0,
    ) ||
    new Set(device.transports.map((route) => route.routeId)).size !== device.transports.length
  ) {
    invalidFields.push("transports");
  }

  return Object.freeze(invalidFields);
}

function compareCandidates(
  left: EligibleDeviceEvaluation,
  right: EligibleDeviceEvaluation,
): number {
  return (
    right.score.roleMatchCount - left.score.roleMatchCount ||
    right.score.preferredCapabilityMatchCount - left.score.preferredCapabilityMatchCount ||
    left.score.loadRatio - right.score.loadRatio ||
    left.score.routePriority - right.score.routePriority ||
    compareStableString(left.device.deviceId, right.device.deviceId)
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
