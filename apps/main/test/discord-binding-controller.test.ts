import assert from "node:assert/strict";
import test from "node:test";

import { DiscordBindingConfigurationLifecycle } from "../src/discord-binding-configuration-lifecycle.ts";
import {
  DiscordBindingController,
  DiscordBindingControllerError,
  type DiscordBindingActivationScheduler,
  type DiscordBindingRuntime,
} from "../src/discord-binding-controller.ts";
import {
  MAIN_DISCORD_BINDING_CONFIGURATION_KEY,
  isMainDiscordBindingConfiguration,
  type MainDiscordBindingConfiguration,
} from "../src/discord-configuration.ts";

const FIRST_BINDING = binding("11111111111111111", "22222222222222222");
const SECOND_BINDING = binding("33333333333333333", "44444444444444444");
const DISCORD_BOT_TOKEN_AVAILABLE = Object.freeze({
  purpose: "discord-bot-token" as const,
  available: true,
});

test("dynamic Discord binding values contain no platform backend or raw credential", () => {
  assert.equal(isMainDiscordBindingConfiguration(null), true);
  assert.equal(isMainDiscordBindingConfiguration(FIRST_BINDING), true);
  assert.equal(
    isMainDiscordBindingConfiguration({
      ...FIRST_BINDING,
      secretBackend: {
        backend: "windows-dpapi",
        vaultRoot: "C:\\must-not-be-part-of-the-dynamic-binding",
      },
    }),
    false,
  );
  assert.equal(
    isMainDiscordBindingConfiguration({
      ...FIRST_BINDING,
      botTokenAlias: "secret://main/discord-token",
    }),
    false,
  );
});

test("a prepared Discord replacement can be rolled back before durable commit", async () => {
  const created: FakeDiscordRuntime[] = [];
  const controller = new DiscordBindingController<FakeDiscordRuntime>({
    credentialCapability: async () => DISCORD_BOT_TOKEN_AVAILABLE,
    createRuntime: async (configuration, onStatusChange) => {
      const runtime = new FakeDiscordRuntime(configuration.botTokenAlias, "ready", onStatusChange);
      created.push(runtime);
      return runtime;
    },
  });
  await controller.start(FIRST_BINDING);
  const firstRuntime = controller.runtime;

  const transition = await controller.prepare(SECOND_BINDING);
  assert.equal(firstRuntime?.closed, true);
  assert.equal(controller.configuration?.botTokenAlias, SECOND_BINDING.botTokenAlias);
  assert.equal(controller.runtime?.started, true);

  await transition.rollback();
  assert.equal(controller.configuration?.botTokenAlias, FIRST_BINDING.botTokenAlias);
  assert.equal(controller.runtime?.started, true);
  assert.notEqual(controller.runtime, firstRuntime);
  assert.equal(created.length, 3);

  await controller.close();
});

test("rollback keeps an unavailable previous binding alive in its authoritative retry loop", async () => {
  const controller = new DiscordBindingController<FakeDiscordRuntime>({
    credentialCapability: async () => DISCORD_BOT_TOKEN_AVAILABLE,
    createRuntime: async (configuration, onStatusChange) =>
      new FakeDiscordRuntime(
        configuration.botTokenAlias,
        configuration.botTokenAlias === FIRST_BINDING.botTokenAlias ? "unavailable" : "ready",
        onStatusChange,
      ),
  });
  await controller.start(FIRST_BINDING);
  assert.equal(controller.runtime?.status.code, "DISCORD_UNAVAILABLE");

  const transition = await controller.prepare(SECOND_BINDING);
  assert.equal(controller.runtime?.status.code, "DISCORD_READY");
  await transition.rollback();

  assert.equal(controller.configuration?.botTokenAlias, FIRST_BINDING.botTokenAlias);
  assert.equal(controller.runtime?.status.code, "DISCORD_UNAVAILABLE");
  assert.equal(controller.runtime?.closed, false);
  await controller.close();
});

test("the Configuration lifecycle transitions only the exact Main Discord binding", async () => {
  const controller = new DiscordBindingController<FakeDiscordRuntime>({
    credentialCapability: async () => DISCORD_BOT_TOKEN_AVAILABLE,
    createRuntime: async (configuration, onStatusChange) =>
      new FakeDiscordRuntime(configuration.botTokenAlias, "ready", onStatusChange),
  });
  await controller.start(FIRST_BINDING);
  const lifecycle = new DiscordBindingConfigurationLifecycle("device_main");
  lifecycle.bind(controller);

  assert.equal(
    await lifecycle.prepare({
      diff: [
        {
          key: "artifact.exposure",
          scope: { kind: "main", id: "device_main" },
          before: "private-network",
          after: "authenticated",
        },
      ],
    }),
    undefined,
  );

  const prepared = await lifecycle.prepare({
    diff: [
      {
        key: MAIN_DISCORD_BINDING_CONFIGURATION_KEY,
        scope: { kind: "main", id: "device_main" },
        before: FIRST_BINDING,
        after: SECOND_BINDING,
      },
    ],
  });
  assert.equal(controller.configuration?.botTokenAlias, SECOND_BINDING.botTokenAlias);
  await prepared?.rollback();
  assert.equal(controller.configuration?.botTokenAlias, FIRST_BINDING.botTokenAlias);

  await assert.rejects(
    lifecycle.prepare({
      diff: [
        {
          key: MAIN_DISCORD_BINDING_CONFIGURATION_KEY,
          scope: { kind: "main", id: "another_main" },
          before: FIRST_BINDING,
          after: SECOND_BINDING,
        },
      ],
    }),
    /scope does not match this Main/u,
  );
  await assert.rejects(
    lifecycle.prepare({
      diff: [
        {
          key: MAIN_DISCORD_BINDING_CONFIGURATION_KEY,
          scope: { kind: "main", id: "device_main" },
          before: FIRST_BINDING,
          after: undefined,
        },
      ],
    }),
    /must persist an explicit null/u,
  );

  await controller.close();
});

