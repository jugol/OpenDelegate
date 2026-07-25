import type {
  ActionTargetValue,
  ApprovalExecutionContext,
  ApprovalExecutionPort,
} from "@opendelegate/policy";

import type { MainActionRunAuthorityPort } from "./action-authorization-runtime.ts";

/**
 * Breaks the Approval Service -> Worker action executor construction cycle
 * without introducing a permissive startup window. Binding is one-way and
 * exactly once; execution before binding always fails closed.
 */
export class LateBoundApprovalExecutionPort implements ApprovalExecutionPort {
  #delegate: ApprovalExecutionPort | undefined;

  public bind(delegate: ApprovalExecutionPort): void {
    if (
      this.#delegate !== undefined ||
      delegate === null ||
      typeof delegate !== "object" ||
      typeof delegate.execute !== "function"
    ) {
      throw new TypeError("The Worker action Approval executor binding is invalid.");
    }
    this.#delegate = delegate;
  }

  public execute(input: ApprovalExecutionContext): Promise<ActionTargetValue | undefined> {
    const delegate = this.#delegate;
    if (delegate === undefined) {
      return Promise.reject(new Error("The Worker action Approval executor is not available."));
    }
    return delegate.execute(input);
  }
}

/**
 * The authoritative Worker executor requires the Device channel dispatch port,
 * while the Device channel needs action callbacks at construction time. Until
 * that executor is bound, every Run authority check returns unauthorized.
 */
export class LateBoundMainActionRunAuthorityPort implements MainActionRunAuthorityPort {
  #delegate: MainActionRunAuthorityPort | undefined;

  public bind(delegate: MainActionRunAuthorityPort): void {
    if (
      this.#delegate !== undefined ||
      delegate === null ||
      typeof delegate !== "object" ||
      typeof delegate.authorizeWorkerActionRun !== "function"
    ) {
      throw new TypeError("The Worker action Run authority binding is invalid.");
    }
    this.#delegate = delegate;
  }

  public async authorizeWorkerActionRun(
    authenticatedDeviceId: string,
    scope: Parameters<MainActionRunAuthorityPort["authorizeWorkerActionRun"]>[1],
  ): Promise<Awaited<ReturnType<MainActionRunAuthorityPort["authorizeWorkerActionRun"]>>> {
    const delegate = this.#delegate;
    if (delegate === undefined) {
      return Object.freeze({ authorized: false });
    }
    try {
      return await delegate.authorizeWorkerActionRun(authenticatedDeviceId, scope);
    } catch {
      return Object.freeze({ authorized: false });
    }
  }
}
