import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ConfigurationService,
  InMemoryConfigurationRepository,
  STANDARD_CONFIGURATION_DEFINITIONS,
} from "@opendelegate/configuration";
import type { PlatformServiceConfiguration } from "@opendelegate/platform-services";

import type { MainConfiguration } from "../src/index.ts";
import {
  assertMainServiceHomeBinding,
  resolveEffectiveMainServiceConfiguration,
  resolveMainServiceHomeBinding,
} from "../src/main-service-configuration.ts";

const NOW = "2026-07-26T00:00:00.000Z";

test("current-host Main service operations reject a --home outside the template state root", () => {
  for (const command of [
    "diagnose",
    "install",
    "reconfigure",
    "restart",
    "start",
    "status",
    "stop",
    "uninstall",
    "upgrade",
  ] as const) {
    assert.throws(
      () =>
        assertMainServiceHomeBinding({
          command,
          home: "/srv/opendelegate-main",
          hostPlatform: "linux",
          template: serviceConfiguration({ enabled: false }),
        }),
      /must match the template state root/i,
      command,
    );
  }
});

test("Main service home binding preserves cross-target planning and host path semantics", () => {
  const linux = serviceConfiguration({ enabled: false });
  for (const command of ["render", "plan"] as const) {
    assert.doesNotThrow(() =>
      assertMainServiceHomeBinding({
        command,
        home: "/srv/opendelegate-main",
        hostPlatform: "linux",
        template: linux,
      }),
    );
  }
  assert.doesNotThrow(() =>
    assertMainServiceHomeBinding({
      command: "status",
      home: "/var/lib/opendelegate/./",
      hostPlatform: "linux",
      template: linux,
    }),
  );

  const windows = {
    platform: "windows",
    role: "main",
    paths: {
      stateRoot: "C:\\ProgramData\\OpenDelegate\\state",
    },
  } as const;
  assert.doesNotThrow(() =>
    assertMainServiceHomeBinding({
      command: "restart",
      home: "c:\\PROGRAMDATA\\OpenDelegate\\state\\.",
      hostPlatform: "windows",
      template: windows,
    }),
  );
});

test("current-host Main service home binding resolves a real directory alias to the template state root", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-main-service-home-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const stateRoot = join(directory, "state");
  const alias = join(directory, "state-alias");
  await mkdir(stateRoot);
  await symlink(stateRoot, alias, process.platform === "win32" ? "junction" : "dir");
  const hostPlatform =
    process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";

  assert.equal(
    await resolveMainServiceHomeBinding({
      command: "status",
      home: alias,
      hostPlatform,
      template: {
        platform: hostPlatform,
        role: "main",
        paths: { stateRoot },
      },
    }),
    stateRoot,
  );
});

test("current-host Main service home binding never returns a swappable template alias", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-main-service-home-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const home = join(directory, "state");
  const templateAlias = join(directory, "template-state-alias");
  await mkdir(home);
  await symlink(home, templateAlias, process.platform === "win32" ? "junction" : "dir");
  const hostPlatform =
    process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";

  assert.equal(
    await resolveMainServiceHomeBinding({
      command: "status",
      home,
      hostPlatform,
      template: {
        platform: hostPlatform,
        role: "main",
        paths: { stateRoot: templateAlias },
      },
    }),
    home,
  );
});

test("current-host Main service home binding rejects distinct real directories", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-main-service-home-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const home = join(directory, "home");
  const stateRoot = join(directory, "state");
  await Promise.all([mkdir(home), mkdir(stateRoot)]);
  const hostPlatform =
    process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";

  await assert.rejects(
    resolveMainServiceHomeBinding({
      command: "status",
      home,
      hostPlatform,
      template: {
        platform: hostPlatform,
        role: "main",
        paths: { stateRoot },
      },
    }),
    /must match the template state root/i,
  );
});

test("cross-target Main service rendering does not inspect host filesystem paths", async () => {
  for (const command of ["render", "plan"] as const) {
    const home = "/not-present/main-home";
    assert.equal(
      await resolveMainServiceHomeBinding(
        {
          command,
          home,
          hostPlatform: "windows",
          template: {
            platform: "linux",
            role: "main",
            paths: { stateRoot: "/not-present/state" },
          },
        },
        {
          async realPath() {
            throw new Error("Filesystem access is not permitted for cross-target rendering.");
          },
        },
      ),
      home,
    );
  }
});

