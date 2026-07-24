import { isActionFingerprint } from "./action-fingerprint.ts";
import type {
  ActionRequest,
  OnceGrantConsumptionStore,
  OwnerGrant,
  PolicyContext,
  PolicyDecision,
} from "./contracts.ts";

/**
 * Produces a stateless policy decision for previews and non-consuming grants.
 *
 * A matching once grant is deliberately unavailable here because returning allow
 * without atomically recording consumption would make it replayable.
 */
export function evaluateAction(request: ActionRequest, context: PolicyContext): PolicyDecision {
  return decideAction(request, context);
}

/**
 * Produces the executable policy decision and atomically consumes a matching once
 * grant before returning allow.
 */
export function enforceAction(
  request: ActionRequest,
  context: PolicyContext,
  onceGrantConsumptions: OnceGrantConsumptionStore,
): PolicyDecision {
  return decideAction(request, context, onceGrantConsumptions);
}

function decideAction(
  request: ActionRequest,
  context: PolicyContext,
  onceGrantConsumptions?: OnceGrantConsumptionStore,
): PolicyDecision {
  const defaultDecision = evaluateDefault(request);

  if (defaultDecision.outcome !== "require-approval") {
    return defaultDecision;
  }

  const matchingGrants = context.grants
    .filter((grant) => grantMatches(request, grant, context.now))
    .sort(compareGrants);

  for (const matchedGrant of matchingGrants) {
    if (matchedGrant.scope.kind === "once") {
      if (
        onceGrantConsumptions === undefined ||
        onceGrantConsumptions.tryConsume(
          Object.freeze({
            grantId: matchedGrant.grantId,
            requestId: request.requestId,
            actionCategory: request.actionCategory,
            actionFingerprint: request.actionFingerprint,
            ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
            ...(request.deviceId === undefined ? {} : { deviceId: request.deviceId }),
            consumedAt: context.now,
          }),
        ) !== "consumed"
      ) {
        continue;
      }
    }

    return grantDecision(matchedGrant);
  }

  return defaultDecision;
}

function evaluateDefault(request: ActionRequest): PolicyDecision {
  switch (request.actionCategory) {
    case "read-only-observation":
      return decision(
        "allow",
        "POLICY_SAFE_OBSERVATION",
        "Read-only observation is allowed by default.",
      );

    case "opendelegate-process-retry":
    case "opendelegate-process-restart":
      return decision(
        "allow",
        "POLICY_OPENDELEGATE_PROCESS_RECOVERY",
        "Bounded recovery of an OpenDelegate-owned process is allowed by default.",
      );

    case "project-dependency-install":
    case "configured-official-package-install":
      return decision(
        "allow",
        "POLICY_TRUSTED_PACKAGE_INSTALL",
        "Installation from an existing trusted package source is allowed by default.",
      );

    case "computer-use-input":
      return decision(
        "require-approval",
        "POLICY_COMPUTER_USE_APPROVAL_REQUIRED",
        "Computer Use input requires owner approval or an explicit Policy grant.",
      );

    case "package-repository-addition":
    case "remote-installer-script":
    case "untrusted-installer":
    case "driver-installation":
    case "kernel-extension-installation":
      return decision(
        "require-approval",
        "POLICY_SUPPLY_CHAIN_APPROVAL_REQUIRED",
        "This supply-chain action requires owner approval.",
      );

    case "os-network-change":
    case "vpn-change":
    case "firewall-change":
      return decision(
        "require-approval",
        "POLICY_SYSTEM_CONFIGURATION_APPROVAL_REQUIRED",
        "This system connectivity change requires owner approval.",
      );

    case "policy-relaxation":
      return decision(
        "require-approval",
        "POLICY_RELAXATION_APPROVAL_REQUIRED",
        "Relaxing executable Policy requires owner approval.",
      );

    case "secret-export":
      return decision(
        "deny",
        "POLICY_SECRET_EXPORT_DENIED",
        "Secret values cannot be exported through OpenDelegate.",
      );

    case "cross-device-knowledge-transfer":
      return decision(
        "deny",
        "POLICY_CROSS_DEVICE_KNOWLEDGE_DENIED",
        "Device-local Knowledge cannot be transferred to another Device.",
      );

    case "policy-bypass-attempt":
      return decision(
        "deny",
        "POLICY_BYPASS_ATTEMPT_DENIED",
        "An action cannot bypass executable Policy.",
      );
  }
}

function grantMatches(request: ActionRequest, grant: OwnerGrant, now: number): boolean {
  if (
    grant.issuer !== "owner" ||
    grant.actionCategory !== request.actionCategory ||
    !Number.isFinite(now) ||
    !Number.isFinite(grant.expiresAt) ||
    !isActionFingerprint(request.actionFingerprint) ||
    !isActionFingerprint(grant.scope.actionFingerprint) ||
    grant.scope.actionFingerprint !== request.actionFingerprint ||
    grant.expiresAt <= now
  ) {
    return false;
  }

  switch (grant.scope.kind) {
    case "once":
      return grant.scope.requestId === request.requestId;
    case "task":
      return request.taskId !== undefined && grant.scope.taskId === request.taskId;
    case "device":
      return request.deviceId !== undefined && grant.scope.deviceId === request.deviceId;
    case "policy":
      return true;
  }
}

function compareGrants(left: OwnerGrant, right: OwnerGrant): number {
  return (
    grantScopeRank(left) - grantScopeRank(right) ||
    compareStableString(left.grantId, right.grantId) ||
    left.expiresAt - right.expiresAt
  );
}

function grantScopeRank(grant: OwnerGrant): number {
  switch (grant.scope.kind) {
    case "once":
      return 0;
    case "task":
      return 1;
    case "device":
      return 2;
    case "policy":
      return 3;
  }
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

function decision(
  outcome: PolicyDecision["outcome"],
  code: PolicyDecision["code"],
  explanation: string,
): PolicyDecision {
  return Object.freeze({
    outcome,
    code,
    explanation,
  });
}

function grantDecision(grant: OwnerGrant): PolicyDecision {
  const matchedGrant = Object.freeze({
    ...grant,
    scope: Object.freeze({ ...grant.scope }),
  });

  return Object.freeze({
    outcome: "allow",
    code: "POLICY_OWNER_GRANT",
    explanation: "An unexpired owner grant exactly authorizes this action category and scope.",
    matchedGrant,
  });
}