test("the authoritative startup binding remains alive for its retry loop while Discord is unavailable", async () => {
  const controller = new DiscordBindingController<FakeDiscordRuntime>({
    credentialCapability: async () => DISCORD_BOT_TOKEN_AVAILABLE,
    createRuntime: async (configuration, onStatusChange) =>
      new FakeDiscordRuntime(configuration.botTokenAlias, "unavailable", onStatusChange),
  });

  await controller.start(FIRST_BINDING);

  assert.equal(controller.configuration?.botTokenAlias, FIRST_BINDING.botTokenAlias);
  assert.equal(controller.runtime?.started, true);
  assert.equal(controller.runtime?.closed, false);
  assert.equal(controller.runtime?.status.code, "DISCORD_UNAVAILABLE");

  await controller.close();
});

test("a failed Discord replacement restores the previously working binding", async () => {
  const statuses: string[] = [];
  const controller = new DiscordBindingController<FakeDiscordRuntime>({
    credentialCapability: async () => DISCORD_BOT_TOKEN_AVAILABLE,
    createRuntime: async (configuration, onStatusChange) =>
      new FakeDiscordRuntime(
        configuration.botTokenAlias,
        configuration.botTokenAlias === SECOND_BINDING.botTokenAlias ? "unavailable" : "ready",
        onStatusChange,
      ),
    onStatusChange: (status) => statuses.push(status.code),
  });
  await controller.start(FIRST_BINDING);

  await assert.rejects(
    controller.prepare(SECOND_BINDING),
    (error: unknown) =>
      error instanceof DiscordBindingControllerError &&
      error.code === "DISCORD_BINDING_ACTIVATION_FAILED",
  );
  assert.equal(controller.configuration?.botTokenAlias, FIRST_BINDING.botTokenAlias);
  assert.equal(controller.runtime?.started, true);
  assert.equal(controller.runtime?.closed, false);
  assert.ok(statuses.includes("DISCORD_STARTING"));
  assert.equal(statuses.at(-1), "DISCORD_READY");

  await controller.close();
});

test("a Discord replacement is not committed until its Gateway confirms READY", async () => {
  const controller = new DiscordBindingController<FakeDiscordRuntime>({
    credentialCapability: async () => DISCORD_BOT_TOKEN_AVAILABLE,
    createRuntime: async (configuration, onStatusChange) =>
      new FakeDiscordRuntime(
        configuration.botTokenAlias,
        configuration.botTokenAlias === SECOND_BINDING.botTokenAlias ? "delayed-ready" : "ready",
        onStatusChange,
      ),
    activationTimeoutMs: 100,
  });
  await controller.start(FIRST_BINDING);

  const transition = await controller.prepare(SECOND_BINDING);

  assert.equal(controller.configuration?.botTokenAlias, SECOND_BINDING.botTokenAlias);
  assert.equal(controller.runtime?.status.code, "DISCORD_READY");
  await transition.commit();
  await controller.close();
});

test("a prepared replacement that loses READY is rejected before durable commit", async () => {
  const controller = new DiscordBindingController<FakeDiscordRuntime>({
    credentialCapability: async () => DISCORD_BOT_TOKEN_AVAILABLE,
    createRuntime: async (configuration, onStatusChange) =>
      new FakeDiscordRuntime(configuration.botTokenAlias, "ready", onStatusChange),
  });
  await controller.start(FIRST_BINDING);

  const transition = await controller.prepare(SECOND_BINDING);
  const candidate = controller.runtime;
  candidate?.becomeUnavailable();

  await assert.rejects(transition.commit(), /no longer READY/u);
  await transition.rollback();
  assert.equal(candidate?.closed, true);
  assert.equal(controller.configuration?.botTokenAlias, FIRST_BINDING.botTokenAlias);
  assert.equal(controller.runtime?.status.code, "DISCORD_READY");
  await controller.close();
});

test("a replacement that never reaches READY times out and restores the previous binding", async () => {
  const scheduler = new ManualActivationScheduler();
  let candidate: FakeDiscordRuntime | undefined;
  const controller = new DiscordBindingController<FakeDiscordRuntime>({
    credentialCapability: async () => DISCORD_BOT_TOKEN_AVAILABLE,
    createRuntime: async (configuration, onStatusChange) => {
      const runtime = new FakeDiscordRuntime(
        configuration.botTokenAlias,
        configuration.botTokenAlias === SECOND_BINDING.botTokenAlias ? "starting" : "ready",
        onStatusChange,
      );
      if (configuration.botTokenAlias === SECOND_BINDING.botTokenAlias) {
        candidate = runtime;
      }
      return runtime;
    },
    activationTimeoutMs: 100,
    scheduler,
  });
  await controller.start(FIRST_BINDING);

  const preparation = controller.prepare(SECOND_BINDING);
  await waitForCondition(() => candidate?.started === true && scheduler.pendingTimerCount > 0);
  scheduler.advanceBy(100);
  await assert.rejects(
    preparation,
    (error: unknown) =>
      error instanceof DiscordBindingControllerError &&
      error.code === "DISCORD_BINDING_ACTIVATION_FAILED" &&
      /did not complete/u.test(error.message),
  );
  assert.equal(controller.configuration?.botTokenAlias, FIRST_BINDING.botTokenAlias);
  assert.equal(controller.runtime?.status.code, "DISCORD_READY");
  await controller.close();
});

