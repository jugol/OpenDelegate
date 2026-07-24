import { DomainError } from "./domain-error.ts";
import type { DeviceId, WorkspaceId } from "./identifiers.ts";

export type WorkspaceType = "git-repository" | "directory" | "mounted-storage";
export type WorkspaceIsolation =
  "none" | "agent-native-worktree" | "opendelegate-managed-worktree" | "container" | "custom";

export interface CreateWorkspace {
  readonly id: WorkspaceId;
  readonly deviceId: DeviceId;
  readonly alias: string;
  readonly type: WorkspaceType;
  readonly localPath: string;
  readonly capabilityIds: readonly string[];
  readonly isolation: WorkspaceIsolation;
}

export interface WorkspaceSchedulingSnapshot {
  readonly id: string;
  readonly deviceId: string;
  readonly alias: string;
  readonly type: WorkspaceType;
  readonly capabilityIds: readonly string[];
  readonly isolation: WorkspaceIsolation;
}

export interface WorkspaceCleanupState {
  readonly hasUncommittedChanges: boolean;
  readonly hasUntrackedFiles: boolean;
  readonly hasUnpushedCommits: boolean;
  readonly approvedDisposition?: "discard" | "preserve";
}

export class Workspace {
  public readonly id: WorkspaceId;
  public readonly deviceId: DeviceId;
  public readonly alias: string;
  public readonly type: WorkspaceType;
  public readonly isolation: WorkspaceIsolation;
  private readonly localPath: string;
  private readonly capabilityIds: readonly string[];

  private constructor(input: CreateWorkspace) {
    this.id = input.id;
    this.deviceId = input.deviceId;
    this.alias = input.alias;
    this.type = input.type;
    this.isolation = input.isolation;
    this.localPath = input.localPath;
    this.capabilityIds = Object.freeze([...input.capabilityIds]);
  }

  public static create(input: CreateWorkspace): Workspace {
    return new Workspace(input);
  }

  public get schedulingSnapshot(): WorkspaceSchedulingSnapshot {
    return Object.freeze({
      id: this.id.value,
      deviceId: this.deviceId.value,
      alias: this.alias,
      type: this.type,
      capabilityIds: this.capabilityIds,
      isolation: this.isolation,
    });
  }

  public resolveLocalPath(requestingDeviceId: DeviceId): string {
    if (requestingDeviceId.value !== this.deviceId.value) {
      throw new DomainError(
        "WORKSPACE_DEVICE_MISMATCH",
        `Workspace ${this.id.value} is local to Device ${this.deviceId.value}.`,
      );
    }

    return this.localPath;
  }

  public assertCleanupAllowed(state: WorkspaceCleanupState): void {
    const isDirty =
      state.hasUncommittedChanges || state.hasUntrackedFiles || state.hasUnpushedCommits;

    if (isDirty && state.approvedDisposition !== "discard") {
      throw new DomainError(
        "WORKSPACE_CLEANUP_UNSAFE",
        `Workspace ${this.id.value} has work that requires an approved disposition.`,
      );
    }
  }
}
