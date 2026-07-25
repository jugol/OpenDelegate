import type {
  ConfigurationContext,
  ConfigurationService,
  EffectiveConfigurationValue,
} from "@opendelegate/configuration";

import type {
  MainArtifactPreparePolicyDecision,
  MainArtifactPreparePolicyPort,
} from "./artifact-prepare-service.ts";
import type {
  MainConfiguredActionPolicyDecision,
  MainConfiguredActionPolicyPort,
} from "./action-authorization-runtime.ts";
import type {
  RouteIncidentDiagnosticAgentInput,
  RouteIncidentDiagnosticAgentPort,
} from "./route-incident-diagnosis.ts";

export type MainTaskDefaultMode = "auto" | "manual";
export type MainAutonomyProfile = "reactive" | "assisted" | "autonomous";
export type MainProactiveWorkKind =
  | "incident-recovery"
  | "maintenance"
  | "capability-expansion"
  | "cleanup"
  | "cost-incurring-work"
  | "general-improvement";
export type MainProactiveDisposition = "disabled" | "propose" | "execute";
export type MainArtifactExposureMode =
  "private-network" | "authenticated" | "signed-link" | "public" | "custom";
export type MainRouteAgentEscalation = "after-route-exhaustion" | "disabled";
export const MAIN_OWNER_TASK_DEFAULT_SCOPE_ID = "owner-default";

export class MainConfigurationRuntimePolicyError extends Error {
  public readonly code = "CONFIGURATION_RUNTIME_POLICY_UNAVAILABLE";

  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MainConfigurationRuntimePolicyError";
  }
}

export interface MainConfigurationRuntimePolicyOptions {
  readonly service: Pick<ConfigurationService, "inspect">;
  readonly instanceId: string;
  readonly mainDeviceId: string;
  readonly taskDefaultId: string;
}

/**
 * Resolves only the small, typed settings needed by deterministic runtime
 * boundaries. Every call consults ConfigurationService again so newly committed
 * values take effect for the next operation without exposing unrelated settings.
 */
export class MainConfigurationRuntimePolicy {
  readonly #service: Pick<ConfigurationService, "inspect">;
  readonly #baseContext: Pick<ConfigurationContext, "instanceId" | "mainId">;
  readonly #mainDeviceId: string;
  readonly #taskDefaultId: string;