test("Main service resolution rejects a local state-root mismatch before durable Configuration inspection", async () => {
  let inspections = 0;
  await assert.rejects(
    resolveEffectiveMainServiceConfiguration({
      command: "status",
      home: "/srv/opendelegate-main",
      hostPlatform: "linux",
      service: {
        async inspect() {
          inspections += 1;
          return {};
        },
      },
      homeBindingBoundary: {
        async realPath(path) {
          return path;
        },
      },
      main: mainConfiguration(),
      template: serviceConfiguration({ enabled: false }),
    }),
    /must match the template state root/i,
  );
  assert.equal(inspections, 0);
});

test("Main service rendering replaces template state with the effective owner preference and canonical Admin origin", async () => {
  const configuration = configurationService();
  const template = serviceConfiguration({
    enabled: true,
    url: "https://stale.example.test/",
  });
  const disabled = await resolveEffectiveMainServiceConfiguration({
    command: "render",
    home: "/var/lib/opendelegate",
    hostPlatform: "linux",
    service: configuration,
    main: mainConfiguration(),
    template,
  });

  assert.deepEqual(disabled.configuration.ownerSession.adminAutoOpen, {
    enabled: false,
  });
  assert.deepEqual(disabled.alternateConfiguration.ownerSession.adminAutoOpen, {
    enabled: true,
    url: "https://admin.example.test/",
  });
  assert.deepEqual(template.ownerSession.adminAutoOpen, {
    enabled: true,
    url: "https://stale.example.test/",
  });

  const proposal = await configuration.propose({
    actor: "owner_personal",
    reason: "Open Admin after owner login.",
    changes: [
      {
        operation: "set",
        key: "admin.open-on-login",
        scope: { kind: "main", id: "device_main" },
        value: true,
      },
    ],
  });
  await configuration.apply({
    proposalId: proposal.id,
    expectedRevision: 0,
    actor: "owner_personal",
  });

  const enabled = await resolveEffectiveMainServiceConfiguration({
    command: "render",
    home: "/var/lib/opendelegate",
    hostPlatform: "linux",
    service: configuration,
    main: mainConfiguration(),
    template,
  });
  assert.deepEqual(enabled.configuration.ownerSession.adminAutoOpen, {
    enabled: true,
    url: "https://admin.example.test/",
  });
  assert.deepEqual(enabled.alternateConfiguration.ownerSession.adminAutoOpen, {
    enabled: false,
  });
});

test("a headless Main rejects an enabled Admin auto-open preference it cannot honor", async () => {
  const configuration = configurationService();
  const graphical = serviceConfiguration({ enabled: false });
  if (graphical.platform !== "linux") {
    throw new Error("Expected a Linux service fixture.");
  }
  const headless = {
    ...graphical,
    helperSecretBinding: null,
    systemdCredential: {
      credentialName: "opendelegate-vault-key",
      encryptedSourcePath: "/etc/credstore.encrypted/opendelegate-vault-key.cred",
    },
    ipcTrust: { protocolVersion: 2 as const, core: graphical.ipcTrust.core },
    secretReferences: {
      deviceIdentity: "secret://linux/device-identity",
      coreIpcSigningKey: "secret://linux/core-ipc-signing-v2",
    },
  };
  const disabled = await resolveEffectiveMainServiceConfiguration({
    command: "render",
    home: "/var/lib/opendelegate",
    hostPlatform: "linux",
    service: configuration,
    main: mainConfiguration(),
    template: headless,
  });
  assert.deepEqual(disabled.configuration.ownerSession.adminAutoOpen, { enabled: false });
  assert.deepEqual(disabled.alternateConfiguration.ownerSession.adminAutoOpen, {
    enabled: false,
  });

  const proposal = await configuration.propose({
    actor: "owner_personal",
    reason: "Open Admin after owner login.",
    changes: [
      {
        operation: "set",
        key: "admin.open-on-login",
        scope: { kind: "main", id: "device_main" },
        value: true,
      },
    ],
  });
  await configuration.apply({
    proposalId: proposal.id,
    expectedRevision: 0,
    actor: "owner_personal",
  });
  await assert.rejects(
    resolveEffectiveMainServiceConfiguration({
      command: "render",
      home: "/var/lib/opendelegate",
      hostPlatform: "linux",
      service: configuration,
      main: mainConfiguration(),
      template: headless,
    }),
    /must be disabled.*headless Main/iu,
  );
});

