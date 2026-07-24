import type {
  ComputerUseStartClaim,
  ComputerUseStartHistory,
  ComputerUseStartRecord,
} from "./contracts.ts";

export class InMemoryComputerUseStartHistory implements ComputerUseStartHistory {
  private readonly records = new Map<string, ComputerUseStartRecord>();

  public async claim(record: ComputerUseStartRecord): Promise<ComputerUseStartClaim> {
    const existing = this.records.get(record.commandId);
    if (existing === undefined) {
      const saved = Object.freeze({ ...record });
      this.records.set(record.commandId, saved);
      return { disposition: "created", record: saved };
    }

    if (
      existing.startFingerprint !== record.startFingerprint ||
      existing.executionHandleId !== record.executionHandleId
    ) {
      return { disposition: "conflict", record: existing };
    }

    return { disposition: "replay", record: existing };
  }
}