test("a replacement cannot commit a stale READY after startup finishes unavailable", async () => {
  const controller = new DiscordBindingController<FakeDiscordRuntime>({
    credentialCapability: async () => DISCORD_BOT_TOKEN_AVAILABLE,
    createRuntime: async (configuration, onStatusChange) =>
      new FakeDiscordRuntime(
        configuration.botTokenAlias,
        configuration.botTokenAlias === SECOND_BINDING.botTokenAlias
          ? "ready-then-unavailable"
          : "ready",
        onStatusChange,
      ),
  });
  await controller.start(FIRST_BINDING);

  await assert.rejects(
    controller.prepare(SECOND_BINDING),
    (error: unknown) =>
      error instanceof DiscordBindingControllerError &&
      error.code === "DISCORD_BINDING_ACTIVATION_FAILED",
  );
  assert.equal(controller.configuration?.botTokenAlias, FIRST_BINDING.botTokenAlias);
  assert.equal(controller.runtime?.status.code, "DISCORD_READY");
  await controller.close();
});

test("the activation deadline covers a replacement whose start call never settles", async () => {
  const scheduler = new ManualActivationScheduler();
  let candidate: FakeDiscordRuntime | undefined;
  const controller = new DiscordBindingController<FakeDiscordRuntime>({
    credentialCapability: async () => DISCORD_BOT_TOKEN_AVAILABLE,
    createRuntime: async (configuration, onStatusChange) => {
      const runtime = new FakeDiscordRuntime(
        configuration.botTokenAlias,
        configuration.botTokenAlias === SECOND_BINDING.botTokenAlias ? "hanging-start" : "ready",
        onStatusChange,
      );
      if (configuration.botTokenAlias === SECOND_BINDING.botTokenAlias) {
        candidate = runtime;
      }
      return runtime;
    },
    activationTimeoutMs: 100,
    scheduler,
  });
  await controller.start(FIRST_BINDING);

  const preparation = controller.prepare(SECOND_BINDING);
  await waitForCondition(() => candidate?.started === true && scheduler.pendingTimerCount > 0);
  scheduler.advanceBy(100);
  await assert.rejects(preparation, /did not complete within 100 ms/u);
  assert.equal(candidate?.closed, true);
  assert.equal(controller.configuration?.botTokenAlias, FIRST_BINDING.botTokenAlias);
  assert.equal(controller.runtime?.status.code, "DISCORD_READY");
  await controller.close();
});

test("the activation deadline covers replacement credential capability lookup", async () => {
  const scheduler = new ManualActivationScheduler();
  const controller = new DiscordBindingController<FakeDiscordRuntime>({
    credentialCapability: async (alias) =>
      alias === FIRST_BINDING.botTokenAlias
        ? DISCORD_BOT_TOKEN_AVAILABLE
        : new Promise(() => undefined),
    createRuntime: async (configuration, onStatusChange) =>
      new FakeDiscordRuntime(configuration.botTokenAlias, "ready", onStatusChange),
    activationTimeoutMs: 100,
    scheduler,
  });
  await controller.start(FIRST_BINDING);

  const preparation = controller.prepare(SECOND_BINDING);
  await waitForCondition(() => scheduler.pendingTimerCount > 0);
  scheduler.advanceBy(100);

  await assert.rejects(preparation, /did not complete within 100 ms/u);
  assert.equal(controller.configuration?.botTokenAlias, FIRST_BINDING.botTokenAlias);
  assert.equal(controller.runtime?.status.code, "DISCORD_READY");
  await controller.close();
});

test("Discord disable commits without deleting the durable binding history", async () => {
  const statuses: string[] = [];
  const controller = new DiscordBindingController<FakeDiscordRuntime>({
    credentialCapability: async () => DISCORD_BOT_TOKEN_AVAILABLE,
    createRuntime: async (configuration, onStatusChange) =>
      new FakeDiscordRuntime(configuration.botTokenAlias, "ready", onStatusChange),
    onStatusChange: (status) => statuses.push(status.code),
  });
  await controller.start(FIRST_BINDING);

  const transition = await controller.prepare(null);
  await transition.commit();

  assert.equal(controller.runtime, undefined);
  assert.equal(controller.configuration, null);
  assert.equal(statuses.at(-1), "DISCORD_NOT_CONFIGURED");
  await controller.close();
});

test("Discord replacement is rejected before stopping the current runtime when its alias is absent", async () => {
  const controller = new DiscordBindingController<FakeDiscordRuntime>({
    credentialCapability: async (alias) => ({
      purpose: "discord-bot-token",
      available: alias === FIRST_BINDING.botTokenAlias,
    }),
    createRuntime: async (configuration, onStatusChange) =>
      new FakeDiscordRuntime(configuration.botTokenAlias, "ready", onStatusChange),
  });
  await controller.start(FIRST_BINDING);
  const current = controller.runtime;

  await assert.rejects(
    controller.prepare(SECOND_BINDING),
    (error: unknown) =>
      error instanceof DiscordBindingControllerError &&
      error.code === "DISCORD_BINDING_CREDENTIAL_UNAVAILABLE",
  );
  assert.equal(controller.runtime, current);
  assert.equal(current?.closed, false);

  await controller.close();
});

