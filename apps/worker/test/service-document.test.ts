import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildWorkerServiceDocument } from "../src/service-document.ts";
import { resolveWorkerPaths, WorkerAppError } from "../src/worker-app.ts";

const checkout = join(process.cwd(), "..", "..");
const SERVICE_SID = "S-1-5-80-611375048-4065716985-2142524325-1255325421-3479547702";

test("a staged Windows Worker composes its service document from durable public bindings", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-service-document-"));
  const bundle = join(root, "bundle");
  const paths = resolveWorkerPaths({
    sourceCheckoutRoot: bundle,
    home: join(root, "worker-home"),
  });
  const installRoot = join(root, "installed");
  const dataRoot = join(root, "runtime-data");
  const ownerVaultRoot = join(root, "owner-vault");
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
    });

    assert.equal(document.platform, "windows");
    assert.deepEqual(document.ipcTrust, { protocolVersion: 2, core, helper });
    assert.equal(document.helperSecretBinding.vaultRoot, ownerVaultRoot);
    assert.equal(document.serviceSecretBinding?.serviceSid, SERVICE_SID);
    assert.equal(
      document.bundle.checksum,
      `sha256:${createHash("sha256").update("fixture  payload\n").digest("hex")}`,
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

test("service-document fails closed where per-plane service Secret migration is not implemented", async () => {
  await assert.rejects(
    buildWorkerServiceDocument({
      paths: resolveWorkerPaths({ sourceCheckoutRoot: checkout, home: join(tmpdir(), "unused") }),
      bundleDirectory: "/tmp/bundle",
      installRoot: "/opt/opendelegate",
      dataRoot: "/var/lib/opendelegate",
      instanceId: "personal",
      healthPort: 43_190,
      sourceCheckoutRoot: checkout,
      hostPlatform: "linux",
      ownerSession: { userName: "owner", stableUserId: "1000" },
    }),
    (error: unknown) =>
      error instanceof WorkerAppError &&
      error.code === "CONFIG_INVALID" &&
      error.message.includes("two-plane runtime"),
  );
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
