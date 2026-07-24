#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createLocalClaimApp } from "@opendelegate/control-plane";
import { OwnerAuthError } from "@opendelegate/owner-auth";

import {
  createMainRuntime,
  initializeMainHome,
  listenMainRuntime,
  loadMainConfiguration,
  MainRuntimeError,
  resolveRuntimePaths,
  type MainDatabaseConfiguration,
  type MainListenerConfiguration,
  type MainRuntime,
} from "./index.ts";
import {
  ReleaseIdentityError,
  resolveRuntimeIdentity,
  type RuntimeIdentity,
} from "./release-identity.ts";
import {
  cleanupFailureFor,
  closeAfterPrimaryFailure,
  closeMainResources,
  MainShutdownError,
} from "./shutdown.ts";

const cliPath = fileURLToPath(import.meta.url);
const cliDirectory = dirname(cliPath);
const bundledRelease = extname(cliPath) !== ".ts";
const installationRoot = bundledRelease
  ? resolve(cliDirectory, "../..")
  : resolve(cliDirectory, "../../..");
const defaultAdminRoot = bundledRelease
  ? resolve(installationRoot, "apps/admin-web/dist")
  : resolve(cliDirectory, "../../admin-web/dist");

async function run(arguments_: readonly string[]): Promise<void> {
  const identity = await resolveRuntimeIdentity({
    installationRoot,
    bundled: bundledRelease,
  });
  const parsed = parseArguments(arguments_);
  switch (parsed.command) {
    case "init":
      await runInit(parsed, identity);
      return;
    case "serve":
      await runServe(parsed, identity);
      return;
    case "status":
      await runStatus(parsed);
      return;
    case "version":
      printVersion(identity);
      return;
    case "help":
      printHelp();
      return;
  }
}

export interface ParsedArguments {
  readonly command: "help" | "init" | "serve" | "status" | "version";
  readonly home?: string;
  readonly adminRoot?: string;
  readonly database?: MainDatabaseConfiguration;
  readonly listener?: MainListenerConfiguration;
  readonly open: boolean;
}

