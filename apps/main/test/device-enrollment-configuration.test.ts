import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  MainDeviceEnrollmentConfigurationError,
  loadMainDeviceEnrollmentConfigurationSource,
  persistMainDeviceEnrollmentConfiguration,
} from "../src/device-enrollment-configuration.ts";

test("Device enrollment configuration loads an exact secret-free listener and backend document", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-device-enrollment-config-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const checkout = join(root, "checkout");
  const runtime = join(root, "runtime");
  await Promise.all([mkdir(checkout), mkdir(runtime)]);
  const path = join(root, "source.json");
  const document = fixtureDocument(runtime, {
    backend: "windows-dpapi",
    vaultRoot: join(runtime, "identity-secrets"),
  });
  await writeFile(path, `${JSON.stringify(document)}\n`, { mode: 0o600 });

  const configuration = await loadMainDeviceEnrollmentConfigurationSource(path, {
    sourceCheckout: checkout,
  });

  assert.deepEqual(configuration, document);
  assert.doesNotMatch(JSON.stringify(configuration), /token|privateKeyValue|password/u);
});

test("Device enrollment configuration supports every managed Main identity backend shape", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-device-enrollment-backends-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const checkout = join(root, "checkout");
  const runtime = join(root, "runtime");
  await Promise.all([mkdir(checkout), mkdir(runtime)]);
  const backends = [
    {
      backend: "windows-dpapi",
      vaultRoot: join(runtime, "windows-vault"),
    },
    {
      backend: "macos-keychain",
      helperPath: join(runtime, "opendelegate-keychain-helper"),
      expectedHelperSha256: `sha256:${"a".repeat(64)}`,
    },
    {
      backend: "linux-secret-service",
      secretToolPath: join(runtime, "secret-tool"),
    },
    {
      backend: "linux-systemd-credential-vault",
      credentialName: "opendelegate-main-identity.key",
      vaultRoot: join(runtime, "systemd-vault"),
    },
  ] as const;

  for (const [index, secretBackend] of backends.entries()) {
    const path = join(root, `source-${String(index)}.json`);
    await writeFile(path, `${JSON.stringify(fixtureDocument(runtime, secretBackend))}\n`, {
      mode: 0o600,
    });
    const configuration = await loadMainDeviceEnrollmentConfigurationSource(path, {
      sourceCheckout: checkout,
    });
    assert.deepEqual(configuration.secretBackend, secretBackend);
  }
});

test("Device enrollment configuration rejects unknown fields and checkout-owned TLS state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-device-enrollment-invalid-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const checkout = join(root, "checkout");
  const runtime = join(root, "runtime");
  await Promise.all([mkdir(checkout), mkdir(runtime)]);
  const path = join(root, "source.json");

  await writeFile(
    path,
    JSON.stringify({
      ...fixtureDocument(runtime, {
        backend: "windows-dpapi",
        vaultRoot: join(runtime, "identity-secrets"),
      }),
      token: "must-not-be-accepted",
    }),
  );
  await assert.rejects(
    loadMainDeviceEnrollmentConfigurationSource(path, { sourceCheckout: checkout }),
    isConfigurationError,
  );

  await writeFile(
    path,
    JSON.stringify(
      fixtureDocument(checkout, {
        backend: "windows-dpapi",
        vaultRoot: join(runtime, "identity-secrets"),
      }),
    ),
  );
  await assert.rejects(
    loadMainDeviceEnrollmentConfigurationSource(path, { sourceCheckout: checkout }),
    isConfigurationError,
  );

  const collision = fixtureDocument(runtime, {
    backend: "windows-dpapi",
    vaultRoot: join(runtime, "identity-secrets"),
  });
  await writeFile(
    path,
    JSON.stringify({
      ...collision,
      enrollment: {
        ...collision.enrollment,
        tlsPrivateKeyPath: `${collision.enrollment.tlsCertificatePath}.opendelegate-managed.json`,
      },
      workerChannel: {
        ...collision.workerChannel,
        tlsPrivateKeyPath: `${collision.enrollment.tlsCertificatePath}.opendelegate-managed.json`,
      },
    }),
  );
  await assert.rejects(
    loadMainDeviceEnrollmentConfigurationSource(path, { sourceCheckout: checkout }),
    isConfigurationError,
  );
});

test("persisted Device enrollment composition is idempotent and never overwrites a conflict", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-device-enrollment-persist-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const checkout = join(root, "checkout");
  const runtime = join(root, "runtime");
  await Promise.all([mkdir(checkout), mkdir(runtime, { mode: 0o700 })]);
  const target = join(runtime, "device-enrollment.json");
  const configuration = fixtureDocument(runtime, {
    backend: "windows-dpapi",
    vaultRoot: join(runtime, "identity-secrets"),
  });

  assert.equal(
    await persistMainDeviceEnrollmentConfiguration(target, configuration, {
      sourceCheckout: checkout,
    }),
    "created",
  );
  assert.equal(
    await persistMainDeviceEnrollmentConfiguration(target, configuration, {
      sourceCheckout: checkout,
    }),
    "unchanged",
  );
  await assert.rejects(
    persistMainDeviceEnrollmentConfiguration(
      target,
      {
        ...configuration,
        workerChannel: {
          ...configuration.workerChannel,
          advertisedUrl: "wss://main.example.test:45445/api/v1/device/channel",
          port: 45_445,
        },
      },
      { sourceCheckout: checkout },
    ),
    isConfigurationError,
  );
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), configuration);
});

function fixtureDocument(
  runtime: string,
  secretBackend:
    | {
        readonly backend: "windows-dpapi";
        readonly vaultRoot: string;
      }
    | {
        readonly backend: "macos-keychain";
        readonly helperPath: string;
        readonly expectedHelperSha256: string;
      }
    | {
        readonly backend: "linux-secret-service";
        readonly secretToolPath: string;
      }
    | {
        readonly backend: "linux-systemd-credential-vault";
        readonly credentialName: string;
        readonly vaultRoot: string;
      },
) {
  return {
    schemaVersion: 1 as const,
    enabled: true as const,
    enrollment: {
      advertisedUrl: "https://main.example.test:45443/api/v1/device/enroll",
      host: "0.0.0.0",
      port: 45_443,
      tlsCertificatePath: resolve(runtime, "tls", "main-certificate.pem"),
      tlsPrivateKeyPath: resolve(runtime, "tls", "main-private-key.pem"),
    },
    workerChannel: {
      advertisedUrl: "wss://main.example.test:45444/api/v1/device/channel",
      host: "0.0.0.0",
      port: 45_444,
      path: "/api/v1/device/channel",
      tlsCertificatePath: resolve(runtime, "tls", "main-certificate.pem"),
      tlsPrivateKeyPath: resolve(runtime, "tls", "main-private-key.pem"),
    },
    secretBackend,
  };
}

function isConfigurationError(error: unknown): boolean {
  return error instanceof MainDeviceEnrollmentConfigurationError && error.code === "CONFIG_INVALID";
}