test("a current Gateway close failure never starts a possibly overlapping replacement", async () => {
  let candidate: FakeDiscordRuntime | undefined;
  const controller = new DiscordBindingController<FakeDiscordRuntime>({
    credentialCapability: async () => DISCORD_BOT_TOKEN_AVAILABLE,
    createRuntime: async (configuration, onStatusChange) => {
      const runtime = new FakeDiscordRuntime(
        configuration.botTokenAlias,
        "ready",
        onStatusChange,
        configuration.botTokenAlias === FIRST_BINDING.botTokenAlias,
      );
      if (configuration.botTokenAlias === SECOND_BINDING.botTokenAlias) {
        candidate = runtime;
      }
      return runtime;
    },
  });
  await controller.start(FIRST_BINDING);

  await assert.rejects(
    controller.prepare(SECOND_BINDING),
    (error: unknown) =>
      error instanceof DiscordBindingControllerError &&
      error.code === "DISCORD_BINDING_ROLLBACK_FAILED" &&
      /no replacement Gateway was started/u.test(error.message),
  );
  assert.equal(candidate?.started, false);
  assert.equal(candidate?.closed, true);
  assert.equal(controller.configuration?.botTokenAlias, FIRST_BINDING.botTokenAlias);
  await assert.rejects(
    controller.prepare(SECOND_BINDING),
    (error: unknown) =>
      error instanceof DiscordBindingControllerError && error.code === "DISCORD_BINDING_FAULTED",
  );
  await assert.rejects(controller.close(), /could not be stopped safely/u);
});

test("a stalled current Gateway shutdown times out before any candidate can start", async () => {
  const scheduler = new ManualActivationScheduler();
  let current: FakeDiscordRuntime | undefined;
  let candidate: FakeDiscordRuntime | undefined;
  const controller = new DiscordBindingController<FakeDiscordRuntime>({
    credentialCapability: async () => DISCORD_BOT_TOKEN_AVAILABLE,
    createRuntime: async (configuration, onStatusChange) => {
      const isCurrent = configuration.botTokenAlias === FIRST_BINDING.botTokenAlias;
      const runtime = new FakeDiscordRuntime(
        configuration.botTokenAlias,
        "ready",
        onStatusChange,
        false,
        isCurrent,
      );
      if (isCurrent) {
        current = runtime;
      } else {
        candidate = runtime;
      }
      return runtime;
    },
    activationTimeoutMs: 100,
    scheduler,
  });
  await controller.start(FIRST_BINDING);

  const preparation = controller.prepare(SECOND_BINDING);
  await waitForCondition(() => current?.closeRequested === true && scheduler.pendingTimerCount > 0);
  scheduler.advanceBy(100);
  await assert.rejects(
    preparation,
    (error: unknown) =>
      error instanceof DiscordBindingControllerError &&
      error.code === "DISCORD_BINDING_ROLLBACK_FAILED",
  );
  assert.equal(candidate?.started, false);

  const closing = controller.close();
  await waitForCondition(() => scheduler.pendingTimerCount > 0);
  scheduler.advanceBy(100);
  await assert.rejects(closing, /could not be stopped safely/u);
});

test("an uncertain failed-candidate close never overlaps a restored Gateway", async () => {
  const created: FakeDiscordRuntime[] = [];
  const controller = new DiscordBindingController<FakeDiscordRuntime>({
    credentialCapability: async () => DISCORD_BOT_TOKEN_AVAILABLE,
    createRuntime: async (configuration, onStatusChange) => {
      const replacement = configuration.botTokenAlias === SECOND_BINDING.botTokenAlias;
      const runtime = new FakeDiscordRuntime(
        configuration.botTokenAlias,
        replacement ? "unavailable" : "ready",
        onStatusChange,
        replacement,
      );
      created.push(runtime);
      return runtime;
    },
  });
  await controller.start(FIRST_BINDING);

  await assert.rejects(
    controller.prepare(SECOND_BINDING),
    (error: unknown) =>
      error instanceof DiscordBindingControllerError &&
      error.code === "DISCORD_BINDING_ROLLBACK_FAILED" &&
      /previous Gateway was not restarted/u.test(error.message),
  );
  assert.equal(created.length, 2);
  assert.equal(controller.runtime, undefined);
  assert.equal(controller.configuration?.botTokenAlias, FIRST_BINDING.botTokenAlias);
  await assert.rejects(
    controller.prepare(SECOND_BINDING),
    (error: unknown) =>
      error instanceof DiscordBindingControllerError && error.code === "DISCORD_BINDING_FAULTED",
  );
  await assert.rejects(controller.close(), /could not be stopped safely/u);
});