export function parseArguments(values: readonly string[]): ParsedArguments {
  const commandValue = values[0] ?? "help";
  const command =
    commandValue === "init" || commandValue === "serve" || commandValue === "status"
      ? commandValue
      : commandValue === "help" || commandValue === "--help" || commandValue === "-h"
        ? "help"
        : commandValue === "--version" || commandValue === "-v" || commandValue === "version"
          ? "version"
          : undefined;
  if (command === undefined) {
    throw new MainRuntimeError("CONFIG_INVALID", `Unknown command: ${commandValue}.`);
  }

  let home: string | undefined;
  let adminRoot: string | undefined;
  let databaseAdapter: "sqlite" | "postgresql" | undefined;
  let databaseUriEnvironment: string | undefined;
  let databaseSchema: string | undefined;
  let listenHost: string | undefined;
  let listenPort: number | undefined;
  let listenOrigin: string | undefined;
  let tlsCertificatePath: string | undefined;
  let tlsPrivateKeyPath: string | undefined;
  let open = false;
  for (let index = 1; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--open") {
      open = true;
      continue;
    }
    if (
      value === "--home" ||
      value === "--admin-root" ||
      value === "--database" ||
      value === "--database-uri-environment" ||
      value === "--database-schema" ||
      value === "--listen-host" ||
      value === "--listen-port" ||
      value === "--listen-origin" ||
      value === "--tls-certificate" ||
      value === "--tls-private-key"
    ) {
      const target = values[index + 1];
      if (target === undefined || target.startsWith("--") || target.trim() === "") {
        throw new MainRuntimeError("CONFIG_INVALID", `${value} requires a value.`);
      }
      switch (value) {
        case "--home":
          home = resolve(target);
          break;
        case "--admin-root":
          adminRoot = resolve(target);
          break;
        case "--database":
          if (target !== "sqlite" && target !== "postgresql") {
            throw new MainRuntimeError(
              "CONFIG_INVALID",
              "--database must be sqlite or postgresql.",
            );
          }
          databaseAdapter = target;
          break;
        case "--database-uri-environment":
          databaseUriEnvironment = target;
          break;
        case "--database-schema":
          databaseSchema = target;
          break;
        case "--listen-host":
          listenHost = target;
          break;
        case "--listen-port": {
          const parsedPort = Number(target);
          if (!Number.isSafeInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
            throw new MainRuntimeError(
              "CONFIG_INVALID",
              "--listen-port must be an integer from 1 through 65535.",
            );
          }
          listenPort = parsedPort;
          break;
        }
        case "--listen-origin":
          listenOrigin = target;
          break;
        case "--tls-certificate":
          tlsCertificatePath = resolve(target);
          break;
        case "--tls-private-key":
          tlsPrivateKeyPath = resolve(target);
          break;
      }
      index += 1;
      continue;
    }
    throw new MainRuntimeError("CONFIG_INVALID", `Unknown option: ${String(value)}.`);
  }
  const database = parseDatabaseOptions({
    databaseAdapter,
    databaseSchema,
    databaseUriEnvironment,
  });
  const listener = parseListenerOptions({
    listenHost,
    listenOrigin,
    listenPort,
    tlsCertificatePath,
    tlsPrivateKeyPath,
  });
  if (
    command !== "init" &&
    (adminRoot !== undefined || database !== undefined || listener !== undefined)
  ) {
    throw new MainRuntimeError(
      "CONFIG_INVALID",
      "Database, listener, TLS, and Admin bundle options are available only with init.",
    );
  }
  if (command !== "init" && command !== "serve" && open) {
    throw new MainRuntimeError("CONFIG_INVALID", "--open is available only with init or serve.");
  }
  return {
    command,
    open,
    ...(home === undefined ? {} : { home }),
    ...(adminRoot === undefined ? {} : { adminRoot }),
    ...(database === undefined ? {} : { database }),
    ...(listener === undefined ? {} : { listener }),
  };
}

function parseDatabaseOptions(input: {
  readonly databaseAdapter: "sqlite" | "postgresql" | undefined;
  readonly databaseSchema: string | undefined;
  readonly databaseUriEnvironment: string | undefined;
}): MainDatabaseConfiguration | undefined {
  if (
    input.databaseAdapter === undefined &&
    input.databaseSchema === undefined &&
    input.databaseUriEnvironment === undefined
  ) {
    return undefined;
  }
  if (input.databaseAdapter === "sqlite") {
    if (input.databaseSchema !== undefined || input.databaseUriEnvironment !== undefined) {
      throw new MainRuntimeError(
        "CONFIG_INVALID",
        "SQLite does not accept PostgreSQL environment or schema options.",
      );
    }
    return { adapter: "sqlite" };
  }
  if (
    input.databaseAdapter !== "postgresql" ||
    input.databaseUriEnvironment === undefined ||
    !/^[A-Z][A-Z0-9_]{0,127}$/.test(input.databaseUriEnvironment) ||
    (input.databaseSchema !== undefined &&
      !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(input.databaseSchema))
  ) {
    throw new MainRuntimeError(
      "CONFIG_INVALID",
      "PostgreSQL requires --database postgresql and a valid --database-uri-environment name.",
    );
  }
  return {
    adapter: "postgresql",
    uriEnvironment: input.databaseUriEnvironment,
    ...(input.databaseSchema === undefined ? {} : { schema: input.databaseSchema }),
  };
}

