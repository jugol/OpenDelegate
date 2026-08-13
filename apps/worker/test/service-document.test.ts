import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { test } from "node:test";

import { buildWorkerServiceDocument, verifyWindowsOwnerProfile } from "../src/service-document.ts";
import { resolveWorkerPaths, WorkerAppError } from "../src/worker-app.ts";

const SERVICE_SID = "S-1-5-80-611375048-4065716985-2142524325-1255325421-3479547702";

test("a Windows owner profile must match the OS account instead of USERPROFILE text", () => {
  assert.equal(
    verifyWindowsOwnerProfile("WORKSTATION\\owner", {
      username: "owner",
      homedir: "C:\\Users\\owner",
    }),
    "C:\\Users\\owner",
  );
  assert.throws(
    () =>
      verifyWindowsOwnerProfile("WORKSTATION\\owner", {
        username: "another-owner",
        homedir: "C:\\Users\\forged",
      }),
    (error: unknown) => error instanceof WorkerAppError && error.code === "CONFIG_INVALID",
  );
  assert.throws(
    () =>
      verifyWindowsOwnerProfile("WORKSTATION\\owner", {
        username: "owner",
        homedir: "C:\\Users\\owner\\..\\forged",
      }),
    (error: unknown) => error instanceof WorkerAppError && error.code === "CONFIG_INVALID",
  );
});