test("rollback closes the uncommitted candidate before composing the prior binding", async () => {
  const created: FakeDiscordRuntime[] = [];
  let firstBindingCompositions = 0;
  const controller = new DiscordBindingController<FakeDiscordRuntime>({
    credentialCapability: async () => DISCORD_BOT_TOKEN_AVAILABLE,
    createRuntime: async (configuration, onStatusChange) => {
      if (configuration.botTokenAlias === FIRST_BINDING.botTokenAlias) {
        firstBindingCompositions += 1;
        if (firstBindingCompositions > 1) {
          throw new Error("prior composition unavailable");
        }
      }
      const runtime = new FakeDiscordRuntime(configuration.botTokenAlias, "ready", onStatusChange);
      created.push(runtime);
      return runtime;
    },
  });
  await controller.start(FIRST_BINDING);
  const transition = await controller.prepare(SECOND_BINDING);
  const candidate = controller.runtime;

  await assert.rejects(transition.rollback(), /previous Discord binding could not be restored/u);
  assert.equal(candidate?.closed, true);
  assert.equal(controller.runtime, undefined);
  assert.equal(controller.configuration?.botTokenAlias, FIRST_BINDING.botTokenAlias);
  assert.equal(created.length, 2);
  await controller.close();
});

test("an authoritative startup cleanup failure faults closed and retains the uncertain runtime", async () => {
  const controller = new DiscordBindingController<FakeDiscordRuntime>({
    credentialCapability: async () => DISCORD_BOT_TOKEN_AVAILABLE,
    createRuntime: async (configuration, onStatusChange) =>
      new FakeDiscordRuntime(configuration.botTokenAlias, "throw-start", onStatusChange, true),
  });

  await assert.rejects(
    controller.start(FIRST_BINDING),
    (error: unknown) =>
      error instanceof DiscordBindingControllerError &&
      error.code === "DISCORD_BINDING_ROLLBACK_FAILED",
  );
  await assert.rejects(
    controller.prepare(SECOND_BINDING),
    (error: unknown) =>
      error instanceof DiscordBindingControllerError && error.code === "DISCORD_BINDING_FAULTED",
  );
  await assert.rejects(controller.close(), /could not be stopped safely/u);
});

test("an authoritative binding keeps its retry runtime when its credential is temporarily unavailable", async () => {
  let available = false;
  let runtime: FakeDiscordRuntime | undefined;
  const statuses: string[] = [];
  const controller = new DiscordBindingController<FakeDiscordRuntime>({
    credentialCapability: async () => ({
      purpose: "discord-bot-token",
      available,
    }),
    createRuntime: async (configuration, onStatusChange) => {
      runtime = new FakeDiscordRuntime(configuration.botTokenAlias, "unavailable", onStatusChange);
      return runtime;
    },
    onStatusChange: (status) => statuses.push(status.code),
  });

  await controller.start(FIRST_BINDING);
  assert.equal(controller.runtime, runtime);
  assert.equal(controller.runtime?.status.code, "DISCORD_UNAVAILABLE");
  available = true;
  runtime?.becomeReady();
  assert.equal(controller.runtime?.status.code, "DISCORD_READY");
  assert.equal(statuses.at(-1), "DISCORD_READY");
  await controller.close();
});

test("Main shutdown cancels a hanging authoritative Discord startup", async () => {
  const scheduler = new ManualActivationScheduler();
  let runtime: FakeDiscordRuntime | undefined;
  const statuses: string[] = [];
  const controller = new DiscordBindingController<FakeDiscordRuntime>({
    credentialCapability: async () => DISCORD_BOT_TOKEN_AVAILABLE,
    createRuntime: async (configuration, onStatusChange) => {
      runtime = new FakeDiscordRuntime(
        configuration.botTokenAlias,
        "hanging-start",
        onStatusChange,
      );
      return runtime;
    },
    activationTimeoutMs: 100,
    scheduler,
    onStatusChange: (status) => statuses.push(status.code),
  });

  const startup = controller.start(FIRST_BINDING);
  await waitForCondition(() => runtime?.started === true);
  const closing = controller.close();

  await assert.rejects(
    startup,
    (error: unknown) =>
      error instanceof DiscordBindingControllerError && error.code === "DISCORD_BINDING_CLOSED",
  );
  await closing;
  assert.equal(runtime?.closed, true);
  assert.equal(statuses.at(-1), "DISCORD_STOPPED");
});

test("shutdown after deferred capability resolution never calls the runtime factory", async () => {
  let capabilityEntered = false;
  let resolveCapability = (_capability: typeof DISCORD_BOT_TOKEN_AVAILABLE): void => undefined;
  let compositions = 0;
  const controller = new DiscordBindingController<FakeDiscordRuntime>({
    credentialCapability: async () => {
      capabilityEntered = true;
      return new Promise<typeof DISCORD_BOT_TOKEN_AVAILABLE>((resolve) => {
        resolveCapability = resolve;
      });
    },
    createRuntime: async (configuration, onStatusChange) => {
      compositions += 1;
      return new FakeDiscordRuntime(configuration.botTokenAlias, "ready", onStatusChange);
    },
  });

  const startup = controller.start(FIRST_BINDING);
  await waitForCondition(() => capabilityEntered);
  resolveCapability(DISCORD_BOT_TOKEN_AVAILABLE);
  const closing = controller.close();

  await assert.rejects(
    startup,
    (error: unknown) =>
      error instanceof DiscordBindingControllerError && error.code === "DISCORD_BINDING_CLOSED",
  );
  await closing;
  assert.equal(compositions, 0);
});