function parseListenerOptions(input: {
  readonly listenHost: string | undefined;
  readonly listenOrigin: string | undefined;
  readonly listenPort: number | undefined;
  readonly tlsCertificatePath: string | undefined;
  readonly tlsPrivateKeyPath: string | undefined;
}): MainListenerConfiguration | undefined {
  if (Object.values(input).every((value) => value === undefined)) {
    return undefined;
  }
  if (
    input.listenHost === undefined ||
    input.listenOrigin === undefined ||
    input.listenPort === undefined
  ) {
    throw new MainRuntimeError(
      "CONFIG_INVALID",
      "A custom listener requires --listen-host, --listen-port, and --listen-origin together.",
    );
  }
  if ((input.tlsCertificatePath === undefined) !== (input.tlsPrivateKeyPath === undefined)) {
    throw new MainRuntimeError(
      "CONFIG_INVALID",
      "--tls-certificate and --tls-private-key must be supplied together.",
    );
  }
  return {
    host: input.listenHost,
    port: input.listenPort,
    origin: input.listenOrigin,
    ...(input.tlsCertificatePath === undefined || input.tlsPrivateKeyPath === undefined
      ? {}
      : {
          tls: {
            certificatePath: input.tlsCertificatePath,
            privateKeyPath: input.tlsPrivateKeyPath,
          },
        }),
  };
}

async function runInit(options: ParsedArguments, identity: RuntimeIdentity): Promise<void> {
  const initialized = await initializeMainHome({
    ...(options.home === undefined ? {} : { home: options.home }),
    adminRoot: options.adminRoot ?? defaultAdminRoot,
    ...(options.adminRoot === undefined ? {} : { expectedAdminRoot: options.adminRoot }),
    ...(options.database === undefined ? {} : { database: options.database }),
    ...(options.listener === undefined ? {} : { listener: options.listener }),
    sourceCheckout: installationRoot,
  });
  writeEvent("main.initialized", {
    created: initialized.created,
    configurationFile: initialized.paths.configurationFile,
    origin: initialized.configuration.main.origin,
  });

  const runtime = await createAndListen(
    initialized.configuration,
    initialized.paths.home,
    identity,
  );
  let claimListener: Awaited<ReturnType<typeof startClaimListener>>;
  try {
    claimListener = await startClaimListener(runtime);
  } catch (error) {
    await closeAfterPrimaryFailure(error, [
      { operation: "main-runtime", close: () => runtime.close() },
    ]);
  }
  if (claimListener !== undefined && options.open) {
    openBrowser(claimListener.origin);
  }
  await waitForShutdown(runtime, claimListener?.close);
}

async function runServe(options: ParsedArguments, identity: RuntimeIdentity): Promise<void> {
  const paths = resolveRuntimePaths({
    ...(options.home === undefined ? {} : { home: options.home }),
    sourceCheckout: installationRoot,
  });
  const configuration = await loadMainConfiguration(paths.configurationFile);
  const runtime = await createAndListen(configuration, paths.home, identity);
  if (options.open) {
    openBrowser(configuration.main.origin);
  }
  await waitForShutdown(runtime);
}

async function runStatus(options: ParsedArguments): Promise<void> {
  const paths = resolveRuntimePaths({
    ...(options.home === undefined ? {} : { home: options.home }),
    sourceCheckout: installationRoot,
  });
  const configuration = await loadMainConfiguration(paths.configurationFile);
  const response = await fetch(`${configuration.main.origin}/health/live`, {
    signal: AbortSignal.timeout(5_000),
  });
  const body: unknown = await response.json();
  process.stdout.write(
    `${JSON.stringify({
      reachable: response.ok,
      status: response.status,
      health: body,
    })}\n`,
  );
  if (!response.ok) {
    process.exitCode = 1;
  }
}

async function createAndListen(
  configuration: Awaited<ReturnType<typeof loadMainConfiguration>>,
  home: string,
  identity: RuntimeIdentity,
): Promise<MainRuntime> {
  const runtime = await createMainRuntime({
    configuration,
    home,
    build: identity.build,
    releaseChannel: identity.releaseChannel,
    sourceCheckout: installationRoot,
  });
  try {
    const listening = await listenMainRuntime(runtime);
    writeEvent("main.listening", {
      address: listening.address,
      origin: configuration.main.origin,
    });
    return listening;
  } catch (error) {
    return closeAfterPrimaryFailure(error, [
      { operation: "main-runtime", close: () => runtime.close() },
    ]);
  }
}

