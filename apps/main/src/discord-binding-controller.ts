import { isDeepStrictEqual } from "node:util";

import type { DiscordRuntimeStatus } from "./discord-runtime.ts";
import {
  validateMainDiscordBindingConfiguration,
  type MainDiscordBindingConfiguration,
} from "./discord-configuration.ts";

const DEFAULT_ACTIVATION_TIMEOUT_MS = 60_000;

export interface DiscordBindingRuntime {
  readonly status: DiscordRuntimeStatus;
  start(): Promise<DiscordRuntimeStatus>;
  close(): Promise<void>;
}

export type DiscordBindingStatus =
  | DiscordRuntimeStatus
  | {
      readonly status: "unavailable";
      readonly code: "DISCORD_NOT_CONFIGURED";
    };

export interface DiscordBindingControllerOptions<
  TRuntime extends DiscordBindingRuntime = DiscordBindingRuntime,
> {
  readonly credentialCapability: (
    alias: string,
  ) => DiscordBotTokenCapability | undefined | Promise<DiscordBotTokenCapability | undefined>;
  readonly createRuntime: (
    configuration: MainDiscordBindingConfiguration,
    onStatusChange: (status: DiscordRuntimeStatus) => void,
  ) => Promise<TRuntime>;
  readonly activationTimeoutMs?: number;
  readonly scheduler?: DiscordBindingActivationScheduler;
  readonly onStatusChange?: (status: DiscordBindingStatus) => void;
}

