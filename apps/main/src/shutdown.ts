export interface MainCleanupOperation {
  readonly operation: string;
  readonly close: () => Promise<void> | void;
}

interface MainCleanupFailure {
  readonly operation: string;
  readonly error: unknown;
}

const cleanupFailuresByPrimary = new WeakMap<Error, readonly MainCleanupFailure[]>();

export class MainShutdownError extends AggregateError {
  readonly code = "SHUTDOWN_FAILED";
  readonly operations: readonly string[];

  constructor(failures: readonly MainCleanupFailure[]) {
    super(
      failures.map((failure) => failure.error),
      "OpenDelegate could not shut down cleanly.",
    );
    this.name = "MainShutdownError";
    this.operations = Object.freeze(failures.map((failure) => failure.operation));
  }
}

export function cleanupFailureFor(primaryError: unknown): MainShutdownError | undefined {
  if (!(primaryError instanceof Error)) {
    return undefined;
  }
  const failures = cleanupFailuresByPrimary.get(primaryError);
  return failures === undefined ? undefined : new MainShutdownError(failures);
}

export async function closeMainResources(
  operations: readonly MainCleanupOperation[],
): Promise<void> {
  const failures = await collectCleanupFailures(operations);
  if (failures.length > 0) {
    throw new MainShutdownError(failures);
  }
}

export async function closeAfterPrimaryFailure(
  primaryError: unknown,
  operations: readonly MainCleanupOperation[],
): Promise<never> {
  const failures = await collectCleanupFailures(operations);
  if (failures.length === 0) {
    throw primaryError;
  }

  const cleanupError = new MainShutdownError(failures);
  if (!(primaryError instanceof Error)) {
    const wrapper = new AggregateError(
      [primaryError, cleanupError],
      "OpenDelegate failed and could not clean up completely.",
      { cause: primaryError },
    );
    cleanupFailuresByPrimary.set(wrapper, failures);
    throw wrapper;
  }

  cleanupFailuresByPrimary.set(
    primaryError,
    Object.freeze([...(cleanupFailuresByPrimary.get(primaryError) ?? []), ...failures]),
  );
  throw primaryError;
}

async function collectCleanupFailures(
  operations: readonly MainCleanupOperation[],
): Promise<readonly MainCleanupFailure[]> {
  const outcomes = await Promise.allSettled(operations.map(async (operation) => operation.close()));
  const failures: MainCleanupFailure[] = [];
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.status === "fulfilled") {
      continue;
    }
    const operation = operations[index];
    if (operation !== undefined) {
      failures.push({
        operation: operation.operation,
        error: outcome.reason as unknown,
      });
    }
  }
  return Object.freeze(failures);
}