async function startClaimListener(runtime: MainRuntime): Promise<
  | {
      readonly origin: string;
      readonly close: () => Promise<void>;
    }
  | undefined
> {
  let issued;
  try {
    issued = await runtime.ownerAuth.issueInitialClaim({
      channel: "local-bootstrap",
    });
  } catch (error) {
    if (error instanceof OwnerAuthError && error.code === "CLAIM_INVALID") {
      writeEvent("owner.claim.skipped", { reason: "owner-already-claimed" });
      return undefined;
    }
    if (error instanceof OwnerAuthError && error.code === "CLAIM_ALREADY_ACTIVE") {
      writeEvent("owner.claim.pending", {
        reason: "an-unexpired-local-claim-already-exists",
        retryAfter: "at-most-10-minutes",
      });
      return undefined;
    }
    throw error;
  }

  const port = runtime.configuration.main.port + 1;
  if (port > 65_535) {
    throw new MainRuntimeError(
      "CONFIG_INVALID",
      "The Main port leaves no adjacent local owner-claim port.",
    );
  }
  const origin = `http://127.0.0.1:${port}`;
  const claimListener: {
    app?: Awaited<ReturnType<typeof createLocalClaimApp>>;
  } = {};
  const claimApp = await createLocalClaimApp({
    ownerAuth: runtime.ownerAuth,
    allowedOrigins: [origin],
    onClaimed: async () => {
      writeEvent("owner.claim.completed", {
        redirectOrigin: runtime.configuration.main.origin,
      });
      await claimListener.app?.close();
    },
  });
  claimListener.app = claimApp;
  registerClaimPage(claimApp, issued.claimToken, runtime.configuration.main.origin);
  try {
    await claimApp.listen({ host: "127.0.0.1", port });
  } catch (error) {
    await closeAfterPrimaryFailure(error, [
      { operation: "owner-claim-listener", close: () => claimApp.close() },
    ]);
  }
  writeEvent("owner.claim.ready", {
    expiresAt: new Date(issued.expiresAt).toISOString(),
    origin,
  });
  return {
    origin,
    close: async () => {
      await claimListener.app?.close();
    },
  };
}

function registerClaimPage(
  app: Awaited<ReturnType<typeof createLocalClaimApp>>,
  claimToken: string,
  mainOrigin: string,
): void {
  app.get("/", async (_request, reply) => {
    void reply.header("cache-control", "no-store");
    void reply.header("referrer-policy", "no-referrer");
    void reply.type("text/html; charset=utf-8");
    return reply.send(`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claim OpenDelegate</title>
<body>
  <main>
    <h1>Claim this OpenDelegate Main</h1>
    <p><strong>Pre-release software:</strong> no supported OpenDelegate release is published.</p>
    <p>Create the local owner credential. Save the recovery codes shown next.</p>
    <form id="claim" data-claim="${escapeHtml(claimToken)}" data-main="${escapeHtml(mainOrigin)}">
      <label>Passphrase <input name="passphrase" type="password" minlength="12" maxlength="1024" required autocomplete="new-password"></label>
      <button type="submit">Create owner</button>
    </form>
    <pre id="result" aria-live="polite"></pre>
  </main>
  <script src="/claim.js" defer></script>
</body>
</html>`);
  });
  app.get("/claim.js", async (_request, reply) => {
    void reply.header("cache-control", "no-store");
    void reply.header("referrer-policy", "no-referrer");
    void reply.type("text/javascript; charset=utf-8");
    return reply.send(`"use strict";
const form = document.querySelector("#claim");
const result = document.querySelector("#result");
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const passphrase = new FormData(form).get("passphrase");
  const response = await fetch("/api/v1/auth/claim", {
    method: "POST",
    credentials: "omit",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin"
    },
    body: JSON.stringify({ claimToken: form.dataset.claim, passphrase })
  });
  const body = await response.json();
  if (!response.ok) {
    result.textContent = body.title || "Claim failed.";
    return;
  }
  form.remove();
  result.textContent = "Save these recovery codes now:\\n\\n" +
    body.recoveryCodes.join("\\n") +
    "\\n\\nThen open " + form.dataset.main;
});`);
  });
}

