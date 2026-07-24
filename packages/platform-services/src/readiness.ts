export type HelperProcessState = "running" | "stopped" | "unknown";
export type DesktopPermissionState = "denied" | "granted" | "unknown";
export type SessionHelperState =
  | "helper-unavailable"
  | "locked"
  | "logged-out"
  | "permission-denied"
  | "permission-unavailable"
  | "ready";

export interface SessionPermissionReadiness {
  readonly accessibility: DesktopPermissionState;
  readonly input: DesktopPermissionState;
  readonly screenCapture: DesktopPermissionState;
}

export interface SessionHelperObservation {
  readonly helperProcess: HelperProcessState;
  readonly loggedIn: boolean;
  readonly desktopUnlocked: boolean;
  readonly permissions: SessionPermissionReadiness;
}

export interface SessionHelperReadiness {
  readonly session: SessionHelperState;
  readonly computerUse: "ready" | "unavailable";
  readonly headlessWorkAvailable: true;
  readonly helperProcess: HelperProcessState;
  readonly loggedIn: boolean;
  readonly desktopUnlocked: boolean;
  readonly permissions: SessionPermissionReadiness;
  readonly missingPermissions: readonly (keyof SessionPermissionReadiness)[];
  readonly reason: string;
}

const PERMISSION_ORDER = [
  "accessibility",
  "input",
  "screenCapture",
] as const satisfies readonly (keyof SessionPermissionReadiness)[];

export function evaluateSessionHelperReadiness(
  observation: SessionHelperObservation,
): SessionHelperReadiness {
  const missingPermissions = PERMISSION_ORDER.filter(
    (permission) => observation.permissions[permission] !== "granted",
  );
  const base = {
    computerUse: "unavailable" as const,
    headlessWorkAvailable: true as const,
    helperProcess: observation.helperProcess,
    loggedIn: observation.loggedIn,
    desktopUnlocked: observation.desktopUnlocked,
    permissions: observation.permissions,
    missingPermissions,
  };
  if (!observation.loggedIn) {
    return {
      ...base,
      session: "logged-out",
      reason: "No owner session is logged in; the core remains available for headless work.",
    };
  }
  if (observation.helperProcess !== "running") {
    return {
      ...base,
      session: "helper-unavailable",
      reason: "The owner is logged in but the per-user session helper is not running.",
    };
  }
  if (!observation.desktopUnlocked) {
    return {
      ...base,
      session: "locked",
      reason: "The graphical session is locked; active desktop input remains unavailable.",
    };
  }
  if (missingPermissions.length > 0) {
    const denied = missingPermissions.some(
      (permission) => observation.permissions[permission] === "denied",
    );
    return {
      ...base,
      session: denied ? "permission-denied" : "permission-unavailable",
      reason: denied
        ? "One or more required desktop permissions were denied."
        : "One or more required desktop permissions have not been verified.",
    };
  }
  return {
    ...base,
    session: "ready",
    computerUse: "ready",
    reason: "The owner session helper is unlocked and permission-ready.",
  };
}
