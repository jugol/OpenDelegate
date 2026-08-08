import type { AgentAdapter, AgentModelCatalog } from "@opendelegate/agent-adapters";
import type { AgentBinding, AgentExecutionProfile } from "@opendelegate/configuration";
import { TaskExecutorError } from "@opendelegate/task-service";

/** The exact model and provider tuning a new Coordinator session will use. */
export interface CoordinatorSessionBinding {
  readonly modelId?: string;
  readonly effort?: string;
}

/**
 * Resolves the exact binding for a new Coordinator native session. The active
 * Coordinator adapter is composed during Main startup; the profile may select a
 * model on that adapter or an explicit fallback on the same adapter. Switching
 * the Coordinator provider requires the authenticated Main Agent reconfiguration
 * flow, while a Task that already owns a native session remains pinned by the
 * executor and never reaches this resolver.
 *
 * A binding whose effort is not advertised by its model is treated as
 * unavailable rather than silently dropped, so a Prefer chain moves to its next
 * explicit entry and a Pinned profile fails closed.
 */
export async function resolveCoordinatorSessionBinding(
  profile: AgentExecutionProfile,
  adapter: AgentAdapter,
): Promise<CoordinatorSessionBinding> {
  let catalog: AgentModelCatalog | undefined;
  const readCatalog = async (): Promise<AgentModelCatalog> => {
    if (catalog !== undefined) {
      return catalog;
    }
    if (adapter.listModels === undefined) {
      throw unavailable(
        "The active Coordinator Agent Adapter does not expose a verified model catalog.",
      );
    }
    try {
      catalog = await adapter.listModels();
    } catch {
      throw unavailable(
        "The active Coordinator Agent model catalog could not be refreshed.",
        "failure",
      );
    }
    return catalog;
  };

  if (profile.mode === "auto") {
    if (adapter.provider === "generic" && adapter.listModels === undefined) {
      return {};
    }
    const models = (await readCatalog()).models;
    const selected = models.find((model) => model.isDefault === true) ?? models[0];
    if (selected === undefined) {
      throw unavailable("The active Coordinator Agent has no verified model.");
    }
    // Auto leaves tuning to the provider default rather than inventing one.
    return { modelId: selected.modelId };
  }

  const bindings: readonly AgentBinding[] =
    profile.mode === "prefer" ? [profile.primary, ...profile.fallbacks] : [profile.primary];
  const localBindings = bindings.filter(
    (binding) => binding.provider === adapter.provider && binding.adapterId === adapter.adapterId,
  );
  let rejectedEffort = false;
  for (const binding of localBindings) {
    if (binding.modelId === undefined) {
      return binding.effort === undefined ? {} : { effort: binding.effort };
    }
    const model = (await readCatalog()).models.find(
      (candidate) => candidate.modelId === binding.modelId,
    );
    if (model === undefined) {
      continue;
    }
    if (binding.effort !== undefined && !(model.supportedEfforts ?? []).includes(binding.effort)) {
      rejectedEffort = true;
      continue;
    }
    return {
      modelId: binding.modelId,
      ...(binding.effort === undefined ? {} : { effort: binding.effort }),
    };
  }

  throw unavailable(
    localBindings.length === 0
      ? "The Coordinator Agent profile selects a different provider or adapter than the active Main Agent. Reconfigure the Main Agent provider before starting a new Task."
      : rejectedEffort
        ? "None of the Coordinator Agent profile's explicit bindings names a currently advertised model and reasoning effort."
        : "None of the Coordinator Agent profile's explicit model bindings is currently available.",
  );
}

function unavailable(
  message: string,
  retryKind: "failure" | "resource" = "resource",
): TaskExecutorError {
  return new TaskExecutorError("MAIN_AGENT_PROFILE_UNAVAILABLE", message, true, { retryKind });
}