export async function waitForShutdown(
  runtime: Pick<MainRuntime, "close">,
  closeClaim?: () => Promise<void>,
): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    const watchStdin = process.env["OPENDELEGATE_TEST_EXIT_ON_STDIN_END"] === "1";
    const stdinWasFlowing = process.stdin.readableFlowing === true;
    let triggered = false;
    const stop = (): void => {
      if (triggered) {
        return;
      }
      triggered = true;
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      if (watchStdin) {
        process.stdin.off("end", stop);
        if (!stdinWasFlowing) {
          process.stdin.pause();
        }
      }
      resolvePromise();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    if (watchStdin) {
      process.stdin.once("end", stop);
      process.stdin.resume();
    }
  });
  await shutdownMainRuntime(runtime, closeClaim);
}

export async function shutdownMainRuntime(
  runtime: Pick<MainRuntime, "close">,
  closeClaim?: () => Promise<void>,
): Promise<void> {
  await closeMainResources([
    { operation: "main-runtime", close: () => runtime.close() },
    ...(closeClaim === undefined ? [] : [{ operation: "owner-claim-listener", close: closeClaim }]),
  ]);
  writeEvent("main.stopped", {});
}

function openBrowser(url: string): void {
  const command =
    process.platform === "win32"
      ? {
          file: "powershell.exe",
          arguments: ["-NoProfile", "-Command", "Start-Process -LiteralPath $args[0]", url],
        }
      : process.platform === "darwin"
        ? { file: "open", arguments: [url] }
        : { file: "xdg-open", arguments: [url] };
  const child = spawn(command.file, command.arguments, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

function writeEvent(event: string, fields: Readonly<Record<string, unknown>>): void {
  process.stdout.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "info",
      event,
      ...fields,
    })}\n`,
  );
}

function sanitizeCliError(error: unknown): {
  readonly level: "error";
  readonly code: string;
  readonly message: string;
} {
  if (
    error instanceof MainRuntimeError ||
    error instanceof OwnerAuthError ||
    error instanceof MainShutdownError ||
    error instanceof ReleaseIdentityError
  ) {
    return {
      level: "error",
      code: error.code,
      message: error.message,
    };
  }
  return {
    level: "error",
    code: "INTERNAL_ERROR",
    message: "OpenDelegate could not complete the command.",
  };
}

export function reportCliFailure(error: unknown): void {
  const publicError = sanitizeCliError(error);
  process.stderr.write(`${JSON.stringify(publicError)}\n`);
  const cleanupError = cleanupFailureFor(error);
  if (cleanupError !== undefined) {
    process.stderr.write(`${JSON.stringify(sanitizeCliError(cleanupError))}\n`);
  }
  process.exitCode = 1;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function printHelp(): void {
  process.stdout.write(`OpenDelegate

Usage:
  opendelegate init [--home PATH] [--admin-root PATH] [--open]
    [--database sqlite]
    [--database postgresql --database-uri-environment ENV_NAME [--database-schema NAME]]
    [--listen-host HOST --listen-port PORT --listen-origin ORIGIN]
    [--tls-certificate PATH --tls-private-key PATH]
  opendelegate serve [--home PATH] [--open]
  opendelegate status [--home PATH]
  opendelegate version

Runtime state and credentials are never written into the source checkout.
`);
}

function printVersion(identity: RuntimeIdentity): void {
  process.stdout.write(`OpenDelegate ${identity.build.version}\n`);
}

const invokedFile = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedFile === resolve(cliPath)) {
  void run(process.argv.slice(2)).catch(reportCliFailure);
}
