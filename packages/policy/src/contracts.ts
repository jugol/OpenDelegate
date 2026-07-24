import type { ActionFingerprint } from "./action-fingerprint.ts";

export type ActionCategory =
  | "read-only-observation"
  | "opendelegate-process-retry"
  | "opendelegate-process-restart"
  | "project-dependency-install"
  | "configured-official-package-install"
  | "computer-use-input"
  | "package-repository-addition"
  | "remote-installer-script"
  | "untrusted-installer"
  | "driver-installation"
  | "kernel-extension-installation"
  | "os-network-change"
  | "vpn-change"
  | "firewall-change"
  | "policy-relaxation"
  | "secret-export"
  | "cross-device-knowledge-transfer"
  | "policy-bypass-attempt";

export interface ActionRequest {
  readonly requestId: string;
  readonly actionCategory: ActionCategory;
  readonly actionFingerprint: ActionFingerprint;
  readonly taskId?: string;
  readonly deviceId?: string;
}

export type GrantScope =
  | {
      readonly kind: "once";
      readonly requestId: string;
      readonly actionFingerprint: ActionFingerprint;
    }
  | {
      readonly kind: "task";
      readonly taskId: string;
      readonly actionFingerprint: ActionFingerprint;
    }
  | {
      readonly kind: "device";
      readonly deviceId: string;
      readonly actionFingerprint: ActionFingerprint;
    }
  | {
      readonly kind: "policy";
      readonly actionFingerprint: ActionFingerprint;
    };

export interface OwnerGrant {
  readonly grantId: string;
  readonly issuer: "owner";
  readonly actionCategory: ActionCategory;
  readonly expiresAt: number;
  readonly scope: GrantScope;
}

export interface PolicyContext {
  readonly now: number;
  readonly grants: readonly OwnerGrant[];
}

export interface OnceGrantConsumption {
  readonly grantId: string;
  readonly requestId: string;
  readonly actionCategory: ActionCategory;
  readonly actionFingerprint: ActionFingerprint;
  readonly taskId?: string;
  readonly deviceId?: string;
  readonly consumedAt: number;
}

export type OnceGrantConsumptionResult = "consumed" | "already-consumed";

/**
 * The execution boundary for one-shot owner grants.
 *
 * Implementations must atomically persist the first consumption before returning
 * `consumed`. A check followed by a separate write does not satisfy this contract.
 */
export interface OnceGrantConsumptionStore {
  tryConsume(consumption: OnceGrantConsumption): OnceGrantConsumptionResult;
}

export type PolicyOutcome = "allow" | "require-approval" | "deny";

export type PolicyCode =
  | "POLICY_SAFE_OBSERVATION"
  | "POLICY_OPENDELEGATE_PROCESS_RECOVERY"
  | "POLICY_TRUSTED_PACKAGE_INSTALL"
  | "POLICY_COMPUTER_USE_APPROVAL_REQUIRED"
  | "POLICY_SUPPLY_CHAIN_APPROVAL_REQUIRED"
  | "POLICY_SYSTEM_CONFIGURATION_APPROVAL_REQUIRED"
  | "POLICY_RELAXATION_APPROVAL_REQUIRED"
  | "POLICY_SECRET_EXPORT_DENIED"
  | "POLICY_CROSS_DEVICE_KNOWLEDGE_DENIED"
  | "POLICY_BYPASS_ATTEMPT_DENIED"
  | "POLICY_OWNER_GRANT";

export interface PolicyDecision {
  readonly outcome: PolicyOutcome;
  readonly code: PolicyCode;
  readonly explanation: string;
  readonly matchedGrant?: OwnerGrant;
}
