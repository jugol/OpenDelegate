import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  composeServiceConfiguration,
  createPlatformServiceDefinition,
  PlatformServiceError,
  type ComposeServiceConfigurationInput,
} from "../src/index.ts";

/**
 * Both pins belong to identities the Device already owns: the core key lives in the
 * core Secret Store and the helper key in the owner-session store. Composition
 * carries them; it never mints them, because the session helper refuses to start
 * when a pin does not match the key it holds.
 */
const CORE_PIN = Object.freeze({
  keyId: "sha256:f9acccda515ce25409e456e45f25417bcda0c1cc0255490965f6ab59d5a81b48" as const,
  publicKeySpkiBase64Url: "MCowBQYDK2VwAyEAjBmMzBDNPDdi86mu7kAWdhSpEsUBySgfGN0q2ganv5I",
});
const HELPER_PIN = Object.freeze({
  keyId: "sha256:b0308f5b2e753b15572359e7e9cd8da8400839df95052ddc21d9711554750c2f" as const,
  publicKeySpkiBase64Url: "MCowBQYDK2VwAyEAli20Wxft7Lox4PLDh_IcMGjN265l-fNMneRfYNWYnko",
});

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
    ipcTrust: { core: CORE_PIN, helper: HELPER_PIN },
    secretReferences: {
      coreIpcSigningKey: "secret://worker/opendelegate/session-helper-core-signing/v2",
      helperIpcSigningKey: "secret://worker/opendelegate/session-helper-owner-signing/v2",
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

  it("carries the Device's own signing pins through untouched", () => {
    const configuration = composeServiceConfiguration(windowsInput());

    // A substituted pin fails at the session helper's start-up check, which reports
    // a mismatch far from whatever produced it.
    assert.deepEqual(configuration.ipcTrust, {
      protocolVersion: 2,
      core: CORE_PIN,
      helper: HELPER_PIN,
    });
    assert.deepEqual(configuration.secretReferences, {
      coreIpcSigningKey: "secret://worker/opendelegate/session-helper-core-signing/v2",
      helperIpcSigningKey: "secret://worker/opendelegate/session-helper-owner-signing/v2",
    });
  });

  it("rejects a shared signing identity across the two planes", () => {
    // One key would let either plane forge the other's frames.
    assert.throws(
      () =>
        composeServiceConfiguration(
          windowsInput({ ipcTrust: { core: CORE_PIN, helper: CORE_PIN } }),
        ),
      PlatformServiceError,
    );
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
