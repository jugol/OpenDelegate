import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  createServicePlan,
  renderPlatformServiceArtifacts,
  type LinuxServiceConfiguration,
  type PlatformServiceConfiguration,
} from "@opendelegate/platform-services";

import { parseArguments } from "../src/cli.ts";
import type { MainConfiguration } from "../src/index.ts";
import {
  composeHeadlessLinuxMainServiceDocument,
  parseMainServiceDocumentArguments,
  writeMainServiceDocument,
} from "../src/main-service-document.ts";
import { ServiceLifecycleCliError } from "../src/service-lifecycle.ts";

test("Main service document arguments keep prepared Worker input and create-new output explicit", () => {
  assert.deepEqual(
    parseMainServiceDocumentArguments([
      "--worker-config",
      "worker.json",
      "--output",
      "main.json",
      "--home",
      "main-home",
    ]),
    {
      workerConfigurationPath: resolve("worker.json"),
      outputPath: resolve("main.json"),
      home: resolve("main-home"),
    },
  );
  assert.throws(
    () => parseMainServiceDocumentArguments(["--worker-config", "worker.json"]),
    (error: unknown) =>
      error instanceof ServiceLifecycleCliError && error.code === "SERVICE_ARGUMENT_INVALID",
  );
  assert.deepEqual(
    parseArguments([
      "service",
      "document",
      "--worker-config",
      "worker.json",
      "--output",
      "main.json",
      "--home",
      "main-home",
    ]).serviceDocument,
    {
      workerConfigurationPath: resolve("worker.json"),
      outputPath: resolve("main.json"),
      home: resolve("main-home"),
    },
  );
});

test("a headless Linux Main derives its exact native topology from the co-located Worker", () => {
  const worker = headlessWorkerConfiguration();
  const main = mainConfiguration();
  const document = composeHeadlessLinuxMainServiceDocument({
    main,
    home: worker.paths.stateRoot,
    workerConfiguration: worker,
  });

  assert.equal(document.platform, "linux");
  if (document.platform !== "linux") {
    throw new Error("Expected a Linux Main service document.");
  }
  assert.equal(document.role, "main");
  assert.equal(document.helperSecretBinding, null);
  assert.deepEqual(document.bundle, worker.bundle);
  assert.deepEqual(document.paths, worker.paths);
  assert.deepEqual(document.serviceIdentity, worker.serviceIdentity);
  assert.deepEqual(document.systemdCredential, worker.systemdCredential);
  assert.deepEqual(document.ipcTrust, worker.ipcTrust);
  assert.deepEqual(document.ownerSession.adminAutoOpen, { enabled: false });
  const artifacts = renderPlatformServiceArtifacts(document);
  assert.equal(artifacts.helper, null);
  assert.match(artifacts.core.manifest.content, /"--role" "main"/u);
  assert.equal(
    createServicePlan({ operation: "install", configuration: document }).steps.some((step) =>
      step.id.includes("helper"),
    ),
    false,
  );
});

test("Main service composition rejects local identity, credential, source, and helper drift", () => {
  const worker = headlessWorkerConfiguration();
  const main = mainConfiguration();
  const attempts: readonly {
    readonly label: string;
    readonly main?: MainConfiguration;
    readonly home?: string;
    readonly worker?: PlatformServiceConfiguration;
  }[] = [
    {
      label: "identity",
      main: { ...main, deviceId: "device_other" },
    },
    {
      label: "state root",
      home: "/var/lib/other/state",
    },
    {
      label: "named systemd credential",
      main: {
        ...main,
        secretBackend: { ...main.secretBackend, credentialName: "other-key" },
      },
    },
    {
      label: "encrypted systemd credential source",
      main: {
        ...main,
        secretBackend: {
          ...main.secretBackend,
          encryptedCredentialFile: "/etc/credstore.encrypted/other.cred",
        },
      },
    },
    {
      label: "headless Linux Worker",
      worker: graphicalWorkerConfiguration(),
    },
  ];

  for (const attempt of attempts) {
    assert.throws(
      () =>
        composeHeadlessLinuxMainServiceDocument({
          main: attempt.main ?? main,
          home: attempt.home ?? worker.paths.stateRoot,
          workerConfiguration: attempt.worker ?? worker,
        }),
      (error: unknown) =>
        error instanceof ServiceLifecycleCliError &&
        error.message.toLowerCase().includes(attempt.label.toLowerCase()),
      attempt.label,
    );
  }
});

