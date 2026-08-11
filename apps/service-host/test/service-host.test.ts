import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  ServiceHostError,
  loadServiceHostConfiguration,
  parseServiceHostArguments,
  parseServiceHostConfiguration,
} from "../src/index.ts";

describe("native two-plane JavaScript host", () => {
  it("accepts only the native launcher's non-secret argv contract", () => {
    const configPath =
      process.platform === "win32"
        ? "C:\\ProgramData\\OpenDelegate\\state\\config\\service.json"
        : "/var/lib/opendelegate/state/config/service.json";
    assert.deepEqual(
      parseServiceHostArguments(["--plane", "core", "--role", "worker", "--config", configPath]),
      {
        plane: "core",
        role: "worker",
        configPath,
      },
    );
    assert.throws(
      () =>
        parseServiceHostArguments([
          "--plane",
          "core",
          "--role",
          "worker",
          "--config",
          "C:\\service.json",
          "--secret",
          "value",
        ]),
      /argument/u,
    );
  });

  it("strictly binds Device, release, external authority, owner session, IPC, and health", () => {
    const configuration = parseServiceHostConfiguration(validConfiguration());
    assert.equal(configuration.schemaVersion, 3);
    assert.equal(configuration.deviceId, "device-personal");
    assert.equal(configuration.authorityRoot, "C:\\ProgramData\\OpenDelegate\\authority");
    assert.deepEqual(configuration.ownerSession.adminAutoOpen, {
      enabled: true,
      url: "http://127.0.0.1:43180/",
    });
    assert.equal(configuration.ownerSession.homeDirectory, "C:\\Users\\owner");
    assert.equal(
      configuration.localIpc.core.privateKeyReference,
      "secret://windows/core-ipc-signing-v2",
    );
    assert.equal(configuration.localIpc.sessionHelper, "enabled");
    if (configuration.localIpc.sessionHelper !== "enabled") {
      assert.fail("fixture must include the session helper");
    }
    assert.equal(
      configuration.localIpc.helper.privateKeyReference,
      "secret://windows/helper-ipc-signing-v2",
    );
    assert.equal(JSON.stringify(configuration).includes("secret value"), false);
    assert.throws(
      () => parseServiceHostConfiguration({ ...validConfiguration(), rawSecret: "secret value" }),
      /fields/u,
    );
    assert.throws(
      () =>
        parseServiceHostConfiguration({
          ...validConfiguration(),
          role: "worker",
        }),
      /Admin auto-open/u,
    );
    const logOverlap = validConfiguration();
    logOverlap.helperSecretBinding.vaultRoot = "C:\\ProgramData\\OpenDelegate\\logs";
    assert.throws(() => parseServiceHostConfiguration(logOverlap), /helper Secret binding/u);
  });

  it("accepts an explicit headless Linux core without inventing helper authority", () => {
    const configuration = parseServiceHostConfiguration(headlessLinuxConfiguration());
    assert.equal(configuration.platform, "linux");
    assert.equal(configuration.helperSecretBinding, null);
    assert.equal(configuration.localIpc.sessionHelper, "disabled");
    assert.equal(Object.hasOwn(configuration.localIpc, "helper"), false);
    assert.equal(configuration.localIpc.allowedPeers.length, 1);

    assert.throws(
      () =>
        parseServiceHostConfiguration({
          ...headlessLinuxConfiguration(),
          helperSecretBinding: {
            backend: "linux-secret-service",
            secretToolPath: "/usr/bin/secret-tool",
          },
        }),
      /local IPC configuration/u,
    );
  });

  it("accepts the root-owned macOS helper only when both Secret bindings pin it exactly", () => {
    const configuration = parseServiceHostConfiguration(macOsConfiguration());
    assert.equal(configuration.platform, "macos");
    assert.equal(configuration.helperSecretBinding?.backend, "macos-keychain");
    if (configuration.helperSecretBinding?.backend !== "macos-keychain") {
      assert.fail("fixture must use the macOS Keychain helper");
    }
    assert.equal(
      configuration.helperSecretBinding.helperPath,
      "/Library/PrivilegedHelperTools/opendelegate-keychain-helper-personal",
    );

    const mismatchedDigest = macOsConfiguration();
    mismatchedDigest.helperSecretBinding.expectedHelperSha256 = `sha256:${"b".repeat(64)}`;
    assert.throws(
      () => parseServiceHostConfiguration(mismatchedDigest),
      /owner helper Secret binding/u,
    );

    const unrelatedExternalHelper = macOsConfiguration();
    unrelatedExternalHelper.helperSecretBinding.helperPath =
      "/Library/PrivilegedHelperTools/opendelegate-keychain-helper-other";
    assert.throws(
      () => parseServiceHostConfiguration(unrelatedExternalHelper),
      /owner helper Secret binding/u,
    );
  });

  it("refuses linked, oversized, and unstable configuration files", async () => {
    const root = await mkdtemp(join(tmpdir(), "opendelegate-service-host-config-"));
    try {
      const path = join(root, "service.json");
      await writeFile(path, JSON.stringify(validConfiguration()), "utf8");
      assert.equal((await loadServiceHostConfiguration(path)).instanceId, "personal");
      await writeFile(path, "x".repeat(1024 * 1024 + 1), "utf8");
      await assert.rejects(loadServiceHostConfiguration(path), ServiceHostError);
      await mkdir(join(root, "directory"));
      await assert.rejects(loadServiceHostConfiguration(join(root, "directory")), ServiceHostError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function validConfiguration() {
  return {
    schemaVersion: 3,
    instanceId: "personal",
    deviceId: "device-personal",
    platform: "windows",
    role: "main",
    releaseVersion: "1.2.3",
    releaseRoot: "C:\\Program Files\\OpenDelegate\\current",
    stateRoot: "C:\\ProgramData\\OpenDelegate\\state",
    authorityRoot: "C:\\ProgramData\\OpenDelegate\\authority",
    runtimeRoot: "C:\\ProgramData\\OpenDelegate\\run",
    ownerSession: {
      userName: "WORKSTATION\\owner",
      stableUserId: "S-1-5-21-1000",
      homeDirectory: "C:\\Users\\owner",
      adminAutoOpen: {
        enabled: true,
        url: "http://127.0.0.1:43180/",
      },
    },
    helperSecretBinding: {
      backend: "windows-dpapi",
      vaultRoot: "C:\\Users\\owner\\AppData\\Local\\OpenDelegate\\worker\\secrets\\dpapi",
    },
    logs: {
      core: {
        stdout: "C:\\ProgramData\\OpenDelegate\\logs\\core.stdout.log",
        stderr: "C:\\ProgramData\\OpenDelegate\\logs\\core.stderr.log",
      },
      sessionHelper: {
        stdout: "C:\\ProgramData\\OpenDelegate\\logs\\helper.stdout.log",
        stderr: "C:\\ProgramData\\OpenDelegate\\logs\\helper.stderr.log",
      },
    },
    localIpc: {
      kind: "named-pipe",
      endpoint: String.raw`\\.\pipe\OpenDelegate\personal\session-helper`,
      authentication: "ed25519-mutual-signature-v2",
      credentialReferenceDocument:
        "C:\\ProgramData\\OpenDelegate\\state\\config\\secret-references.json",
      core: {
        privateKeyReference: "secret://windows/core-ipc-signing-v2",
        privateKeyReferenceKey: "coreIpcSigningKey",
        keyId: "sha256:f9acccda515ce25409e456e45f25417bcda0c1cc0255490965f6ab59d5a81b48",
        publicKeySpkiBase64Url: "MCowBQYDK2VwAyEAjBmMzBDNPDdi86mu7kAWdhSpEsUBySgfGN0q2ganv5I",
        peerKeyId: "sha256:b0308f5b2e753b15572359e7e9cd8da8400839df95052ddc21d9711554750c2f",
        peerPublicKeySpkiBase64Url: "MCowBQYDK2VwAyEAli20Wxft7Lox4PLDh_IcMGjN265l-fNMneRfYNWYnko",
        peerIdentity: "S-1-5-21-1000",
      },
      helper: {
        privateKeyReference: "secret://windows/helper-ipc-signing-v2",
        privateKeyReferenceKey: "helperIpcSigningKey",
        keyId: "sha256:b0308f5b2e753b15572359e7e9cd8da8400839df95052ddc21d9711554750c2f",
        publicKeySpkiBase64Url: "MCowBQYDK2VwAyEAli20Wxft7Lox4PLDh_IcMGjN265l-fNMneRfYNWYnko",
        peerKeyId: "sha256:f9acccda515ce25409e456e45f25417bcda0c1cc0255490965f6ab59d5a81b48",
        peerPublicKeySpkiBase64Url: "MCowBQYDK2VwAyEAjBmMzBDNPDdi86mu7kAWdhSpEsUBySgfGN0q2ganv5I",
        peerIdentity: "NT SERVICE\\OpenDelegate-personal",
      },
      allowedPeers: ["NT SERVICE\\OpenDelegate-personal", "S-1-5-21-1000"],
    },
    health: {
      endpoint: "http://127.0.0.1:43190/health/live",
      timeoutMs: 30_000,
    },
  };
}

function headlessLinuxConfiguration() {
  return {
    schemaVersion: 3,
    instanceId: "personal",
    deviceId: "device-linux-headless",
    platform: "linux",
    role: "worker",
    releaseVersion: "1.2.3",
    releaseRoot: "/opt/opendelegate/current",
    stateRoot: "/var/lib/opendelegate/state",
    authorityRoot: "/var/lib/opendelegate/authority",
    runtimeRoot: "/run/opendelegate",
    ownerSession: {
      userName: "owner",
      stableUserId: "1000",
      uid: 1000,
      homeDirectory: "/home/owner",
      adminAutoOpen: { enabled: false },
    },
    helperSecretBinding: null,
    logs: {
      core: {
        stdout: "/var/log/opendelegate/core.stdout.log",
        stderr: "/var/log/opendelegate/core.stderr.log",
      },
      sessionHelper: {
        stdout: "/var/log/opendelegate/helper.stdout.log",
        stderr: "/var/log/opendelegate/helper.stderr.log",
      },
    },
    localIpc: {
      kind: "unix-domain-socket",
      endpoint: "/run/opendelegate/session-helper.sock",
      authentication: "ed25519-mutual-signature-v2",
      sessionHelper: "disabled",
      credentialReferenceDocument: "/var/lib/opendelegate/state/config/secret-references.json",
      core: {
        privateKeyReference: "secret://linux/core-ipc-signing-v2",
        privateKeyReferenceKey: "coreIpcSigningKey",
        keyId: "sha256:f9acccda515ce25409e456e45f25417bcda0c1cc0255490965f6ab59d5a81b48",
        publicKeySpkiBase64Url: "MCowBQYDK2VwAyEAjBmMzBDNPDdi86mu7kAWdhSpEsUBySgfGN0q2ganv5I",
      },
      allowedPeers: ["opendelegate"],
      socketMode: "0660",
    },
    health: {
      endpoint: "http://127.0.0.1:43190/health/live",
      timeoutMs: 30_000,
    },
  };
}

function macOsConfiguration() {
  const ipc = validConfiguration().localIpc;
  const helperDigest = `sha256:${"a".repeat(64)}`;
  const helperPath = "/Library/PrivilegedHelperTools/opendelegate-keychain-helper-personal";
  return {
    schemaVersion: 3,
    instanceId: "personal",
    deviceId: "device-macos-personal",
    platform: "macos",
    role: "worker",
    releaseVersion: "1.2.3",
    releaseRoot: "/Library/Application Support/OpenDelegate/personal/install/current",
    stateRoot: "/Users/Shared/OpenDelegate/personal/state",
    authorityRoot: "/Users/Shared/OpenDelegate/personal/authority",
    runtimeRoot: "/Users/Shared/OpenDelegate/personal/run",
    ownerSession: {
      userName: "owner",
      stableUserId: "501",
      uid: 501,
      homeDirectory: "/Users/owner",
      adminAutoOpen: { enabled: false },
    },
    helperSecretBinding: {
      backend: "macos-keychain",
      helperPath,
      expectedHelperSha256: helperDigest,
    },
    serviceSecretBinding: {
      backend: "macos-system-keychain",
      bindingPath:
        "/Library/Application Support/OpenDelegate/personal/system-keychain-binding.json",
      helperPath,
      expectedHelperSha256: helperDigest,
      keychainPath: "/Library/Keychains/System.keychain",
      serviceUserName: "_opendelegate",
    },
    logs: {
      core: {
        stdout: "/Users/Shared/OpenDelegate/personal/logs/core.stdout.log",
        stderr: "/Users/Shared/OpenDelegate/personal/logs/core.stderr.log",
      },
      sessionHelper: {
        stdout: "/Users/Shared/OpenDelegate/personal/logs/helper.stdout.log",
        stderr: "/Users/Shared/OpenDelegate/personal/logs/helper.stderr.log",
      },
    },
    localIpc: {
      ...ipc,
      kind: "unix-domain-socket",
      endpoint: "/Users/Shared/OpenDelegate/personal/run/session-helper.sock",
      credentialReferenceDocument:
        "/Users/Shared/OpenDelegate/personal/state/config/secret-references.json",
      core: {
        ...ipc.core,
        privateKeyReference: "secret://macos/core-ipc-signing-v2",
        peerIdentity: "501",
      },
      helper: {
        ...ipc.helper,
        privateKeyReference: "secret://macos/helper-ipc-signing-v2",
        peerIdentity: "_opendelegate",
      },
      allowedPeers: ["_opendelegate", "501"],
      socketMode: "0660",
    },
    health: {
      endpoint: "http://127.0.0.1:43190/health/live",
      timeoutMs: 30_000,
    },
  };
}