  public constructor(options: MainConfigurationRuntimePolicyOptions) {
    if (
      options.service === null ||
      typeof options.service !== "object" ||
      typeof options.service.inspect !== "function"
    ) {
      throw new TypeError("A Configuration Service inspection port is required.");
    }
    this.#service = options.service;
    this.#mainDeviceId = requireScopeId(options.mainDeviceId, "Main Device ID");
    this.#baseContext = Object.freeze({
      instanceId: requireScopeId(options.instanceId, "Instance ID"),
      mainId: this.#mainDeviceId,
    });
    this.#taskDefaultId = requireScopeId(options.taskDefaultId, "Task-default scope ID");
  }

  public async taskDefaultMode(): Promise<MainTaskDefaultMode> {
    const effective = await this.#inspect({
      ...this.#baseContext,
      deviceId: this.#mainDeviceId,
      taskDefaultId: this.#taskDefaultId,
    });
    return requireOneOf(effective["task.default-mode"], "task.default-mode", [
      "auto",
      "manual",
    ] as const);
  }

  public async autonomyProfile(options?: {
    readonly deviceId?: string;
  }): Promise<MainAutonomyProfile> {
    const effective = await this.#inspect({
      ...this.#baseContext,
      deviceId:
        options?.deviceId === undefined
          ? this.#mainDeviceId
          : requireScopeId(options.deviceId, "Device ID"),
    });
    return requireOneOf(effective["autonomy.profile"], "autonomy.profile", [
      "reactive",
      "assisted",
      "autonomous",
    ] as const);
  }

  /**
   * This decides whether OpenDelegate may originate proactive work. It never
   * authorizes the work's actions, which remain subject to the current Action
   * Policy, approvals, and budgets immediately before execution.
   */
  public async proactiveDisposition(
    kind: MainProactiveWorkKind,
    options?: { readonly deviceId?: string },
  ): Promise<MainProactiveDisposition> {
    requireProactiveWorkKind(kind);
    const profile = await this.autonomyProfile(options);
    switch (profile) {
      case "reactive":
        return kind === "incident-recovery" ? "propose" : "disabled";
      case "assisted":
        return kind === "incident-recovery" ? "execute" : "propose";
      case "autonomous":
        return "execute";
    }
  }

  public async resolveArtifactPreparation(
    input: Parameters<MainArtifactPreparePolicyPort["resolve"]>[0],
  ): Promise<MainArtifactPreparePolicyDecision> {
    const effective = await this.#inspect({
      ...this.#baseContext,
      deviceId: requireScopeId(input.authenticatedDeviceId, "Artifact Device ID"),
      taskDefaultId: this.#taskDefaultId,
      artifactId: requireScopeId(input.manifest.artifactId, "Artifact ID"),
    });
    const exposureMode = requireOneOf(effective["artifact.exposure"], "artifact.exposure", [
      "private-network",
      "authenticated",
      "signed-link",
      "public",
      "custom",
    ] as const);
    const interactiveHtml = requireBoolean(
      effective["artifact.interactive-html"],
      "artifact.interactive-html",
    );
    const requested = input.manifest.requestedPresentation;
    if (
      exposureMode === "custom" ||
      (requested === "interactive-html" && !interactiveHtml) ||
      ((requested === "interactive-html" || requested === "static-html") &&
        input.manifest.mediaType !== "text/html")
    ) {
      return Object.freeze({ status: "rejected", retryable: false });
    }
    const presentation =
      requested ??
      (input.manifest.mediaType === "text/html"
        ? "static-html"
        : input.manifest.mediaType === "image/svg+xml"
          ? "download"
          : input.manifest.mediaType.startsWith("image/") ||
              input.manifest.mediaType === "application/pdf" ||
              input.manifest.mediaType.startsWith("text/")
            ? "inline"
            : "download");
    return Object.freeze({
      status: "allowed",
      retentionPolicy: Object.freeze({ kind: "task" as const }),
      exposurePolicy: Object.freeze({ mode: exposureMode }),
      presentation,
    });
  }

  public async configuredActionDecision(
    input: Parameters<MainConfiguredActionPolicyPort["decide"]>[0],
  ): Promise<MainConfiguredActionPolicyDecision> {
    const settingKey =
      input.actionCategory === "configured-official-package-install"
        ? "policy.official-package-install"
        : input.actionCategory === "os-network-change" ||
            input.actionCategory === "vpn-change" ||
            input.actionCategory === "firewall-change"
          ? "policy.network-change"
          : undefined;
    if (settingKey === undefined) {
      return undefined;
    }
    const effective = await this.#inspect({
      ...this.#baseContext,
      deviceId: requireScopeId(input.deviceId, "Action Device ID"),
    });
    return requireOneOf(effective[settingKey], settingKey, [
      "allow",
      "require-approval",
      "deny",
    ] as const);
  }

  public async routeAgentEscalation(options: {
    readonly deviceId: string;
    readonly transportId?: string;
  }): Promise<MainRouteAgentEscalation> {
    const effective = await this.#inspect({
      ...this.#baseContext,
      deviceId: requireScopeId(options.deviceId, "Route Device ID"),
      ...(options.transportId === undefined
        ? {}
        : {
            transportId: requireScopeId(options.transportId, "Route Transport ID"),
          }),
    });
    return requireOneOf(effective["transport.agent-escalation"], "transport.agent-escalation", [
      "after-route-exhaustion",
      "disabled",
    ] as const);
  }

  async #inspect(
    context: ConfigurationContext,
  ): Promise<Readonly<Record<string, EffectiveConfigurationValue>>> {
    try {
      return await this.#service.inspect(context);
    } catch (error) {
      throw new MainConfigurationRuntimePolicyError(
        "The current effective Configuration could not be inspected.",
        { cause: error },
      );
    }
  }
}

