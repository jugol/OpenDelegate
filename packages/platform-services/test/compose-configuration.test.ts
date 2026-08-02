import assert from "node:assert/strict";
import { createHash, createPublicKey } from "node:crypto";
import { describe, it } from "node:test";

import {
  composeServiceConfiguration,
  createLocalIpcTrustMaterial,
  createPlatformServiceDefinition,
  PlatformServiceError,
  type ComposeServiceConfigurationInput,
} from "../src/index.ts";

const material = createLocalIpcTrustMaterial();

function windowsInput(
  overrides: Partial<ComposeServiceConfigurationInput> = {},
): ComposeServiceConfigurationInput {
  return {
    platform: "windows",
    role: "worker",
    instanceId: "personal",
    deviceId: "device-personal",
    bundle: {
      version: "0.1.0-alpha.1",
      sourceDirectory: "C:\\release-input\\opendelegate",
      checksum: `sha256:${"a".repeat(64)}`,
    },
    sourceCheckoutDirectory: "C:\\src\\OpenDelegate",
    installRoot: "C:\\Program Files\\OpenDelegate",
    dataRoot: "C:\\ProgramData\\OpenDelegate",
    ownerSession: {
      userName: "WORKSTATION\\owner",
      stableUserId: "S-1-5-21-1000",
      adminAutoOpen: { enabled: false },
    },
    ipcTrust: { core: material.core.pin, helper: material.helper.pin },
    secretReferences: {
      coreIpcSigningKey: "secret://service/worker/core-ipc-signing-v2",
      helperIpcSigningKey: "secret://service/worker/helper-ipc-signing-v2",
    },
    healthPort: 43_190,
    ...overrides,
  };
}

describe("native service configuration composition", () => {
  it("derives every runtime root from one data root, disjoint as the schema demands", () => {
    const configuration = composeServiceConfiguration(windowsInput());

    assert.deepEqual(configuration.paths, {
      sourceCheckoutDirectory: "C:\\src\\OpenDelegate",
      installRoot: "C:\\Program Files\\OpenDelegate",
      stateRoot: "C:\\ProgramData\\OpenDelegate\\state",
      authorityRoot: "C:\\ProgramData\\OpenDelegate\\authority",
      runtimeRoot: "C:\\ProgramData\\OpenDelegate\\run",
      logRoot: "C:\\ProgramData\\OpenDelegate\\logs",
    });
    // The document is the input to a privileged install, so it is validated before
    // it is returned rather than at the point of no return.
    assert.doesNotThrow(() => createPlatformServiceDefinition(configuration));
  });

  it("puts the owner Secret vault under the state root, where the reader requires it", () => {
    const configuration = composeServiceConfiguration(windowsInput());

    assert.equal(configuration.platform, "windows");
    assert.equal(
      configuration.platform === "windows" ? configuration.helperSecretBinding.vaultRoot : "",
      "C:\\ProgramData\\OpenDelegate\\state\\owner-secrets\\dpapi",
    );
  });

  it("mints cross-consistent signing identities, which is the part no owner can hand-write", () => {
    for (const plane of [material.core, material.helper]) {
      const spki = Buffer.from(plane.pin.publicKeySpkiBase64Url, "base64url");
      // keyId must be the digest of the exact bytes the document encodes: every
      // reader recomputes it, and a mismatch is indistinguishable from tampering.
      assert.equal(plane.pin.keyId, `sha256:${createHash("sha256").update(spki).digest("hex")}`);
      assert.equal(
        createPublicKey({ key: spki, format: "der", type: "spki" }).asymmetricKeyType,
        "ed25519",
      );
      assert.ok(plane.privateKeyPkcs8.length > 0);
    }
    // A shared key would let either plane forge the other's frames.
    assert.notEqual(material.core.pin.keyId, material.helper.pin.keyId);
  });

  it("keeps the private halves out of the document, which is written in the clear", () => {
    const serialized = JSON.stringify(composeServiceConfiguration(windowsInput()));

    for (const plane of [material.core, material.helper]) {
      assert.equal(serialized.includes(plane.privateKeyPkcs8.toString("base64")), false);
      assert.equal(serialized.includes(plane.privateKeyPkcs8.toString("base64url")), false);
    }
  });

  it("refuses a host fact it was not given rather than inventing one", () => {
    // Off Windows the service runs under its own account, and guessing which one
    // would install a service the owner never agreed to.
    assert.throws(
      () => composeServiceConfiguration(windowsInput({ platform: "linux" })),
      PlatformServiceError,
    );
    assert.throws(
      () => composeServiceConfiguration(windowsInput({ healthPort: 0 })),
      PlatformServiceError,
    );
    assert.throws(
      () => composeServiceConfiguration(windowsInput({ healthPort: 70_000 })),
      PlatformServiceError,
    );
  });

  it("rejects installed state inside the development checkout", () => {
    // The schema forbids it, and composing is where the owner still has a choice.
    assert.throws(
      () =>
        composeServiceConfiguration(
          windowsInput({ dataRoot: "C:\\src\\OpenDelegate\\service-data" }),
        ),
      PlatformServiceError,
    );
  });
});