export interface DiscordBindingActivationScheduler {
  nowMs(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface DiscordBotTokenCapability {
  readonly purpose: "discord-bot-token";
  readonly available: boolean;
}

export interface PreparedDiscordBindingTransition {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

interface ComposedDiscordBindingRuntime<TRuntime extends DiscordBindingRuntime> {
  readonly runtime: TRuntime;
  readonly token: object;
  readonly readiness: DiscordBindingReadiness;
}

interface DiscordBindingReadiness {
  latestStatus(): DiscordRuntimeStatus | undefined;
  subscribe(observer: (status: DiscordRuntimeStatus) => void): () => void;
}

export type DiscordBindingControllerErrorCode =
  | "DISCORD_BINDING_ACTIVATION_FAILED"
  | "DISCORD_BINDING_CLOSED"
  | "DISCORD_BINDING_COMPOSITION_FAILED"
  | "DISCORD_BINDING_CREDENTIAL_UNAUTHORIZED"
  | "DISCORD_BINDING_CREDENTIAL_UNAVAILABLE"
  | "DISCORD_BINDING_FAULTED"
  | "DISCORD_BINDING_ROLLBACK_FAILED";

export class DiscordBindingControllerError extends Error {
  public readonly code: DiscordBindingControllerErrorCode;

  public constructor(
    code: DiscordBindingControllerErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DiscordBindingControllerError";
    this.code = code;
  }
}

/**
 * Owns the one allowed Discord Gateway runtime for Main. A prepared transition
 * keeps its serialization lock until the caller either commits the matching
 * durable Configuration mutation or asks for rollback.
 */
export class DiscordBindingController<
  TRuntime extends DiscordBindingRuntime = DiscordBindingRuntime,
> {
  readonly #credentialCapability: DiscordBindingControllerOptions<TRuntime>["credentialCapability"];
  readonly #createRuntime: DiscordBindingControllerOptions<TRuntime>["createRuntime"];
  readonly #activationTimeoutMs: number;
  readonly #scheduler: DiscordBindingActivationScheduler;
  readonly #onStatusChange: DiscordBindingControllerOptions<TRuntime>["onStatusChange"];
  #configuration: MainDiscordBindingConfiguration | null = null;
  #runtime: TRuntime | undefined;
  #activeRuntimeToken: object | undefined;
  #tail: Promise<void> = Promise.resolve();
  #uncertainRuntimes = new Set<TRuntime>();
  #transitionAbort: AbortController | undefined;
  #abortShutdownPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #lateRuntimeCleanups = new Set<Promise<void>>();
  #started = false;
  #closingRequested = false;
  #closed = false;
  #faulted = false;

  public constructor(options: DiscordBindingControllerOptions<TRuntime>) {
    if (
      typeof options.credentialCapability !== "function" ||
      typeof options.createRuntime !== "function" ||
      (options.scheduler !== undefined &&
        (typeof options.scheduler.nowMs !== "function" ||
          typeof options.scheduler.setTimeout !== "function" ||
          typeof options.scheduler.clearTimeout !== "function")) ||
      (options.onStatusChange !== undefined && typeof options.onStatusChange !== "function")
    ) {
      throw new TypeError("A valid Discord binding controller configuration is required.");
    }
    this.#credentialCapability = options.credentialCapability;
    this.#createRuntime = options.createRuntime;
    this.#activationTimeoutMs = options.activationTimeoutMs ?? DEFAULT_ACTIVATION_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.#activationTimeoutMs) ||
      this.#activationTimeoutMs < 1 ||
      this.#activationTimeoutMs > 120_000
    ) {
      throw new TypeError("Discord binding activation timeout must be between 1 and 120000 ms.");
    }
    this.#scheduler = options.scheduler ?? NODE_ACTIVATION_SCHEDULER;
    this.#onStatusChange = options.onStatusChange;
  }

  public get configuration(): MainDiscordBindingConfiguration | null {
    return structuredClone(this.#configuration);
  }

  public get runtime(): TRuntime | undefined {
    return this.#runtime;
  }

  public async start(configuration: MainDiscordBindingConfiguration | null): Promise<void> {
    if (this.#started) {
      throw new DiscordBindingControllerError(
        "DISCORD_BINDING_ACTIVATION_FAILED",
        "The Discord binding controller is already started.",
      );
    }
    this.#started = true;
    const release = await this.#acquire();
    const startupAbort = new AbortController();
    this.#transitionAbort = startupAbort;
    try {
      this.#assertOpen();
      const target = normalizeConfiguration(configuration);
      if (target === null) {
        this.#configuration = null;
        this.#emit({ status: "unavailable", code: "DISCORD_NOT_CONFIGURED" });
        return;
      }
      const activated = await this.#activate(target, true, startupAbort.signal);
      await this.#assertCanAdopt(activated, startupAbort.signal);
      if (startupAbort.signal.aborted || this.#closingRequested) {
        await this.#assertCanAdopt(activated, startupAbort.signal);
      }
      this.#configuration = target;
      this.#runtime = activated.runtime;
      this.#activeRuntimeToken = activated.token;
      this.#emit(activated.runtime.status);
    } finally {
      if (this.#transitionAbort === startupAbort) {
        this.#transitionAbort = undefined;
      }
      release();
    }
  }

  public async prepare(
    configuration: MainDiscordBindingConfiguration | null,
  ): Promise<PreparedDiscordBindingTransition> {
    if (!this.#started) {
      throw new DiscordBindingControllerError(
        "DISCORD_BINDING_ACTIVATION_FAILED",
        "The Discord binding controller is not started.",
      );
    }
    const target = normalizeConfiguration(configuration);
    const release = await this.#acquire();
    const transitionAbort = new AbortController();
    this.#transitionAbort = transitionAbort;
    try {
      this.#assertOpen();
      if (isDeepStrictEqual(this.#configuration, target)) {
        return this.#noOpPreparedTransition(release, transitionAbort);
      }
      const previous = this.#configuration;
      await this.#replace(target, transitionAbort.signal);
      return this.#preparedTransition(previous, target, release, transitionAbort);
    } catch (error) {
      if (this.#transitionAbort === transitionAbort) {
        this.#transitionAbort = undefined;
      }
      release();
      throw error;
    }
  }

  public close(): Promise<void> {
    if (this.#closePromise !== undefined) {
      return this.#closePromise;
    }
    this.#closingRequested = true;
    this.#transitionAbort?.abort();
    this.#closePromise = this.#closeSerialized();
    return this.#closePromise;
  }

  async #closeSerialized(): Promise<void> {
    const release = await this.#acquire();
    try {
      if (this.#closed) {
        return;
      }
      this.#closed = true;
      await this.#abortShutdownPromise?.catch(() => undefined);
      this.#activeRuntimeToken = undefined;
      const runtime = this.#runtime;
      this.#runtime = undefined;
      const runtimes = new Set(this.#uncertainRuntimes);
      this.#uncertainRuntimes.clear();
      if (runtime !== undefined) {
        runtimes.add(runtime);
      }
      const failures: unknown[] = [];
      for (const ownedRuntime of runtimes) {
        const closeError = await this.#closeRuntime(ownedRuntime);
        if (closeError === undefined) {
          this.#uncertainRuntimes.delete(ownedRuntime);
        } else {
          failures.push(closeError);
        }
      }
      const lateCleanupError = await this.#drainLateRuntimeCleanups();
      if (lateCleanupError !== undefined) {
        failures.push(lateCleanupError);
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "One or more Discord runtimes could not be stopped safely.",
        );
      }
      this.#emit({ status: "unavailable", code: "DISCORD_STOPPED" });
    } finally {
      release();
    }
  }

  async #replace(
    target: MainDiscordBindingConfiguration | null,
    signal: AbortSignal,
  ): Promise<void> {
    const deadlineMs = this.#scheduler.nowMs() + this.#activationTimeoutMs;
    const previousConfiguration = this.#configuration;
    const previousRuntime = this.#runtime;
    const previousRuntimeToken = this.#activeRuntimeToken;
    const candidate =
      target === null ? undefined : await this.#compose(target, true, deadlineMs, signal);
    let previousClosed = previousRuntime === undefined;
    try {
      this.#activeRuntimeToken = undefined;
      this.#runtime = undefined;
      const previousCloseError = await this.#closeRuntime(previousRuntime);
      if (previousCloseError !== undefined) {
        throw previousCloseError;
      }
      previousClosed = true;
      this.#emit({
        status: "unavailable",
        code: candidate === undefined ? "DISCORD_STOPPED" : "DISCORD_STARTING",
      });
      this.#throwIfTransitionAborted(signal);
      if (candidate !== undefined) {
        await this.#startUntilReady(candidate, deadlineMs, signal);
      }
      this.#throwIfTransitionAborted(signal);
      this.#configuration = target;
      this.#runtime = candidate?.runtime;
      this.#activeRuntimeToken = candidate?.token;
      this.#emit(
        candidate?.runtime.status ?? {
          status: "unavailable",
          code: "DISCORD_NOT_CONFIGURED",
        },
      );
    } catch (error) {
      const candidateCloseError = await this.#closeRuntime(candidate?.runtime);
      if (!previousClosed) {
        this.#configuration = previousConfiguration;
        this.#runtime = previousRuntime;
        this.#activeRuntimeToken = previousRuntimeToken;
        this.#faulted = true;
        if (previousRuntime !== undefined) {
          this.#uncertainRuntimes.add(previousRuntime);
        }
        if (candidateCloseError !== undefined && candidate !== undefined) {
          this.#uncertainRuntimes.add(candidate.runtime);
        }
        throw new DiscordBindingControllerError(
          "DISCORD_BINDING_ROLLBACK_FAILED",
          "The current Discord binding could not be stopped safely, so no replacement Gateway was started.",
          {
            cause:
              candidateCloseError === undefined
                ? error
                : new AggregateError([error, candidateCloseError]),
          },
        );
      }
      if (candidateCloseError !== undefined) {
        this.#configuration = previousConfiguration;
        this.#runtime = undefined;
        this.#activeRuntimeToken = undefined;
        this.#faulted = true;
        if (candidate !== undefined) {
          this.#uncertainRuntimes.add(candidate.runtime);
        }
        throw new DiscordBindingControllerError(
          "DISCORD_BINDING_ROLLBACK_FAILED",
          "The failed replacement Discord Gateway could not be stopped safely, so the previous Gateway was not restarted.",
          { cause: new AggregateError([error, candidateCloseError]) },
        );
      }
      this.#configuration = previousConfiguration;
      this.#runtime = undefined;
      this.#activeRuntimeToken = undefined;
      if (signal.aborted || this.#closingRequested) {
        throw new DiscordBindingControllerError(
          "DISCORD_BINDING_CLOSED",
          "The Discord binding transition was cancelled because Main is stopping.",
          { cause: error },
        );
      }
      try {
        await this.#restore(previousConfiguration, signal);
      } catch (rollbackError) {
        throw new DiscordBindingControllerError(
          "DISCORD_BINDING_ROLLBACK_FAILED",
          "The replacement Discord binding failed and the previous binding could not be restored.",
          { cause: new AggregateError([error, rollbackError]) },
        );
      }
      if (error instanceof DiscordBindingControllerError) {
        throw error;
      }
      throw new DiscordBindingControllerError(
        "DISCORD_BINDING_ACTIVATION_FAILED",
        "The replacement Discord binding could not be activated.",
        { cause: error },
      );
    }
  }

  async #activate(
    configuration: MainDiscordBindingConfiguration,
    allowRetryableUnavailable = false,
    signal = new AbortController().signal,
  ): Promise<ComposedDiscordBindingRuntime<TRuntime>> {
    const deadlineMs = this.#scheduler.nowMs() + this.#activationTimeoutMs;
    const composed = await this.#compose(configuration, false, deadlineMs, signal);
    try {
      this.#throwIfTransitionAborted(signal);
      this.#throwIfDeadlineExpired(deadlineMs);
      const status = await this.#awaitBeforeDeadline(composed.runtime.start(), deadlineMs, signal);
      if (!isActivationStatus(status, allowRetryableUnavailable)) {
        throw new DiscordBindingControllerError(
          "DISCORD_BINDING_ACTIVATION_FAILED",
          "The Discord binding did not become startable.",
        );
      }
      this.#throwIfTransitionAborted(signal);
      return composed;
    } catch (error) {
      const closeError = await this.#closeRuntime(composed.runtime);
      if (closeError !== undefined) {
        this.#faulted = true;
        this.#uncertainRuntimes.add(composed.runtime);
        throw new DiscordBindingControllerError(
          "DISCORD_BINDING_ROLLBACK_FAILED",
          "The failed authoritative Discord runtime could not be stopped safely.",
          { cause: new AggregateError([error, closeError]) },
        );
      }
      if (error instanceof DiscordBindingControllerError) {
        throw error;
      }
      throw new DiscordBindingControllerError(
        "DISCORD_BINDING_ACTIVATION_FAILED",
        "The Discord binding could not be activated.",
        { cause: error },
      );
    }
  }

  async #compose(
    configuration: MainDiscordBindingConfiguration,
    requireAvailable: boolean,
    deadlineMs: number,
    signal: AbortSignal,
  ): Promise<ComposedDiscordBindingRuntime<TRuntime>> {
    let capability: DiscordBotTokenCapability | undefined;
    try {
      capability = await this.#awaitBeforeDeadline(
        Promise.resolve().then(() => {
          this.#throwIfTransitionAborted(signal);
          this.#throwIfDeadlineExpired(deadlineMs);
          return this.#credentialCapability(configuration.botTokenAlias);
        }),
        deadlineMs,
        signal,
      );
    } catch (error) {
      if (error instanceof DiscordBindingControllerError) {
        throw error;
      }
      capability = undefined;
    }
    if (
      capability === undefined ||
      capability.purpose !== "discord-bot-token" ||
      typeof capability.available !== "boolean"
    ) {
      throw new DiscordBindingControllerError(
        "DISCORD_BINDING_CREDENTIAL_UNAUTHORIZED",
        "The selected Secret alias is not authorized as a Discord bot token.",
      );
    }
    if (requireAvailable && !capability.available) {
      throw new DiscordBindingControllerError(
        "DISCORD_BINDING_CREDENTIAL_UNAVAILABLE",
        "The Discord bot credential alias is not available on this Main Device.",
      );
    }
    const token = {};
    const readiness = createDiscordBindingReadiness();
    const runtimeOperation = Promise.resolve().then(() => {
      this.#throwIfTransitionAborted(signal);
      this.#throwIfDeadlineExpired(deadlineMs);
      return this.#createRuntime(configuration, (status) => {
        readiness.observe(status);
        if (this.#activeRuntimeToken === token) {
          this.#emit(status);
        }
      });
    });
    try {
      const runtime = await this.#awaitBeforeDeadline(runtimeOperation, deadlineMs, signal);
      if (
        runtime === null ||
        typeof runtime !== "object" ||
        typeof runtime.start !== "function" ||
        typeof runtime.close !== "function"
      ) {
        throw new TypeError("The Discord runtime factory returned an invalid runtime.");
      }
      return { runtime, token, readiness };
    } catch (error) {
      this.#scheduleLateRuntimeCleanup(runtimeOperation);
      if (error instanceof DiscordBindingControllerError) {
        throw error;
      }
      throw new DiscordBindingControllerError(
        "DISCORD_BINDING_COMPOSITION_FAILED",
        "The Discord binding runtime could not be composed.",
        { cause: error },
      );
    }
  }

  async #startUntilReady(
    composed: ComposedDiscordBindingRuntime<TRuntime>,
    deadlineMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    this.#throwIfTransitionAborted(signal);
    this.#throwIfDeadlineExpired(deadlineMs);
    const startStatus = await this.#awaitBeforeDeadline(
      composed.runtime.start(),
      deadlineMs,
      signal,
    );
    let fallbackStatus = startStatus;
    while (true) {
      this.#throwIfTransitionAborted(signal);
      const observed =
        composed.readiness.latestStatus() ?? composed.runtime.status ?? fallbackStatus;
      if (observed.code === "DISCORD_READY") {
        return;
      }
      if (isTerminalActivationStatus(observed)) {
        throw new DiscordBindingControllerError(
          "DISCORD_BINDING_ACTIVATION_FAILED",
          "The replacement Discord binding became unavailable before Discord confirmed READY.",
        );
      }
      fallbackStatus = await this.#waitForStatus(composed, deadlineMs, signal);
    }
  }

  async #awaitBeforeDeadline<T>(
    operation: Promise<T>,
    deadlineMs: number,
    signal: AbortSignal,
  ): Promise<T> {
    const remainingMs = deadlineMs - this.#scheduler.nowMs();
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      throw this.#activationTimeoutError();
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timerState: { handle?: unknown } = {};
      const cleanup = (): void => {
        if (timerState.handle !== undefined) {
          this.#scheduler.clearTimeout(timerState.handle);
        }
        signal.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(this.#transitionCancelledError());
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      timerState.handle = this.#scheduler.setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(this.#activationTimeoutError());
        }
      }, remainingMs);
      operation.then(
        (value) => {
          if (!settled) {
            settled = true;
            cleanup();
            resolve(value);
          }
        },
        (error: unknown) => {
          if (!settled) {
            settled = true;
            cleanup();
            reject(error);
          }
        },
      );
      if (signal.aborted) {
        onAbort();
      }
    });
  }

  async #waitForStatus(
    composed: ComposedDiscordBindingRuntime<TRuntime>,
    deadlineMs: number,
    signal: AbortSignal,
  ): Promise<DiscordRuntimeStatus> {
    const prior = composed.readiness.latestStatus();
    let unsubscribe = (): void => undefined;
    const nextStatus = new Promise<DiscordRuntimeStatus>((resolve) => {
      unsubscribe = composed.readiness.subscribe(resolve);
      const current = composed.readiness.latestStatus();
      if (current !== undefined && current !== prior) {
        resolve(current);
      }
    });
    try {
      return await this.#awaitBeforeDeadline(nextStatus, deadlineMs, signal);
    } finally {
      unsubscribe();
    }
  }

  async #closeRuntime(runtime: DiscordBindingRuntime | undefined): Promise<unknown> {
    if (runtime === undefined) {
      return undefined;
    }
    const signal = new AbortController().signal;
    try {
      await this.#awaitBeforeDeadline(
        runtime.close(),
        this.#scheduler.nowMs() + this.#activationTimeoutMs,
        signal,
      );
      return undefined;
    } catch (error) {
      return error;
    }
  }

  #activationTimeoutError(): DiscordBindingControllerError {
    return new DiscordBindingControllerError(
      "DISCORD_BINDING_ACTIVATION_FAILED",
      `The Discord binding operation did not complete within ${this.#activationTimeoutMs} ms.`,
    );
  }

  #transitionCancelledError(): DiscordBindingControllerError {
    return new DiscordBindingControllerError(
      "DISCORD_BINDING_CLOSED",
      "The Discord binding transition was cancelled because Main is stopping.",
    );
  }

  #throwIfTransitionAborted(signal: AbortSignal): void {
    if (signal.aborted || this.#closingRequested) {
      throw this.#transitionCancelledError();
    }
  }

  #throwIfDeadlineExpired(deadlineMs: number): void {
    if (!Number.isFinite(deadlineMs) || deadlineMs - this.#scheduler.nowMs() <= 0) {
      throw this.#activationTimeoutError();
    }
  }

  async #restore(
    configuration: MainDiscordBindingConfiguration | null,
    signal: AbortSignal,
  ): Promise<void> {
    this.#throwIfTransitionAborted(signal);
    if (configuration === null) {
      this.#configuration = null;
      this.#runtime = undefined;
      this.#activeRuntimeToken = undefined;
      this.#emit({ status: "unavailable", code: "DISCORD_NOT_CONFIGURED" });
      return;
    }
    const restored = await this.#activate(configuration, true, signal);
    await this.#assertCanAdopt(restored, signal);
    if (signal.aborted || this.#closingRequested) {
      await this.#assertCanAdopt(restored, signal);
    }
    this.#configuration = configuration;
    this.#runtime = restored.runtime;
    this.#activeRuntimeToken = restored.token;
    this.#emit(restored.runtime.status);
  }

  async #rollbackTo(
    configuration: MainDiscordBindingConfiguration | null,
    signal: AbortSignal,
  ): Promise<void> {
    const candidate = this.#runtime;
    this.#configuration = configuration;
    this.#runtime = undefined;
    this.#activeRuntimeToken = undefined;
    const closeError = await this.#closeRuntime(candidate);
    if (closeError !== undefined) {
      this.#faulted = true;
      if (candidate !== undefined) {
        this.#uncertainRuntimes.add(candidate);
      }
      throw new DiscordBindingControllerError(
        "DISCORD_BINDING_ROLLBACK_FAILED",
        "The uncommitted Discord Gateway could not be stopped safely.",
        { cause: closeError },
      );
    }
    if (!this.#closingRequested) {
      this.#throwIfTransitionAborted(signal);
      await this.#restore(configuration, signal);
    }
  }

  #beginAbortShutdown(): void {
    if (this.#abortShutdownPromise !== undefined) {
      return;
    }
    const runtime = this.#runtime;
    this.#runtime = undefined;
    this.#activeRuntimeToken = undefined;
    this.#abortShutdownPromise = (async () => {
      const closeError = await this.#closeRuntime(runtime);
      if (closeError !== undefined) {
        this.#faulted = true;
        if (runtime !== undefined) {
          this.#uncertainRuntimes.add(runtime);
        }
      }
    })();
  }

  #preparedTransition(
    previous: MainDiscordBindingConfiguration | null,
    target: MainDiscordBindingConfiguration | null,
    release: () => void,
    transitionAbort: AbortController,
  ): PreparedDiscordBindingTransition {
    let outcome: "aborted" | "committed" | "pending" | "rolled-back" = "pending";
    const finish = (): void => {
      transitionAbort.signal.removeEventListener("abort", onAbort);
      if (this.#transitionAbort === transitionAbort) {
        this.#transitionAbort = undefined;
      }
      release();
    };
    const onAbort = (): void => {
      if (outcome !== "pending") {
        return;
      }
      outcome = "aborted";
      this.#configuration = previous;
      this.#beginAbortShutdown();
      finish();
    };
    transitionAbort.signal.addEventListener("abort", onAbort, { once: true });
    if (transitionAbort.signal.aborted) {
      onAbort();
    }
    return Object.freeze({
      commit: async () => {
        if (outcome === "aborted") {
          throw this.#transitionCancelledError();
        }
        if (outcome !== "pending") {
          return;
        }
        if (
          !isDeepStrictEqual(this.#configuration, target) ||
          (target === null
            ? this.#runtime !== undefined
            : this.#runtime === undefined || this.#runtime.status.code !== "DISCORD_READY")
        ) {
          throw new DiscordBindingControllerError(
            "DISCORD_BINDING_ACTIVATION_FAILED",
            "The prepared Discord binding was no longer READY when its durable commit completed.",
          );
        }
        outcome = "committed";
        finish();
      },
      rollback: async () => {
        if (outcome === "aborted") {
          return;
        }
        if (outcome !== "pending") {
          return;
        }
        outcome = "rolled-back";
        try {
          if (transitionAbort.signal.aborted || this.#closingRequested) {
            this.#configuration = previous;
          } else {
            await this.#rollbackTo(previous, transitionAbort.signal);
          }
        } catch (error) {
          throw new DiscordBindingControllerError(
            "DISCORD_BINDING_ROLLBACK_FAILED",
            "The previous Discord binding could not be restored.",
            { cause: error },
          );
        } finally {
          finish();
        }
      },
    });
  }

  #noOpPreparedTransition(
    release: () => void,
    transitionAbort: AbortController,
  ): PreparedDiscordBindingTransition {
    let outcome: "aborted" | "committed" | "pending" | "rolled-back" = "pending";
    const finish = (): void => {
      transitionAbort.signal.removeEventListener("abort", onAbort);
      if (this.#transitionAbort === transitionAbort) {
        this.#transitionAbort = undefined;
      }
      release();
    };
    const onAbort = (): void => {
      if (outcome !== "pending") {
        return;
      }
      outcome = "aborted";
      finish();
    };
    transitionAbort.signal.addEventListener("abort", onAbort, { once: true });
    if (transitionAbort.signal.aborted) {
      onAbort();
    }
    return Object.freeze({
      commit: async () => {
        if (outcome === "aborted") {
          throw this.#transitionCancelledError();
        }
        if (outcome !== "pending") {
          return;
        }
        outcome = "committed";
        finish();
      },
      rollback: async () => {
        if (outcome !== "pending") {
          return;
        }
        outcome = "rolled-back";
        finish();
      },
    });
  }

  async #acquire(): Promise<() => void> {
    const previous = this.#tail.catch(() => undefined);
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    this.#tail = previous.then(() => gate);
    await previous;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        releaseGate?.();
      }
    };
  }

  #assertOpen(): void {
    if (this.#closed || this.#closingRequested) {
      throw new DiscordBindingControllerError(
        "DISCORD_BINDING_CLOSED",
        "The Discord binding controller is closed.",
      );
    }
    if (this.#faulted) {
      throw new DiscordBindingControllerError(
        "DISCORD_BINDING_FAULTED",
        "The Discord binding lifecycle is faulted after an uncertain Gateway shutdown. Restart Main before attempting another binding change.",
      );
    }
  }

  #emit(status: DiscordBindingStatus): void {
    try {
      this.#onStatusChange?.(Object.freeze({ ...status }));
    } catch {
      // An observability callback never owns the Discord lifecycle.
    }
  }

  #scheduleLateRuntimeCleanup(runtimeOperation: Promise<TRuntime>): void {
    const cleanup = runtimeOperation
      .then(async (runtime) => {
        const closeError = await this.#closeRuntime(runtime);
        if (closeError !== undefined) {
          this.#faulted = true;
          this.#uncertainRuntimes.add(runtime);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        this.#lateRuntimeCleanups.delete(cleanup);
      });
    this.#lateRuntimeCleanups.add(cleanup);
  }

  async #assertCanAdopt(
    composed: ComposedDiscordBindingRuntime<TRuntime>,
    signal: AbortSignal,
  ): Promise<void> {
    if (!signal.aborted && !this.#closingRequested) {
      return;
    }
    const closeError = await this.#closeRuntime(composed.runtime);
    if (closeError !== undefined) {
      this.#faulted = true;
      this.#uncertainRuntimes.add(composed.runtime);
      throw new DiscordBindingControllerError(
        "DISCORD_BINDING_ROLLBACK_FAILED",
        "A Discord runtime completed after shutdown began and could not be stopped safely.",
        { cause: closeError },
      );
    }
    throw this.#transitionCancelledError();
  }

  async #drainLateRuntimeCleanups(): Promise<unknown> {
    const signal = new AbortController().signal;
    try {
      const deadlineMs = this.#scheduler.nowMs() + this.#activationTimeoutMs;
      while (this.#lateRuntimeCleanups.size > 0) {
        await this.#awaitBeforeDeadline(
          Promise.all([...this.#lateRuntimeCleanups]).then(() => undefined),
          deadlineMs,
          signal,
        );
      }
      if (this.#uncertainRuntimes.size > 0) {
        return new DiscordBindingControllerError(
          "DISCORD_BINDING_ROLLBACK_FAILED",
          "A late Discord runtime could not be stopped safely.",
        );
      }
      return undefined;
    } catch (error) {
      return error;
    }
  }
}

