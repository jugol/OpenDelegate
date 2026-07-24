import { validateSupervisorCommands } from "./command-validation.ts";
import type { SupervisorOperation } from "./plans.ts";
import type { CommandInvocation } from "./types.ts";

export interface SupervisorSubprocessResult {
  readonly exitCode: number;
}

export interface SupervisorSubprocessRunner {
  run(invocation: CommandInvocation): Promise<SupervisorSubprocessResult>;
}

export interface OwnerSessionAvailability {
  isLoggedIn(): Promise<boolean>;
}

export interface SupervisorOperationResult {
  readonly disposition: "completed" | "deferred-logged-out";
  readonly completedInvocations: number;
  readonly plane: SupervisorOperation["plane"];
  readonly verb: SupervisorOperation["verb"];
}

export class SupervisorInvocationError extends Error {
  public readonly code = "SUPERVISOR_COMMAND_FAILED";
  public readonly executable: string;
  public readonly exitCode: number;

  public constructor(executable: string, exitCode: number) {
    super(`Supervisor command ${executable} returned an unexpected exit code.`);
    this.name = "SupervisorInvocationError";
    this.executable = executable;
    this.exitCode = exitCode;
  }
}

export async function executeSupervisorOperation(
  operation: SupervisorOperation,
  runner: SupervisorSubprocessRunner,
  ownerSession: OwnerSessionAvailability,
): Promise<SupervisorOperationResult> {
  validateSupervisorCommands(operation.invocations);
  if (
    operation.plane === "session-helper" &&
    operation.deferWhenLoggedOut &&
    !(await ownerSession.isLoggedIn())
  ) {
    return {
      disposition: "deferred-logged-out",
      completedInvocations: 0,
      plane: operation.plane,
      verb: operation.verb,
    };
  }
  let completedInvocations = 0;
  for (const invocation of operation.invocations) {
    const result = await runner.run(invocation);
    if (!invocation.expectedExitCodes.includes(result.exitCode)) {
      throw new SupervisorInvocationError(invocation.executable, result.exitCode);
    }
    completedInvocations += 1;
  }
  return {
    disposition: "completed",
    completedInvocations,
    plane: operation.plane,
    verb: operation.verb,
  };
}
