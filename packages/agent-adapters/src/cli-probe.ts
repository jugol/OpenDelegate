import {
  AGENT_ADAPTER_CONTRACT_VERSION,
  type AgentAdapterProbe,
  type AgentAdapterRemediation,
  type AgentProvider,
} from "./contracts.ts";
import { AgentAdapterError } from "./errors.ts";
import { captureCommand, type SpawnCommand } from "./process-utils.ts";

export interface CliProbeOptions {
  readonly adapterId: string;
  readonly provider: AgentProvider;
  readonly providerLabel: string;
  readonly capabilities: AgentAdapterProbe["capabilities"];
  readonly versionCommand: SpawnCommand;
  readonly authCommand?: SpawnCommand;
  readonly testedVersions: readonly string[];
  readonly parseVersion: (output: string) => string;
  /** npm package this provider ships as, so an untested version names its remedy. */
  readonly packageName?: string;
  /** The sign-in this provider needs, so an unauthenticated adapter is actionable. */
  readonly signIn?: {
    readonly command: string;
    readonly homeVariable: string;
    readonly home: string;
    /** True when the bare command already reaches this home, so the remedy omits the variable. */
    readonly homeIsDefault?: boolean;
    /** A same-brand session that does not satisfy this probe, when the provider ships one. */
    readonly separateSession?: string;
  };
}

export async function probeCli(options: CliProbeOptions): Promise<AgentAdapterProbe> {
  let versionResult;
  try {
    versionResult = await captureCommand(options.versionCommand, 5_000, 64 * 1024);
  } catch (error) {
    const unavailable = isExecutableMissing(error);
    return {
      contractVersion: AGENT_ADAPTER_CONTRACT_VERSION,
      adapterId: options.adapterId,
      provider: options.provider,
      installed: false,
      compatibility: "incompatible",
      auth: { state: "unknown" },
      capabilities: options.capabilities,
      diagnostics: [
        {
          code: unavailable ? "EXECUTABLE_NOT_FOUND" : "PROBE_FAILED",
          message: unavailable
            ? `${options.providerLabel} executable was not found.`
            : `${options.providerLabel} could not be probed safely.`,
        },
      ],
    };
  }

  if (versionResult.timedOut || versionResult.exitCode !== 0) {
    return {
      contractVersion: AGENT_ADAPTER_CONTRACT_VERSION,
      adapterId: options.adapterId,
      provider: options.provider,
      installed: true,
      compatibility: "incompatible",
      auth: { state: "unknown" },
      capabilities: options.capabilities,
      diagnostics: [
        {
          code: versionResult.timedOut ? "PROBE_TIMEOUT" : "VERSION_PROBE_FAILED",
          message: `${options.providerLabel} did not return a usable version.`,
        },
      ],
    };
  }

  let version: string;
  try {
    version = options.parseVersion(versionResult.stdout);
  } catch (error) {
    const message =
      error instanceof AgentAdapterError
        ? error.message
        : `${options.providerLabel} returned an unrecognized version.`;
    return {
      contractVersion: AGENT_ADAPTER_CONTRACT_VERSION,
      adapterId: options.adapterId,
      provider: options.provider,
      installed: true,
      compatibility: "incompatible",
      auth: { state: "unknown" },
      capabilities: options.capabilities,
      diagnostics: [{ code: "UNRECOGNIZED_PROVIDER_VERSION", message }],
    };
  }

  const compatibility = options.testedVersions.includes(version) ? "tested" : "untested";
  let auth: AgentAdapterProbe["auth"] =
    options.authCommand === undefined ? { state: "not_required" } : { state: "unknown" };
  const diagnostics: { code: string; message: string }[] = [];
  if (options.authCommand !== undefined) {
    try {
      const authResult = await captureCommand(options.authCommand, 5_000, 64 * 1024);
      auth = {
        state: authResult.exitCode === 0 && !authResult.timedOut ? "ready" : "not_ready",
      };
      if (authResult.timedOut) {
        diagnostics.push({
          code: "AUTH_PROBE_TIMEOUT",
          message: `${options.providerLabel} authentication probe timed out.`,
        });
      } else if (authResult.exitCode !== 0) {
        diagnostics.push({
          code: "AUTH_NOT_READY",
          message:
            options.signIn === undefined
              ? `${options.providerLabel} is not signed in.`
              : signInRemedy(options.providerLabel, options.signIn),
        });
      }
    } catch {
      auth = { state: "unknown" };
      diagnostics.push({
        code: "AUTH_PROBE_FAILED",
        message: `${options.providerLabel} authentication could not be probed safely.`,
      });
    }
  }
  if (compatibility === "untested") {
    diagnostics.push({
      code: "UNTESTED_PROVIDER_VERSION",
      message: `${options.providerLabel} ${version} has not passed this adapter's contract suite.`,
    });
  }
  return {
    contractVersion: AGENT_ADAPTER_CONTRACT_VERSION,
    adapterId: options.adapterId,
    provider: options.provider,
    installed: true,
    version,
    compatibility,
    auth,
    capabilities: options.capabilities,
    diagnostics,
    ...(compatibility === "untested"
      ? providerUpgradeRemediation(options.packageName, options.testedVersions, version)
      : {}),
  };
}

/**
 * States which sign-in is missing, precisely enough to act on.
 *
 * A provider keeps one credential per home, so the remedy names the directory
 * whenever the bare command would not reach it. It also names any same-brand
 * session that does not count: an owner looking at a signed-in desktop app reads
 * "not signed in" as a false report rather than as a CLI they have yet to
 * authenticate.
 */
function signInRemedy(
  providerLabel: string,
  signIn: NonNullable<CliProbeOptions["signIn"]>,
): string {
  const invocation =
    signIn.homeIsDefault === true
      ? signIn.command
      : `${signIn.command} with ${signIn.homeVariable}=${signIn.home}`;
  return (
    `${providerLabel} is not signed in on this Device. Run ${invocation} in a terminal ` +
    `and complete the sign-in there.` +
    (signIn.separateSession === undefined ? "" : ` ${signIn.separateSession}`)
  );
}

/**
 * Names the exact upgrade that would clear an untested version. Absent when the
 * adapter declares no package or no tested version, because a remedy that cannot
 * be stated is worse than none.
 */
export function providerUpgradeRemediation(
  packageName: string | undefined,
  testedVersions: readonly string[],
  installedVersion: string,
): { readonly remediation: AgentAdapterRemediation } | Record<string, never> {
  const targetVersion = testedVersions.at(-1);
  if (packageName === undefined || targetVersion === undefined) {
    return {};
  }
  return {
    remediation: {
      kind: "upgrade-provider",
      packageManager: "npm",
      packageName,
      targetVersion,
      installedVersion,
    },
  };
}

function isExecutableMissing(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