function normalizeConfiguration(
  configuration: MainDiscordBindingConfiguration | null,
): MainDiscordBindingConfiguration | null {
  return configuration === null
    ? null
    : validateMainDiscordBindingConfiguration(structuredClone(configuration));
}

function isActivationStatus(
  status: DiscordRuntimeStatus,
  allowRetryableUnavailable = false,
): boolean {
  return (
    status.code === "DISCORD_READY" ||
    status.code === "DISCORD_RECONNECTING" ||
    status.code === "DISCORD_STARTING" ||
    (allowRetryableUnavailable && status.code === "DISCORD_UNAVAILABLE")
  );
}

function isTerminalActivationStatus(status: DiscordRuntimeStatus): boolean {
  return status.code === "DISCORD_STOPPED" || status.code === "DISCORD_UNAVAILABLE";
}

function createDiscordBindingReadiness(): DiscordBindingReadiness & {
  observe(status: DiscordRuntimeStatus): void;
} {
  let latest: DiscordRuntimeStatus | undefined;
  const observers = new Set<(status: DiscordRuntimeStatus) => void>();
  return {
    latestStatus: () => latest,
    observe(status) {
      const frozen = Object.freeze({ ...status });
      latest = frozen;
      for (const observer of observers) {
        observer(frozen);
      }
    },
    subscribe(observer) {
      observers.add(observer);
      return () => observers.delete(observer);
    },
  };
}

const NODE_ACTIVATION_SCHEDULER: DiscordBindingActivationScheduler = Object.freeze({
  nowMs: () => Date.now(),
  setTimeout(callback: () => void, delayMs: number) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return timer;
  },
  clearTimeout(handle: unknown) {
    clearTimeout(handle as NodeJS.Timeout);
  },
});