test("a staged Windows Worker composes its service document from durable public bindings", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-service-document-"));
  const bundle = join(root, "bundle");
  const dataRoot = join(root, "runtime-data");
  const paths = resolveWorkerPaths({
    sourceCheckoutRoot: bundle,
    home: join(dataRoot, "state"),
  });
  const installRoot = join(root, "installed");
  const ownerVaultRoot = join(root, "owner-vault");
  const ownerHome = join(root, "owner");
  const codexHome = join(ownerHome, ".codex");
  const claudeHome = join(ownerHome, ".claude");
  const core = keyPin();
  const helper = keyPin();

  try {
    await mkdir(paths.configDirectory, { recursive: true });
    await mkdir(bundle, { recursive: true });
    await writeFile(
      paths.configFile,
      `${JSON.stringify({
        schemaVersion: 1,
        deviceId: "device-service-document",
        workerId: "worker-primary",
        mainDeviceId: "device-main",
        keyId: "device-key-service-document",
        certificateGeneration: 1,
        certificatePem: "-----BEGIN CERTIFICATE-----\nworker\n-----END CERTIFICATE-----",
        certificateAuthorityPem:
          "-----BEGIN CERTIFICATE-----\nauthority\n-----END CERTIFICATE-----",
        expectedMainSpkiSha256: `sha256:${"A".repeat(43)}`,
        transportProfile: {
          deviceId: "device-main",
          endpoints: [
            {
              endpointId: "main-private",
              label: "Main private route",
              kind: "wss",
              url: "wss://main.example.test/api/v1/device/channel",
              credentialRef: "device-identity",
            },
          ],
        },
        secretBackend: {
          backend: "windows-service-dpapi",
          handoffRoot: join(dataRoot, "state", "secrets", "handoff"),
          serviceName: "OpenDelegate-personal",
          serviceSid: SERVICE_SID,
          vaultRoot: join(dataRoot, "state", "secrets", "service"),
          servicePreparation: {
            schemaVersion: 1,
            sealing: "service-account",
            ownerHelperSecretBinding: {
              backend: "windows-dpapi",
              vaultRoot: ownerVaultRoot,
            },
            ipcTrust: { core, helper },
          },
        },
        agent: {
          provider: "auto",
          codexHome,
          claudeHome,
          allowUntestedVersion: false,
        },
        workspaces: [],
        createdAt: "2026-08-08T00:00:00.000Z",
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await writeFile(
      join(bundle, "release-metadata.json"),
      `${JSON.stringify({ productVersion: "0.1.0" })}\n`,
    );
    await writeFile(join(bundle, "SHA256SUMS"), "fixture  payload\n");

    const document = await buildWorkerServiceDocument({
      paths,
      bundleDirectory: bundle,
      installRoot,
      dataRoot,
      instanceId: "personal",
      healthPort: 43_190,
      sourceCheckoutRoot: bundle,
      hostPlatform: "win32",
      ownerSession: {
        userName: "WORKSTATION\\owner",
        stableUserId: "S-1-5-21-1000",
        homeDirectory: win32.resolve(ownerHome),
      },
    });

    assert.equal(document.platform, "windows");
    assert.equal(document.ownerSession.homeDirectory, win32.resolve(ownerHome));
    assert.deepEqual(document.ipcTrust, { protocolVersion: 2, core, helper });
    assert.equal(document.bundle.sourceDirectory, win32.resolve(bundle));
    assert.equal(document.helperSecretBinding.vaultRoot, win32.resolve(ownerVaultRoot));
    assert.equal(document.serviceSecretBinding?.serviceSid, SERVICE_SID);
    assert.equal(
      document.agentSandbox?.codexSandboxBinDirectory,
      win32.join(win32.resolve(paths.stateDirectory), "providers", "codex", ".sandbox-bin"),
    );
    assert.deepEqual(document.agentProviderAccess, {
      codexHomeDirectory: win32.resolve(codexHome),
      codexServiceHomeDirectory: win32.join(
        win32.resolve(paths.stateDirectory),
        "providers",
        "codex",
      ),
      claudeHomeDirectory: win32.resolve(claudeHome),
    });
    assert.equal(
      document.serviceSecretBinding?.handoffRoot,
      win32.resolve(join(dataRoot, "state", "secrets", "handoff")),
    );
    assert.equal(
      document.serviceSecretBinding?.vaultRoot,
      win32.resolve(join(dataRoot, "state", "secrets", "service")),
    );
    assert.equal(
      document.bundle.checksum,
      `sha256:${createHash("sha256").update("fixture  payload\n").digest("hex")}`,
    );

    await assert.rejects(
      buildWorkerServiceDocument({
        paths,
        bundleDirectory: bundle,
        installRoot,
        dataRoot: join(root, "different-runtime-data"),
        instanceId: "personal",
        healthPort: 43_190,
        sourceCheckoutRoot: bundle,
        hostPlatform: "win32",
        ownerSession: {
          userName: "WORKSTATION\\owner",
          stableUserId: "S-1-5-21-1000",
        },
      }),
      (error: unknown) =>
        error instanceof WorkerAppError && error.message.includes("DATA_ROOT/state"),
    );

    await writeFile(join(bundle, "release-metadata.json"), " ".repeat(1024 * 1024 + 1));
    await assert.rejects(
      buildWorkerServiceDocument({
        paths,
        bundleDirectory: bundle,
        installRoot,
        dataRoot,
        instanceId: "personal",
        healthPort: 43_190,
        sourceCheckoutRoot: bundle,
        hostPlatform: "win32",
        ownerSession: {
          userName: "WORKSTATION\\owner",
          stableUserId: "S-1-5-21-1000",
        },
      }),
      (error: unknown) =>
        error instanceof WorkerAppError &&
        error.code === "CONFIG_INVALID" &&
        error.message.includes("stable, bounded"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a systemd-enrolled headless Linux Worker composes a core-only service document", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-linux-service-document-"));
  const bundle = join(root, "bundle");
  const serviceBundle = posixTestPath(bundle);
  const dataRoot = join(root, "runtime-data");
  const serviceDataRoot = posixTestPath(dataRoot);
  const paths = resolveWorkerPaths({
    sourceCheckoutRoot: bundle,
    home: join(dataRoot, "state"),
  });
  const core = keyPin();
  try {
    await mkdir(paths.configDirectory, { recursive: true });
    await mkdir(bundle, { recursive: true });
    await writeFile(
      paths.configFile,
      `${JSON.stringify({
        schemaVersion: 1,
        deviceId: "device-linux-headless",
        workerId: "worker-primary",
        mainDeviceId: "device-main",
        keyId: "device-key-linux",
        certificateGeneration: 1,
        certificatePem: "-----BEGIN CERTIFICATE-----\nworker\n-----END CERTIFICATE-----",
        certificateAuthorityPem:
          "-----BEGIN CERTIFICATE-----\nauthority\n-----END CERTIFICATE-----",
        expectedMainSpkiSha256: `sha256:${"A".repeat(43)}`,
        transportProfile: {
          deviceId: "device-main",
          endpoints: [
            {
              endpointId: "main-private",
              label: "Main private route",
              kind: "wss",
              url: "wss://main.example.test/api/v1/device/channel",
              credentialRef: "device-identity",
            },
          ],
        },
        secretBackend: {
          backend: "linux-systemd-credential-vault",
          credentialName: "opendelegate-vault-key",
          encryptedCredentialFile: "/etc/credstore.encrypted/opendelegate-vault-key.cred",
          vaultRoot: "/var/lib/opendelegate-runtime/state/secrets/systemd-vault",
          servicePreparation: {
            schemaVersion: 1,
            mode: "headless",
            serviceIdentity: {
              userName: "opendelegate",
              groupName: "opendelegate",
              uid: 995,
            },
            ipcTrust: { core },
          },
        },
        agent: { provider: "auto", allowUntestedVersion: false },
        workspaces: [],
        createdAt: "2026-08-08T00:00:00.000Z",
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await writeFile(
      join(bundle, "release-metadata.json"),
      `${JSON.stringify({ productVersion: "0.1.0" })}\n`,
    );
    await writeFile(join(bundle, "SHA256SUMS"), "fixture  payload\n");

    const document = await buildWorkerServiceDocument({
      paths,
      bundleDirectory: serviceBundle,
      installRoot: "/opt/opendelegate",
      dataRoot: serviceDataRoot,
      instanceId: "personal",
      healthPort: 43_190,
      sourceCheckoutRoot: serviceBundle,
      hostPlatform: "linux",
      ownerSession: {
        userName: "owner",
        stableUserId: "1000",
        uid: 1000,
        homeDirectory: "/home/owner",
      },
    });

    assert.equal(document.platform, "linux");
    assert.equal(document.helperSecretBinding, null);
    assert.deepEqual(document.ipcTrust, { protocolVersion: 2, core });
    assert.equal(Object.hasOwn(document.secretReferences, "helperIpcSigningKey"), false);
    assert.deepEqual(document.systemdCredential, {
      credentialName: "opendelegate-vault-key",
      encryptedSourcePath: "/etc/credstore.encrypted/opendelegate-vault-key.cred",
    });
    assert.deepEqual(document.serviceIdentity, {
      userName: "opendelegate",
      groupName: "opendelegate",
    });
    await assert.rejects(
      buildWorkerServiceDocument({
        paths,
        bundleDirectory: serviceBundle,
        installRoot: "/opt/opendelegate",
        dataRoot: serviceDataRoot,
        instanceId: "personal",
        healthPort: 43_190,
        sourceCheckoutRoot: serviceBundle,
        hostPlatform: "linux",
        ownerSession: {
          userName: "owner",
          stableUserId: "1000",
          uid: 1000,
          homeDirectory: "/home/owner",
        },
        serviceIdentity: { userName: "other", groupName: "other" },
      }),
      (error: unknown) =>
        error instanceof WorkerAppError &&
        error.code === "CONFIG_INVALID" &&
        error.message.includes("does not match"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a System-Keychain-prepared macOS Worker composes both launchd planes", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-macos-service-document-"));
  const bundle = join(root, "bundle");
  const serviceBundle = posixTestPath(bundle);
  const dataRoot = join(root, "runtime-data");
  const serviceDataRoot = posixTestPath(dataRoot);
  const paths = resolveWorkerPaths({
    sourceCheckoutRoot: bundle,
    home: join(dataRoot, "state"),
  });
  const helperBytes = Buffer.from("macos-keychain-helper");
  const helperDigest = `sha256:${createHash("sha256").update(helperBytes).digest("hex")}`;
  const stableHelper = "/Library/PrivilegedHelperTools/opendelegate-keychain-helper-personal";
  const bindingPath =
    "/Library/Application Support/OpenDelegate/personal/system-keychain-binding.json";
  const core = keyPin();
  const helper = keyPin();

  try {
    await mkdir(paths.configDirectory, { recursive: true });
    await mkdir(join(bundle, "runtime", "native"), { recursive: true });
    await writeFile(join(bundle, "runtime", "native", "opendelegate-keychain-helper"), helperBytes);
    await writeFile(
      paths.configFile,
      `${JSON.stringify({
        schemaVersion: 1,
        deviceId: "device-macos-persistent",
        workerId: "worker-primary",
        mainDeviceId: "device-main",
        keyId: "device-key-macos",
        certificateGeneration: 1,
        certificatePem: "-----BEGIN CERTIFICATE-----\nworker\n-----END CERTIFICATE-----",
        certificateAuthorityPem:
          "-----BEGIN CERTIFICATE-----\nauthority\n-----END CERTIFICATE-----",
        expectedMainSpkiSha256: `sha256:${"A".repeat(43)}`,
        transportProfile: {
          deviceId: "device-main",
          endpoints: [
            {
              endpointId: "main-private",
              label: "Main private route",
              kind: "wss",
              url: "wss://main.example.test/api/v1/device/channel",
              credentialRef: "device-identity",
            },
          ],
        },
        secretBackend: {
          backend: "macos-system-keychain",
          bindingPath,
          helperPath: stableHelper,
          expectedHelperSha256: helperDigest,
          servicePreparation: {
            schemaVersion: 1,
            serviceIdentity: { userName: "_opendelegate", groupName: "_opendelegate" },
            ownerHelperSecretBinding: {
              backend: "macos-keychain",
              helperPath: stableHelper,
              expectedHelperSha256: helperDigest,
            },
            ipcTrust: { core, helper },
          },
        },
        agent: { provider: "auto", allowUntestedVersion: false },
        workspaces: [],
        createdAt: "2026-08-11T00:00:00.000Z",
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await writeFile(
      join(bundle, "release-metadata.json"),
      `${JSON.stringify({ productVersion: "0.1.0" })}\n`,
    );
    await writeFile(join(bundle, "SHA256SUMS"), "fixture  payload\n");

    const document = await buildWorkerServiceDocument({
      paths,
      bundleDirectory: serviceBundle,
      installRoot: "/Library/OpenDelegate",
      dataRoot: serviceDataRoot,
      instanceId: "personal",
      healthPort: 43_190,
      sourceCheckoutRoot: serviceBundle,
      hostPlatform: "darwin",
      ownerSession: {
        userName: "owner",
        stableUserId: "501",
        uid: 501,
        homeDirectory: "/Users/owner",
      },
    });

    assert.equal(document.platform, "macos");
    assert.deepEqual(document.ipcTrust, { protocolVersion: 2, core, helper });
    assert.equal(document.helperSecretBinding.helperPath, stableHelper);
    assert.deepEqual(document.serviceSecretBinding, {
      backend: "macos-system-keychain",
      bindingPath,
      helperPath: stableHelper,
      expectedHelperSha256: helperDigest,
      keychainPath: "/Library/Keychains/System.keychain",
      serviceUserName: "_opendelegate",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function keyPin(): {
  readonly keyId: `sha256:${string}`;
  readonly publicKeySpkiBase64Url: string;
} {
  const { publicKey } = generateKeyPairSync("ed25519");
  const spki = Buffer.from(publicKey.export({ format: "der", type: "spki" }));
  try {
    return {
      keyId: `sha256:${createHash("sha256").update(spki).digest("hex")}`,
      publicKeySpkiBase64Url: spki.toString("base64url"),
    };
  } finally {
    spki.fill(0);
  }
}

function posixTestPath(value: string): string {
  return process.platform === "win32"
    ? value.replace(/^[A-Za-z]:/u, "").replaceAll("\\", "/")
    : value;
}