test("Main shutdown drains a late authoritative runtime composition before reporting stopped", async () => {
  let factoryEntered = false;
  let resolveRuntime = (_runtime: FakeDiscordRuntime): void => undefined;
  const lateRuntime = new FakeDiscordRuntime(FIRST_BINDING.botTokenAlias);
  const statuses: string[] = [];
  const controller = new DiscordBindingController<FakeDiscordRuntime>({
    credentialCapability: async () => DISCORD_BOT_TOKEN_AVAILABLE,
    createRuntime: async () => {
      factoryEntered = true;
      return new Promise<FakeDiscordRuntime>((resolve) => {
        resolveRuntime = resolve;
      });
    },
    onStatusChange: (status) => statuses.push(status.code),
  });

  const startup = controller.start(FIRST_BINDING);
  await waitForCondition(() => factoryEntered);
  const closing = controller.close();
  const startupRejected = assert.rejects(
    startup,
    (error: unknown) =>
      error instanceof DiscordBindingControllerError && error.code === "DISCORD_BINDING_CLOSED",
  );
  let closeSettled = false;
  void closing.then(() => {
    closeSettled = true;
  });
  await startupRejected;
  await Promise.resolve();
  assert.equal(closeSettled, false);

  resolveRuntime(lateRuntime);
  await closing;
  assert.equal(lateRuntime.started, false);
  assert.equal(lateRuntime.closed, true);
  assert.equal(statuses.at(-1), "DISCORD_STOPPED");
});

test("Main shutdown fails explicitly when a cancelled runtime composition cannot be drained", async () => {
  const scheduler = new ManualActivationScheduler();
  let factoryEntered = false;
  const controller = new DiscordBindingController<FakeDiscordRuntime>({
    credentialCapability: async () => DISCORD_BOT_TOKEN_AVAILABLE,
    createRuntime: async () => {
      factoryEntered = true;
      return new Promise<FakeDiscordRuntime>(() => undefined);
    },
    activationTimeoutMs: 100,
    scheduler,
  });

  const startup = controller.start(FIRST_BINDING);
  await waitForCondition(() => factoryEntered);
  const closing = controller.close();
  await assert.rejects(
    startup,
    (error: unknown) =>
      error instanceof DiscordBindingControllerError && error.code === "DISCORD_BINDING_CLOSED",
  );
  await waitForCondition(() => scheduler.pendingTimerCount > 0);
  scheduler.advanceBy(100);

  await assert.rejects(closing, /could not be stopped safely/u);
});

test("shutdown detects a late failed runtime close while the current Gateway is closing", async () => {
  const scheduler = new ManualActivationScheduler();
  let currentClosed = false;
  let currentCloseEntered = false;
  let resolveCurrentClose = (): void => undefined;
  const currentCloseGate = new Promise<void>((resolve) => {
    resolveCurrentClose = resolve;
  });
  const currentRuntime: DiscordBindingRuntime = {
    get status(): DiscordBindingRuntime["status"] {
      return currentClosed
        ? { status: "unavailable", code: "DISCORD_STOPPED" }
        : { status: "ready", code: "DISCORD_READY" };
    },
    start: async () => ({ status: "ready", code: "DISCORD_READY" }),
    close: async () => {
      currentCloseEntered = true;
      await currentCloseGate;
      currentClosed = true;
    },
  };
  const lateRuntime = new FakeDiscordRuntime(
    SECOND_BINDING.botTokenAlias,
    "ready",
    () => undefined,
    true,
  );
  let compositions = 0;
  let lateFactoryEntered = false;
  let resolveLateFactory = (_runtime: DiscordBindingRuntime): void => undefined;
  const statuses: string[] = [];
  const controller = new DiscordBindingController<DiscordBindingRuntime>({
    credentialCapability: async () => DISCORD_BOT_TOKEN_AVAILABLE,
    createRuntime: async () => {
      compositions += 1;
      if (compositions === 1) {
        return currentRuntime;
      }
      lateFactoryEntered = true;
      return new Promise<DiscordBindingRuntime>((resolve) => {
        resolveLateFactory = resolve;
      });
    },
    activationTimeoutMs: 100,
    scheduler,
    onStatusChange: (status) => statuses.push(status.code),
  });
  await controller.start(FIRST_BINDING);

  const preparation = controller.prepare(SECOND_BINDING);
  await waitForCondition(() => lateFactoryEntered);
  scheduler.advanceBy(100);
  await assert.rejects(preparation, /did not complete within 100 ms/u);

  const closing = controller.close();
  await waitForCondition(() => currentCloseEntered);
  resolveLateFactory(lateRuntime);
  await waitForCondition(() => lateRuntime.closeRequested);
  resolveCurrentClose();

  await assert.rejects(closing, /could not be stopped safely/u);
  assert.notEqual(statuses.at(-1), "DISCORD_STOPPED");
});

test("shutdown during failure restore never starts the late previous Gateway", async () => {
  let compositions = 0;
  let restorationEntered = false;
  let resolveRestoration = (_runtime: FakeDiscordRuntime): void => undefined;
  const lateRestoration = new FakeDiscordRuntime(FIRST_BINDING.botTokenAlias);
  const controller = new DiscordBindingController<FakeDiscordRuntime>({
    credentialCapability: async () => DISCORD_BOT_TOKEN_AVAILABLE,
    createRuntime: async (configuration, onStatusChange) => {
      compositions += 1;
      if (compositions === 1) {
        return new FakeDiscordRuntime(configuration.botTokenAlias, "ready", onStatusChange);
      }
      if (compositions === 2) {
        return new FakeDiscordRuntime(configuration.botTokenAlias, "unavailable", onStatusChange);
      }
      restorationEntered = true;
      return new Promise<FakeDiscordRuntime>((resolve) => {
        resolveRestoration = resolve;
      });
    },
  });
  await controller.start(FIRST_BINDING);

  const preparation = controller.prepare(SECOND_BINDING);
  await waitForCondition(() => restorationEntered);
  const closing = controller.close();
  await assert.rejects(preparation, /previous binding could not be restored/u);
  let closeSettled = false;
  void closing.then(() => {
    closeSettled = true;
  });
  await Promise.resolve();
  assert.equal(closeSettled, false);

  resolveRestoration(lateRestoration);
  await closing;
  assert.equal(lateRestoration.started, false);
  assert.equal(lateRestoration.closed, true);
});

