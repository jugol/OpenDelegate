import type { ConfigurationDiff } from "@opendelegate/configuration";

import type {
  ConfigurationApplyLifecycle,
  PreparedConfigurationApply,
} from "./configuration-approval.ts";
import type {
  DiscordBindingController,
  DiscordBindingRuntime,
} from "./discord-binding-controller.ts";
import {
  MAIN_DISCORD_BINDING_CONFIGURATION_KEY,
  validateMainDiscordBindingConfiguration,
  type MainDiscordBindingConfiguration,
} from "./discord-configuration.ts";

/**
 * Late binding lets the Approval service be composed before artifact and
 * Discord runtimes while still guaranteeing that an approved Discord change
 * cannot commit without a matching serialized Gateway transition.
 */
export class DiscordBindingConfigurationLifecycle implements ConfigurationApplyLifecycle {
  readonly #mainDeviceId: string;
  #controller: DiscordBindingController<DiscordBindingRuntime> | undefined;

  public constructor(mainDeviceId: string) {
    if (
      typeof mainDeviceId !== "string" ||
      mainDeviceId.trim() !== mainDeviceId ||
      mainDeviceId.length === 0 ||
      mainDeviceId.length > 200 ||
      mainDeviceId.includes("\0")
    ) {
      throw new TypeError("A valid Main Device ID is required.");
    }
    this.#mainDeviceId = mainDeviceId;
  }

  public bind<TRuntime extends DiscordBindingRuntime>(
    controller: DiscordBindingController<TRuntime>,
  ): void {
    if (
      this.#controller !== undefined ||
      controller === null ||
      typeof controller !== "object" ||
      typeof controller.prepare !== "function"
    ) {
      throw new TypeError("The Discord binding Configuration lifecycle cannot be rebound.");
    }
    this.#controller = controller;
  }

  public async prepare(input: {
    readonly diff: readonly ConfigurationDiff[];
  }): Promise<PreparedConfigurationApply | undefined> {
    const discordChanges = input.diff.filter(
      (change) => change.key === MAIN_DISCORD_BINDING_CONFIGURATION_KEY,
    );
    if (discordChanges.length === 0) {
      return undefined;
    }
    if (discordChanges.length !== 1) {
      throw new Error("A Configuration mutation contains multiple Discord binding changes.");
    }
    const change = discordChanges[0]!;
    if (change.scope.kind !== "main" || change.scope.id !== this.#mainDeviceId) {
      throw new Error("The Discord binding Configuration scope does not match this Main.");
    }
    const controller = this.#controller;
    if (controller === undefined) {
      throw new Error("The Discord binding runtime lifecycle is not ready.");
    }
    return controller.prepare(bindingAfter(change));
  }
}

function bindingAfter(change: ConfigurationDiff): MainDiscordBindingConfiguration | null {
  if (change.after === undefined) {
    throw new Error(
      "Discord disable must persist an explicit null binding; discord.binding cannot be unset.",
    );
  }
  if (change.after === null) {
    return null;
  }
  return validateMainDiscordBindingConfiguration(change.after);
}
