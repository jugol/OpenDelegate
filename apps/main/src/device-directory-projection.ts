import type { DeviceSummaryV1 } from "@opendelegate/protocol";

const MAXIMUM_DEVICE_ROUTES = 64;

/**
 * Main and Worker are runtime roles, not distinct physical Devices. When Main's
 * Device also runs the Worker daemon, Admin must show one Device while retaining
 * Main-owned identity/profile authority and adding only Worker-observed runtime
 * evidence.
 */
export function mergeMainDeviceSummary(
  main: DeviceSummaryV1,
  workerSummaries: readonly DeviceSummaryV1[],
): readonly DeviceSummaryV1[] {
  if (main.role !== "main") {
    throw new TypeError("The authoritative Device summary must have the Main role.");
  }
  const coLocatedWorkers = workerSummaries.filter(
    (candidate) => candidate.deviceId === main.deviceId,
  );
  if (coLocatedWorkers.length > 1) {
    throw new Error("The Worker fleet contains duplicate identities for Main's Device.");
  }
  const coLocatedWorker = coLocatedWorkers[0];
  const remoteWorkers = workerSummaries.filter((candidate) => candidate.deviceId !== main.deviceId);
  if (coLocatedWorker === undefined) {
    return Object.freeze([structuredClone(main), ...remoteWorkers.map(cloneSummary)]);
  }
  if (
    coLocatedWorker.role !== "worker" ||
    coLocatedWorker.osFamily !== main.osFamily ||
    coLocatedWorker.architecture !== main.architecture
  ) {
    throw new Error("The co-located Worker identity conflicts with Main's Device.");
  }

  const merged: DeviceSummaryV1 = {
    ...structuredClone(main),
    serviceMode: coLocatedWorker.serviceMode,
    ...(coLocatedWorker.lastObservation === undefined
      ? {}
      : { lastObservation: { ...coLocatedWorker.lastObservation } }),
    ...(coLocatedWorker.facts === undefined
      ? {}
      : { facts: coLocatedWorker.facts.map((fact) => ({ ...fact })) }),
    ...(coLocatedWorker.capabilities === undefined
      ? {}
      : {
          capabilities: coLocatedWorker.capabilities.map((capability) => ({
            ...capability,
          })),
        }),
    ...(coLocatedWorker.agentAdapters === undefined
      ? {}
      : {
          agentAdapters: coLocatedWorker.agentAdapters.map((adapter) => ({
            ...adapter,
            ...(adapter.models === undefined
              ? {}
              : {
                  models: adapter.models.map((model) => ({
                    ...model,
                    ...(model.supportedEfforts === undefined
                      ? {}
                      : { supportedEfforts: [...model.supportedEfforts] }),
                  })),
                }),
          })),
        }),
    ...(coLocatedWorker.workspaceIds === undefined
      ? {}
      : { workspaceIds: [...coLocatedWorker.workspaceIds] }),
    routes: mergeRoutes(main.routes ?? [], coLocatedWorker.routes ?? []),
    ...(coLocatedWorker.resourceLocks === undefined
      ? {}
      : {
          resourceLocks: coLocatedWorker.resourceLocks.map((lock) => ({
            resourceName: lock.resourceName,
            capacity: lock.capacity,
            holders: lock.holders.map((holder) => ({ ...holder })),
          })),
        }),
    ...(coLocatedWorker.currentRuns === undefined
      ? {}
      : {
          currentRuns: coLocatedWorker.currentRuns.map((run) => ({ ...run })),
        }),
    ...(coLocatedWorker.capacity === undefined
      ? {}
      : { capacity: { ...coLocatedWorker.capacity } }),
    ...(coLocatedWorker.knowledgeHealth === undefined
      ? {}
      : { knowledgeHealth: coLocatedWorker.knowledgeHealth }),
  };
  return Object.freeze([Object.freeze(merged), ...remoteWorkers.map(cloneSummary)]);
}

function mergeRoutes(
  mainRoutes: NonNullable<DeviceSummaryV1["routes"]>,
  workerRoutes: NonNullable<DeviceSummaryV1["routes"]>,
): NonNullable<DeviceSummaryV1["routes"]> {
  const unique = new Map<string, (typeof mainRoutes)[number]>();
  for (const route of [...mainRoutes, ...workerRoutes]) {
    if (!unique.has(route.routeId)) {
      unique.set(route.routeId, route);
    }
  }
  return [...unique.values()].slice(0, MAXIMUM_DEVICE_ROUTES).map((route, priority) =>
    Object.freeze({
      ...structuredClone(route),
      priority,
    }),
  );
}

function cloneSummary(summary: DeviceSummaryV1): DeviceSummaryV1 {
  return Object.freeze(structuredClone(summary));
}