test("Main service rendering rejects a Worker or a template for another Instance", async () => {
  const configuration = configurationService();
  await assert.rejects(
    resolveEffectiveMainServiceConfiguration({
      command: "render",
      home: "/var/lib/opendelegate",
      hostPlatform: "linux",
      service: configuration,
      main: mainConfiguration(),
      template: {
        ...serviceConfiguration({ enabled: false }),
        role: "worker",
      },
    }),
    /fixed Main/i,
  );
  await assert.rejects(
    resolveEffectiveMainServiceConfiguration({
      command: "render",
      home: "/var/lib/opendelegate",
      hostPlatform: "linux",
      service: configuration,
      main: mainConfiguration(),
      template: {
        ...serviceConfiguration({ enabled: false }),
        instanceId: "instance_other",
      },
    }),
    /identity/i,
  );
});

function configurationService(): ConfigurationService {
  let sequence = 0;
  return new ConfigurationService({
    definitions: STANDARD_CONFIGURATION_DEFINITIONS,
    repository: new InMemoryConfigurationRepository(),
    idSource: () => `configuration_${++sequence}`,
    clock: () => NOW,
  });
}

function mainConfiguration(): MainConfiguration {
  return {
    schemaVersion: 1,
    instanceId: "instance_personal",
    deviceId: "device_main",
    main: {
      host: "0.0.0.0",
      port: 443,
      origin: "https://admin.example.test",
      tls: {
        certificatePath: "/etc/opendelegate/tls/admin.pem",
        privateKeyPath: "/etc/opendelegate/tls/admin-key.pem",
      },
    },
    database: { adapter: "sqlite" },
    secretBackend: {
      backend: "linux-secret-service",
      secretToolPath: "/usr/bin/secret-tool",
    },
    adminRoot: "/opt/opendelegate/admin",
  };
}

function serviceConfiguration(
  adminAutoOpen: PlatformServiceConfiguration["ownerSession"]["adminAutoOpen"],
): PlatformServiceConfiguration {
  return {
    platform: "linux",
    instanceId: "instance_personal",
    deviceId: "device_main",
    role: "main",
    bundle: {
      version: "1.2.3",
      sourceDirectory: "/mnt/release-input/opendelegate-1.2.3",
      checksum: `sha256:${"a".repeat(64)}`,
    },
    paths: {
      sourceCheckoutDirectory: "/home/owner/src/OpenDelegate",
      installRoot: "/opt/opendelegate",
      stateRoot: "/var/lib/opendelegate",
      authorityRoot: "/var/lib/opendelegate-authority",
      runtimeRoot: "/run/opendelegate",
      logRoot: "/var/log/opendelegate",
    },
    ownerSession: {
      userName: "owner",
      stableUserId: "1000",
      uid: 1000,
      homeDirectory: "/home/owner",
      adminAutoOpen,
    },
    serviceIdentity: {
      userName: "opendelegate",
      groupName: "opendelegate",
    },
    helperSecretBinding: {
      backend: "linux-secret-service",
      secretToolPath: "/usr/bin/secret-tool",
    },
    systemdCredential: null,
    ipcTrust: {
      protocolVersion: 2,
      core: {
        keyId: "sha256:f9acccda515ce25409e456e45f25417bcda0c1cc0255490965f6ab59d5a81b48",
        publicKeySpkiBase64Url: "MCowBQYDK2VwAyEAjBmMzBDNPDdi86mu7kAWdhSpEsUBySgfGN0q2ganv5I",
      },
      helper: {
        keyId: "sha256:b0308f5b2e753b15572359e7e9cd8da8400839df95052ddc21d9711554750c2f",
        publicKeySpkiBase64Url: "MCowBQYDK2VwAyEAli20Wxft7Lox4PLDh_IcMGjN265l-fNMneRfYNWYnko",
      },
    },
    secretReferences: {
      deviceIdentity: "secret://linux/device-identity",
      coreIpcSigningKey: "secret://linux/core-ipc-signing-v2",
      helperIpcSigningKey: "secret://linux/helper-ipc-signing-v2",
    },
    health: {
      endpoint: "http://127.0.0.1:4380/health/live",
      timeoutMs: 30_000,
    },
    retainPreviousVersions: 2,
  };
}