test("confirmed controller shutdown emits a terminal stopped status", async () => {
  const statuses: string[] = [];
  const controller = new DiscordBindingController<FakeDiscordRuntime>({
    credentialCapability: async () => DISCORD_BOT_TOKEN_AVAILABLE,
    createRuntime: async (configuration, onStatusChange) =>
      new FakeDiscordRuntime(configuration.botTokenAlias, "ready", onStatusChange),
    onStatusChange: (status) => statuses.push(status.code),
  });
  await controller.start(FIRST_BINDING);

  await controller.close();

  assert.equal(statuses.at(-1), "DISCORD_STOPPED");
});

test("non-Discord Secret capabilities are rejected before runtime composition", async () => {
  let compositions = 0;
  const controller = new DiscordBindingController<FakeDiscordRuntime>({
    credentialCapability: async () => undefined,
    createRuntime: async (configuration, onStatusChange) => {
      compositions += 1;
      return new FakeDiscordRuntime(configuration.botTokenAlias, "ready", onStatusChange);
    },
  });

  await assert.rejects(
    controller.start(FIRST_BINDING),
    (error: unknown) =>
      error instanceof DiscordBindingControllerError &&
      error.code === "DISCORD_BINDING_CREDENTIAL_UNAUTHORIZED",
  );
  assert.equal(compositions, 0);
  await controller.close();
});

test("Main shutdown cancels an in-flight replacement and closes its candidate", async () => {
  let candidate: FakeDiscordRuntime | undefined;
  const controller = new DiscordBindingController<FakeDiscordRuntime>({
    credentialCapability: async () => DISCORD_BOT_TOKEN_AVAILABLE,
    createRuntime: async (configuration, onStatusChange) => {
      const runtime = new FakeDiscordRuntime(
        configuration.botTokenAlias,
        configuration.botTokenAlias === SECOND_BINDING.botTokenAlias ? "hanging-start" : "ready",
        onStatusChange,
      );
      if (configuration.botTokenAlias === SECOND_BINDING.botTokenAlias) {
        candidate = runtime;
      }
      return runtime;
    },
  });
  await controller.start(FIRST_BINDING);

  const preparation = controller.prepare(SECOND_BINDING);
  await waitForCondition(() => candidate?.started === true);
  const closing = controller.close();
  await assert.rejects(
    preparation,
    (error: unknown) =>
      error instanceof DiscordBindingControllerError && error.code === "DISCORD_BINDING_CLOSED",
  );
  await closing;
  assert.equal(candidate?.closed, true);
});

test("a prepare already queued before shutdown cannot start another Gateway", async () => {
  const created: FakeDiscordRuntime[] = [];
  const controller = new DiscordBindingController<FakeDiscordRuntime>({
    credentialCapability: async () => DISCORD_BOT_TOKEN_AVAILABLE,
    createRuntime: async (configuration, onStatusChange) => {
      const runtime = new FakeDiscordRuntime(configuration.botTokenAlias, "ready", onStatusChange);
      created.push(runtime);
      return runtime;
    },
  });
  await controller.start(FIRST_BINDING);
  const current = await controller.prepare(SECOND_BINDING);
  const queued = controller.prepare(FIRST_BINDING);
  const closing = controller.close();
  await assert.rejects(
    current.commit(),
    (error: unknown) =>
      error instanceof DiscordBindingControllerError && error.code === "DISCORD_BINDING_CLOSED",
  );
  await current.rollback();

  await assert.rejects(
    queued,
    (error: unknown) =>
      error instanceof DiscordBindingControllerError && error.code === "DISCORD_BINDING_CLOSED",
  );
  await closing;
  assert.equal(created.length, 2);
});

test("shutdown releases an abandoned prepared transition after closing its candidate", async () => {
  let candidate: FakeDiscordRuntime | undefined;
  const controller = new DiscordBindingController<FakeDiscordRuntime>({
    credentialCapability: async () => DISCORD_BOT_TOKEN_AVAILABLE,
    createRuntime: async (configuration, onStatusChange) => {
      const runtime = new FakeDiscordRuntime(configuration.botTokenAlias, "ready", onStatusChange);
      if (configuration.botTokenAlias === SECOND_BINDING.botTokenAlias) {
        candidate = runtime;
      }
      return runtime;
    },
  });
  await controller.start(FIRST_BINDING);
  const abandoned = await controller.prepare(SECOND_BINDING);

  await controller.close();

  assert.equal(candidate?.closed, true);
  await assert.rejects(
    abandoned.commit(),
    (error: unknown) =>
      error instanceof DiscordBindingControllerError && error.code === "DISCORD_BINDING_CLOSED",
  );
  await abandoned.rollback();
});