test("Main service document output is create-new and never replaces reviewed input", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-main-service-document-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputPath = join(root, "main-service.json");
  const configuration = composeHeadlessLinuxMainServiceDocument({
    main: mainConfiguration(),
    home: headlessWorkerConfiguration().paths.stateRoot,
    workerConfiguration: headlessWorkerConfiguration(),
  });

  await writeMainServiceDocument({ outputPath, configuration });
  const original = await readFile(outputPath, "utf8");
  await assert.rejects(
    writeMainServiceDocument({ outputPath, configuration }),
    (error: unknown) =>
      error instanceof ServiceLifecycleCliError && error.message.includes("will not overwrite"),
  );
  assert.equal(await readFile(outputPath, "utf8"), original);
});

function mainConfiguration(): MainConfiguration & {
  readonly secretBackend: {
    readonly backend: "linux-systemd-credential-vault";
    readonly credentialName: string;
    readonly encryptedCredentialFile: string;
    readonly vaultRoot: string;
  };
} {
  return {
    schemaVersion: 1,
    instanceId: "personal",
    deviceId: "device-main",
    main: {
      host: "0.0.0.0",
      port: 4380,
      origin: "https://main.example.test",
      tls: {
        certificatePath: "/etc/opendelegate/tls/main.pem",
        privateKeyPath: "/etc/opendelegate/tls/main-key.pem",
      },
    },
    database: { adapter: "sqlite" },
    secretBackend: {
      backend: "linux-systemd-credential-vault",
      credentialName: "opendelegate-vault-key",
      encryptedCredentialFile: "/etc/credstore.encrypted/opendelegate-vault-key.cred",
      vaultRoot: "/var/lib/opendelegate-runtime/state/secrets/systemd-vault",
    },
    adminRoot: "/opt/opendelegate/current/apps/admin-web/dist",
  };
}

function headlessWorkerConfiguration(): LinuxServiceConfiguration {
  return {
    platform: "linux",
    instanceId: "personal",
    deviceId: "device-main",
    role: "worker",
    bundle: {
      version: "1.2.3",
      sourceDirectory: "/opt/opendelegate-candidate",
      checksum: `sha256:${"a".repeat(64)}`,
    },
    paths: {
      sourceCheckoutDirectory: "/opt/opendelegate-candidate",
      installRoot: "/opt/opendelegate",
      stateRoot: "/var/lib/opendelegate-runtime/state",
      authorityRoot: "/var/lib/opendelegate-runtime/authority",
      runtimeRoot: "/var/lib/opendelegate-runtime/run",
      logRoot: "/var/lib/opendelegate-runtime/logs",
    },
    ownerSession: {
      userName: "owner",
      stableUserId: "1000",
      uid: 1000,
      homeDirectory: "/home/owner",
      adminAutoOpen: { enabled: false },
    },
    serviceIdentity: { userName: "opendelegate", groupName: "opendelegate" },
    helperSecretBinding: null,
    systemdCredential: {
      credentialName: "opendelegate-vault-key",
      encryptedSourcePath: "/etc/credstore.encrypted/opendelegate-vault-key.cred",
    },
    ipcTrust: {
      protocolVersion: 2,
      core: {
        keyId: "sha256:f9acccda515ce25409e456e45f25417bcda0c1cc0255490965f6ab59d5a81b48",
        publicKeySpkiBase64Url: "MCowBQYDK2VwAyEAjBmMzBDNPDdi86mu7kAWdhSpEsUBySgfGN0q2ganv5I",
      },
    },
    secretReferences: {
      coreIpcSigningKey: "secret://worker/opendelegate/session-helper-core-signing/v2",
    },
    health: { endpoint: "http://127.0.0.1:43190/health/live", timeoutMs: 30_000 },
    retainPreviousVersions: 2,
  };
}

function graphicalWorkerConfiguration(): LinuxServiceConfiguration {
  const headless = headlessWorkerConfiguration();
  return {
    ...headless,
    helperSecretBinding: {
      backend: "linux-secret-service",
      secretToolPath: "/usr/bin/secret-tool",
    },
    ipcTrust: {
      ...headless.ipcTrust,
      helper: {
        keyId: "sha256:b0308f5b2e753b15572359e7e9cd8da8400839df95052ddc21d9711554750c2f",
        publicKeySpkiBase64Url: "MCowBQYDK2VwAyEAli20Wxft7Lox4PLDh_IcMGjN265l-fNMneRfYNWYnko",
      },
    },
    secretReferences: {
      ...headless.secretReferences,
      helperIpcSigningKey: "secret://worker/opendelegate/session-helper-owner-signing/v2",
    },
  };
}
