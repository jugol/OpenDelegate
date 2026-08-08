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
    assert.equal(
      configuration.localIpc.core.privateKeyReference,
      "secret://windows/core-ipc-signing-v2",
    );
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
