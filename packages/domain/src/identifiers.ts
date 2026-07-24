import { DomainError } from "./domain-error.ts";

abstract class IdentifierValue<Kind extends string> {
  declare private readonly identifierKind: Kind;
  public readonly value: string;

  protected constructor(value: string) {
    if (value.trim().length === 0) {
      throw new DomainError("IDENTIFIER_INVALID", "A domain identifier cannot be blank.");
    }
    this.value = value;
    Object.freeze(this);
  }

  public toString(): string {
    return this.value;
  }
}

export class InstanceId extends IdentifierValue<"InstanceId"> {
  private constructor(value: string) {
    super(value);
  }

  public static from(value: string): InstanceId {
    return new InstanceId(value);
  }
}

export class OwnerId extends IdentifierValue<"OwnerId"> {
  private constructor(value: string) {
    super(value);
  }

  public static from(value: string): OwnerId {
    return new OwnerId(value);
  }
}

export class CapabilityId extends IdentifierValue<"CapabilityId"> {
  private constructor(value: string) {
    super(value);
  }

  public static from(value: string): CapabilityId {
    return new CapabilityId(value);
  }
}

export class BudgetId extends IdentifierValue<"BudgetId"> {
  private constructor(value: string) {
    super(value);
  }

  public static from(value: string): BudgetId {
    return new BudgetId(value);
  }
}

export class PolicyId extends IdentifierValue<"PolicyId"> {
  private constructor(value: string) {
    super(value);
  }

  public static from(value: string): PolicyId {
    return new PolicyId(value);
  }
}

export class TaskId extends IdentifierValue<"TaskId"> {
  private constructor(value: string) {
    super(value);
  }

  public static from(value: string): TaskId {
    return new TaskId(value);
  }
}

export class WorkOrderId extends IdentifierValue<"WorkOrderId"> {
  private constructor(value: string) {
    super(value);
  }

  public static from(value: string): WorkOrderId {
    return new WorkOrderId(value);
  }
}

export class WorkspaceId extends IdentifierValue<"WorkspaceId"> {
  private constructor(value: string) {
    super(value);
  }

  public static from(value: string): WorkspaceId {
    return new WorkspaceId(value);
  }
}

export class ArtifactId extends IdentifierValue<"ArtifactId"> {
  private constructor(value: string) {
    super(value);
  }

  public static from(value: string): ArtifactId {
    return new ArtifactId(value);
  }
}

export class AuditEventId extends IdentifierValue<"AuditEventId"> {
  private constructor(value: string) {
    super(value);
  }

  public static from(value: string): AuditEventId {
    return new AuditEventId(value);
  }
}

export class DeviceId extends IdentifierValue<"DeviceId"> {
  private constructor(value: string) {
    super(value);
  }

  public static from(value: string): DeviceId {
    return new DeviceId(value);
  }
}

export class RunId extends IdentifierValue<"RunId"> {
  private constructor(value: string) {
    super(value);
  }

  public static from(value: string): RunId {
    return new RunId(value);
  }
}

export class ApprovalId extends IdentifierValue<"ApprovalId"> {
  private constructor(value: string) {
    super(value);
  }

  public static from(value: string): ApprovalId {
    return new ApprovalId(value);
  }
}

export class AgentSessionId extends IdentifierValue<"AgentSessionId"> {
  private constructor(value: string) {
    super(value);
  }

  public static from(value: string): AgentSessionId {
    return new AgentSessionId(value);
  }
}
