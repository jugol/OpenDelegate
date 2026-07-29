import type { AgentAdapter, AgentModelCatalog } from "@opendelegate/agent-adapters";
import type { AgentBinding, AgentExecutionProfile } from "@opendelegate/configuration";
import { TaskExecutorError } from "@opendelegate/task-service";

/**
 * Resolves the exact model for a new Coordinator native session. The active
 * Coordinator adapter is composed during Main startup; the profile may select a
 * model on that adapter or an explicit fallback on the same adapter. Switching
 * the Coordinator provider requires the authenticated Main Agent reconfiguration
 * flow, while a Task that already owns a native session remains pinned by the
 * executor and never reaches this resolver.
 */
export async function resolveCoordinatorModelId(
  profile: AgentExecutionProfile,
  adapter: AgentAdapter,
): Promise<string | undefined> {
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
      throw unavailable("The active Coordinator Agent model catalog could not be refreshed.", true);
    }
    return catalog;
  };

  if (profile.mode === "auto") {
    if (adapter.provider === "generic" && adapter.listModels === undefined) {
      return undefined;
    }
    const models = (await readCatalog()).models;
    const selected = models.find((model) => model.isDefault === true) ?? models[0];
    if (selected === undefined) {
      throw unavailable("The active Coordinator Agent has no verified model.");
    }
    return selected.modelId;
  }

  const bindings: readonly AgentBinding[] =
    profile.mode === "prefer" ? [profile.primary, ...profile.fallbacks] : [profile.primary];
  const localBindings = bindings.filter(
    (binding) => binding.provider === adapter.provider && binding.adapterId === adapter.adapterId,
  );
  for (const binding of localBindings) {
    if (binding.modelId === undefined) {
      return undefined;
    }
    if ((await readCatalog()).models.some((model) => model.modelId === binding.modelId)) {
      return binding.modelId;
    }
  }

  throw unavailable(
    localBindings.length === 0
      ? "The Coordinator Agent profile selects a different provider or adapter than the active Main Agent. Reconfigure the Main Agent provider before starting a new Task."
      : "None of the Coordinator Agent profile's explicit model bindings is currently available.",
  );
}

function unavailable(message: string, retryable = false): TaskExecutorError {
  return new TaskExecutorError("MAIN_AGENT_PROFILE_UNAVAILABLE", message, retryable);
}