test("shutdown releases an unchanged prepared transition and rejects its late commit", async () => {
  const controller = new DiscordBindingController<FakeDiscordRuntime>({
    credentialCapability: async () => DISCORD_BOT_TOKEN_AVAILABLE,
    createRuntime: async (configuration, onStatusChange) =>
      new FakeDiscordRuntime(configuration.botTokenAlias, "ready", onStatusChange),
  });
  await controller.start(FIRST_BINDING);
  const unchanged = await controller.prepare(FIRST_BINDING);

  await controller.close();

  await assert.rejects(
    unchanged.commit(),
    (error: unknown) =>
      error instanceof DiscordBindingControllerError && error.code === "DISCORD_BINDING_CLOSED",
  );
  await unchanged.rollback();
});

class FakeDiscordRuntime implements DiscordBindingRuntime {
  public readonly tokenAlias: string;
  readonly #mode:
    | "delayed-ready"
    | "hanging-start"
    | "ready"
    | "ready-then-unavailable"
    | "starting"
    | "throw-start"
    | "unavailable";
  readonly #onStatusChange: (status: DiscordBindingRuntime["status"]) => void;
  readonly #failClose: boolean;
  readonly #hangClose: boolean;
  public started = false;
  public closed = false;
  public closeRequested = false;
  public ready = false;
  public unavailableAfterReady = false;
  public recovered = false;

  public constructor(
    tokenAlias: string,
    mode:
      | "delayed-ready"
      | "hanging-start"
      | "ready"
      | "ready-then-unavailable"
      | "starting"
      | "throw-start"
      | "unavailable" = "ready",
    onStatusChange: (status: DiscordBindingRuntime["status"]) => void = () => undefined,
    failClose = false,
    hangClose = false,
  ) {
    this.tokenAlias = tokenAlias;
    this.#mode = mode;
    this.#onStatusChange = onStatusChange;
    this.#failClose = failClose;
    this.#hangClose = hangClose;
  }

  public get status(): DiscordBindingRuntime["status"] {
    return this.closed
      ? { status: "unavailable", code: "DISCORD_STOPPED" }
      : (this.#mode === "unavailable" && !this.recovered) || this.unavailableAfterReady
        ? { status: "unavailable", code: "DISCORD_UNAVAILABLE" }
        : this.ready
          ? { status: "ready", code: "DISCORD_READY" }
          : this.started
            ? { status: "unavailable", code: "DISCORD_STARTING" }
            : { status: "unavailable", code: "DISCORD_STOPPED" };
  }

  public async start(): Promise<DiscordBindingRuntime["status"]> {
    this.started = true;
    if (this.#mode === "throw-start") {
      throw new Error("fixture start failed");
    }
    if (this.#mode === "hanging-start") {
      return new Promise<never>(() => undefined);
    }
    this.ready = this.#mode === "ready";
    this.#onStatusChange(this.status);
    if (this.#mode === "ready-then-unavailable") {
      this.ready = true;
      this.#onStatusChange(this.status);
      this.ready = false;
      this.unavailableAfterReady = true;
      this.#onStatusChange(this.status);
    }
    if (this.#mode === "delayed-ready") {
      queueMicrotask(() => {
        this.ready = true;
        this.#onStatusChange(this.status);
      });
    }
    return this.status;
  }

  public becomeReady(): void {
    this.recovered = true;
    this.unavailableAfterReady = false;
    this.ready = true;
    this.#onStatusChange(this.status);
  }

  public becomeUnavailable(): void {
    this.ready = false;
    this.unavailableAfterReady = true;
    this.#onStatusChange(this.status);
  }

  public async close(): Promise<void> {
    this.closeRequested = true;
    if (this.#failClose) {
      throw new Error("fixture close failed");
    }
    if (this.#hangClose) {
      return new Promise<never>(() => undefined);
    }
    this.closed = true;
  }
}

class ManualActivationScheduler implements DiscordBindingActivationScheduler {
  #nowMs = 0;
  #nextId = 0;
  readonly #timers = new Map<number, { readonly atMs: number; readonly callback: () => void }>();

  public get pendingTimerCount(): number {
    return this.#timers.size;
  }

  public nowMs(): number {
    return this.#nowMs;
  }

  public setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.#nextId;
    this.#timers.set(id, { atMs: this.#nowMs + delayMs, callback });
    return id;
  }

  public clearTimeout(handle: unknown): void {
    if (typeof handle === "number") {
      this.#timers.delete(handle);
    }
  }

  public advanceBy(delayMs: number): void {
    this.#nowMs += delayMs;
    while (true) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.atMs <= this.#nowMs)
        .sort(([leftId, left], [rightId, right]) => left.atMs - right.atMs || leftId - rightId)[0];
      if (due === undefined) {
        return;
      }
      this.#timers.delete(due[0]);
      due[1].callback();
    }
  }
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("The deterministic fixture condition was not reached.");
}

function binding(
  botTokenAliasSnowflake: string,
  channelId: string,
): MainDiscordBindingConfiguration {
  return {
    schemaVersion: 1,
    enabled: true,
    botTokenAlias: `discord-token-${botTokenAliasSnowflake}`,
    forum: {
      applicationId: "55555555555555555",
      botUserId: "66666666666666666",
      guildId: "77777777777777777",
      forumBindings: [
        {
          channelId,
          workflowTagIds: {
            done: "80000000000000001",
            failed: "80000000000000002",
            intake: "80000000000000003",
            review: "80000000000000004",
            running: "80000000000000005",
            waiting: "80000000000000006",
          },
        },
      ],
      ownerUserIds: ["90000000000000001"],
      allowedRoleIds: [],
    },
  };
}
