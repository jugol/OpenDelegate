import { isActionFingerprint } from "./action-fingerprint.ts";
import type {
  OnceGrantConsumption,
  OnceGrantConsumptionResult,
  OnceGrantConsumptionStore,
} from "./contracts.ts";

export class InMemoryOnceGrantConsumptionStore implements OnceGrantConsumptionStore {
  private readonly consumptionsByGrantId = new Map<string, OnceGrantConsumption>();

  public static fromSnapshot(
    consumptions: readonly OnceGrantConsumption[],
  ): InMemoryOnceGrantConsumptionStore {
    if (!Array.isArray(consumptions)) {
      throw new TypeError("Once-grant consumption snapshot must be an array.");
    }

    const store = new InMemoryOnceGrantConsumptionStore();
    for (const consumption of consumptions) {
      if (store.tryConsume(consumption) !== "consumed") {
        throw new TypeError(
          `Once-grant consumption snapshot repeats grant "${consumption.grantId}".`,
        );
      }
    }

    return store;
  }

  public tryConsume(consumption: OnceGrantConsumption): OnceGrantConsumptionResult {
    const normalized = normalizeConsumption(consumption);

    if (this.consumptionsByGrantId.has(normalized.grantId)) {
      return "already-consumed";
    }

    this.consumptionsByGrantId.set(normalized.grantId, normalized);
    return "consumed";
  }

  public snapshot(): readonly OnceGrantConsumption[] {
    return Object.freeze(
      [...this.consumptionsByGrantId.values()]
        .sort((left, right) => compareStableString(left.grantId, right.grantId))
        .map((consumption) => Object.freeze({ ...consumption })),
    );
  }
}

function normalizeConsumption(consumption: OnceGrantConsumption): OnceGrantConsumption {
  if (
    consumption === null ||
    typeof consumption !== "object" ||
    !isIdentifier(consumption.grantId) ||
    !isIdentifier(consumption.requestId) ||
    !isActionFingerprint(consumption.actionFingerprint) ||
    !Number.isSafeInteger(consumption.consumedAt) ||
    consumption.consumedAt < 0 ||
    (consumption.taskId !== undefined && !isIdentifier(consumption.taskId)) ||
    (consumption.deviceId !== undefined && !isIdentifier(consumption.deviceId))
  ) {
    throw new TypeError("Once-grant consumption is invalid.");
  }

  return Object.freeze({
    grantId: consumption.grantId,
    requestId: consumption.requestId,
    actionCategory: consumption.actionCategory,
    actionFingerprint: consumption.actionFingerprint,
    ...(consumption.taskId === undefined ? {} : { taskId: consumption.taskId }),
    ...(consumption.deviceId === undefined ? {} : { deviceId: consumption.deviceId }),
    consumedAt: consumption.consumedAt,
  });
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
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