export function createConfigurationMainArtifactPreparePolicy(
  runtime: MainConfigurationRuntimePolicy,
): MainArtifactPreparePolicyPort {
  if (!(runtime instanceof MainConfigurationRuntimePolicy)) {
    throw new TypeError("A Main Configuration runtime policy is required.");
  }
  return Object.freeze<MainArtifactPreparePolicyPort>({
    resolve: (input: Parameters<MainArtifactPreparePolicyPort["resolve"]>[0]) =>
      runtime.resolveArtifactPreparation(input),
  });
}

export function createConfigurationMainActionPolicy(
  runtime: MainConfigurationRuntimePolicy,
): MainConfiguredActionPolicyPort {
  if (!(runtime instanceof MainConfigurationRuntimePolicy)) {
    throw new TypeError("A Main Configuration runtime policy is required.");
  }
  return Object.freeze<MainConfiguredActionPolicyPort>({
    decide: (input: Parameters<MainConfiguredActionPolicyPort["decide"]>[0]) =>
      runtime.configuredActionDecision(input),
  });
}

export function createConfigurationControlledRouteDiagnosticAgent(options: {
  readonly runtime: MainConfigurationRuntimePolicy;
  readonly agent: RouteIncidentDiagnosticAgentPort;
  /**
   * The redacted route-incident protocol does not carry a Configuration
   * transport scope ID. Composition may supply a deterministic local mapping
   * when it has that identity; otherwise Instance and Device scopes apply.
   */
  readonly transportIdForIncident?: (
    input: RouteIncidentDiagnosticAgentInput,
  ) => string | undefined;
}): RouteIncidentDiagnosticAgentPort {
  if (!(options.runtime instanceof MainConfigurationRuntimePolicy)) {
    throw new TypeError("A Main Configuration runtime policy is required.");
  }
  if (
    options.agent === null ||
    typeof options.agent !== "object" ||
    typeof options.agent.diagnose !== "function" ||
    (options.transportIdForIncident !== undefined &&
      typeof options.transportIdForIncident !== "function")
  ) {
    throw new TypeError("A route diagnostic Agent policy composition is invalid.");
  }
  return Object.freeze<RouteIncidentDiagnosticAgentPort>({
    async diagnose(input: RouteIncidentDiagnosticAgentInput): Promise<unknown> {
      const transportId = options.transportIdForIncident?.(input);
      const decision = await options.runtime.routeAgentEscalation({
        deviceId: input.authenticatedDeviceId,
        ...(transportId === undefined ? {} : { transportId }),
      });
      if (decision === "disabled") {
        throw new MainConfigurationRuntimePolicyError(
          "Route Agent escalation is disabled by the current Configuration.",
        );
      }
      return await options.agent.diagnose(input);
    },
  });
}

function requireOneOf<const T extends readonly string[]>(
  effective: EffectiveConfigurationValue | undefined,
  key: string,
  allowed: T,
): T[number] {
  if (effective === undefined || !allowed.includes(effective.value as string)) {
    throw new MainConfigurationRuntimePolicyError(
      `The effective ${key} setting is unavailable or invalid.`,
    );
  }
  return effective.value as T[number];
}

function requireBoolean(effective: EffectiveConfigurationValue | undefined, key: string): boolean {
  if (effective === undefined || typeof effective.value !== "boolean") {
    throw new MainConfigurationRuntimePolicyError(
      `The effective ${key} setting is unavailable or invalid.`,
    );
  }
  return effective.value;
}

function requireScopeId(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 200 ||
    value !== value.trim() ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    })
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function requireProactiveWorkKind(value: unknown): asserts value is MainProactiveWorkKind {
  if (
    value !== "incident-recovery" &&
    value !== "maintenance" &&
    value !== "capability-expansion" &&
    value !== "cleanup" &&
    value !== "cost-incurring-work" &&
    value !== "general-improvement"
  ) {
    throw new TypeError("The proactive work kind is invalid.");
  }
}
