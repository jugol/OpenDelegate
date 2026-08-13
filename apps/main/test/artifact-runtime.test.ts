import "reflect-metadata";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import type {
  ManagedSecretDeletion,
  ManagedSecretMutation,
  ManagedSecretStore,
  ManagedSecretStoreHealth,
  SecretAvailability,
} from "@opendelegate/secrets";
import {
  DeviceIdentityAuthority,
  InMemoryDeviceIdentityRepository,
  InMemoryDeviceIdentitySecretStore,
} from "@opendelegate/device-identity";

import {
  createProductionMainArtifactRuntime,
  defaultMainArtifactConfiguration,
  validateMainArtifactConfiguration,
  type ArtifactListenerFactory,
  type ArtifactListenerHandle,
  type ArtifactExternalIngressVerifier,
} from "../src/artifact-runtime.ts";

class TestManagedSecretStore implements ManagedSecretStore {
  public readonly backend = "windows-dpapi" as const;
  public readonly deviceId: string;
  readonly #values = new Map<string, Buffer>();

  public constructor(deviceId: string) {
    this.deviceId = deviceId;
  }

  public async health(): Promise<ManagedSecretStoreHealth> {
    return {
      backend: this.backend,
      deviceId: this.deviceId,
      status: "ready",
    };
  }

  public async availability(alias: string): Promise<SecretAvailability> {
    return { alias, ready: this.#values.has(alias) };
  }

  public async store(alias: string, value: Uint8Array): Promise<ManagedSecretMutation> {
    if (this.#values.has(alias)) {
      throw new Error("Secret already exists.");
    }
    this.#values.set(alias, Buffer.from(value));
    return { status: "stored" };
  }

  public async rotate(alias: string, value: Uint8Array): Promise<ManagedSecretMutation> {
    if (!this.#values.has(alias)) {
      throw new Error("Secret does not exist.");
    }
    this.#values.set(alias, Buffer.from(value));
    return { status: "rotated" };
  }

  public async delete(alias: string): Promise<ManagedSecretDeletion> {
    return { status: this.#values.delete(alias) ? "deleted" : "absent" };
  }

  public async executeWithSecretBytes(
    alias: string,
    executor: (value: Uint8Array) => unknown | Promise<unknown>,
  ): Promise<void> {
    const stored = this.#values.get(alias);
    if (stored === undefined) {
      throw new Error("Secret unavailable.");
    }
    const scoped = Buffer.from(stored);
    try {
      await executor(scoped);
    } finally {
      scoped.fill(0);
    }
  }

  public seed(alias: string, value: string): void {
    this.#values.set(alias, Buffer.from(value, "utf8"));
  }
}

class RecordingListenerFactory implements ArtifactListenerFactory {
  public readonly started: {
    plane: "static" | "interactive";
    host: string;
    port: number;
    origin: string;
    closed: boolean;
  }[] = [];

  public async listen(input: Parameters<ArtifactListenerFactory["listen"]>[0]) {
    const record = {
      plane: input.plane,
      host: input.configuration.host,
      port: input.configuration.port,
      origin: input.configuration.origin,
      closed: false,
    };
    this.started.push(record);
    const handle: ArtifactListenerHandle = {
      address: Object.freeze({
        host: record.host,
        port: record.port,
        origin: record.origin,
      }),
      close: async () => {
        record.closed = true;
        await input.app.close();
      },
    };
    return handle;
  }
}

class FailingSecondListenerFactory implements ArtifactListenerFactory {
  public staticClosed = false;
  #attempts = 0;

  public async listen(input: Parameters<ArtifactListenerFactory["listen"]>[0]) {
    this.#attempts += 1;
    if (this.#attempts === 2) {
      throw new Error("synthetic interactive-listener failure");
    }
    const handle: ArtifactListenerHandle = {
      address: input.configuration,
      close: async () => {
        this.staticClosed = true;
        await input.app.close();
      },
    };
    return handle;
  }
}

class RecordingExternalIngressVerifier implements ArtifactExternalIngressVerifier {
  public readonly verified: {
    readonly plane: "static" | "interactive";
    readonly origin: string;
  }[] = [];

  public async verify(
    input: Parameters<ArtifactExternalIngressVerifier["verify"]>[0],
  ): Promise<{ readonly status: "verified"; readonly checkedAtMs: number }> {
    this.verified.push({ plane: input.plane, origin: input.externalOrigin });
    return { status: "verified", checkedAtMs: Date.now() };
  }
}

function checksum(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function issueArtifactTlsFixture(): Promise<{
  readonly certificatePem: string;
  readonly certificateAuthorityPem: string;
  readonly privateKeyPem: string;
}> {
  const authority = new DeviceIdentityAuthority({
    clock: { now: () => Date.now() },
    repository: new InMemoryDeviceIdentityRepository(),
    secrets: new InMemoryDeviceIdentitySecretStore(),
  });
  await authority.bootstrapCertificateAuthority({ instanceId: "instance-artifact-tls-test" });
  const keys = await globalThis.crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const issued = await authority.issueMainServerCertificate({
    publicKey: keys.publicKey,
    hostnames: ["127.0.0.1", "localhost"],
  });
  const privateKeyDer = Buffer.from(
    await globalThis.crypto.subtle.exportKey("pkcs8", keys.privateKey),
  );
  return {
    certificatePem: issued.certificatePem,
    certificateAuthorityPem: issued.certificateAuthorityPem,
    privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${
      privateKeyDer
        .toString("base64")
        .match(/.{1,64}/gu)
        ?.join("\n") ?? ""
    }\n-----END PRIVATE KEY-----\n`,
  };
}

async function availableLoopbackPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("A loopback test port was not assigned.");
  }
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
  });
  return address.port;
}

async function requestArtifactHealth(input: {
  readonly port: number;
  readonly servername?: string;
  readonly hostHeader: string;
  readonly certificateAuthorityPem: string;
}): Promise<{ readonly statusCode: number | undefined; readonly body: string }> {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpsRequest(
      {
        hostname: "127.0.0.1",
        port: input.port,
        path: "/health/live",
        method: "GET",
        ...(input.servername === undefined ? {} : { servername: input.servername }),
        ca: input.certificateAuthorityPem,
        minVersion: "TLSv1.3",
        maxVersion: "TLSv1.3",
        headers: { host: input.hostHeader },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.once("error", rejectRequest);
        response.once("end", () => {
          resolveRequest({
            statusCode: response.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.once("error", rejectRequest);
    request.end();
  });
}

test("default Artifact configuration is private, loopback-only, and uses distinct origins", async () => {
  const home = resolve(tmpdir(), "OpenDelegateRuntime");
  const configuration = await defaultMainArtifactConfiguration({
    home,
    installationRoot: resolve(tmpdir(), "OpenDelegateRelease"),
    mainListener: {
      host: "127.0.0.1",
      port: 4380,
      origin: "http://127.0.0.1:4380",
    },
    hostPlatform: "win32",
  });

  assert.equal(configuration.exposure.defaultMode, "private-network");
  assert.deepEqual(configuration.exposure.privateNetworks, [
    "127.0.0.0/8",
    "::1/128",
    "::ffff:127.0.0.0/104",
  ]);
  assert.deepEqual(configuration.listeners, {
    static: {
      host: "127.0.0.1",
      port: 4382,
      origin: "http://static.artifacts.localhost:4382",
    },
    interactive: {
      host: "127.0.0.1",
      port: 4383,
      origin: "http://interactive.artifacts.localhost:4383",
    },
  });
  assert.deepEqual(configuration.secretBackend, {
    backend: "windows-dpapi",
    vaultRoot: join(home, "secrets", "main"),
  });
  assert.deepEqual(
    validateMainArtifactConfiguration({
      ...configuration,
      secretBackend: {
        backend: "windows-service-dpapi",
        vaultRoot: join(home, "secrets", "service"),
        handoffRoot: join(home, "state", "secrets"),
        serviceSid: "S-1-5-80-1-2-3-4-5",
      },
    }).secretBackend,
    {
      backend: "windows-service-dpapi",
      vaultRoot: join(home, "secrets", "service"),
      handoffRoot: join(home, "state", "secrets"),
      serviceSid: "S-1-5-80-1-2-3-4-5",
    },
  );
  assert.throws(
    () =>
      validateMainArtifactConfiguration({
        ...configuration,
        listeners: {
          static: configuration.listeners.static,
          interactive: {
            ...configuration.listeners.interactive,
            origin: "http://static.artifacts.localhost:4383",
          },
        },
      }),
    /origins and cookie hosts must be distinct/i,
  );
  assert.throws(
    () =>
      validateMainArtifactConfiguration({
        ...configuration,
        listeners: {
          static: {
            host: "0.0.0.0",
            port: 443,
            origin: "https://artifacts.example.test",
          },
          interactive: configuration.listeners.interactive,
        },
      }),
    /TLS-capable listener composition/i,
  );
});

test("Main can bind directly authenticated Artifact planes over configured HTTPS", async () => {
  const sourceCheckout = resolve(".");
  const home = await mkdtemp(join(tmpdir(), "opendelegate-main-artifact-tls-"));
  const tls = await issueArtifactTlsFixture();
  const certificatePath = join(home, "artifact-listener-certificate.pem");
  const privateKeyPath = join(home, "artifact-listener-private-key.pem");
  await Promise.all([
    writeFile(certificatePath, tls.certificatePem, { encoding: "utf8", mode: 0o600 }),
    writeFile(privateKeyPath, tls.privateKeyPem, { encoding: "utf8", mode: 0o600 }),
  ]);
  const staticPort = await availableLoopbackPort();
  let interactivePort = await availableLoopbackPort();
  while (interactivePort === staticPort) {
    interactivePort = await availableLoopbackPort();
  }
  const configuration = validateMainArtifactConfiguration({
    schemaVersion: 1,
    enabled: true,
    listeners: {
      static: {
        host: "127.0.0.1",
        port: staticPort,
        origin: `https://127.0.0.1:${String(staticPort)}`,
        tls: { certificatePath, privateKeyPath },
      },
      interactive: {
        host: "127.0.0.1",
        port: interactivePort,
        origin: `https://localhost:${String(interactivePort)}`,
        tls: { certificatePath, privateKeyPath },
      },
    },
    storage: { maximumArtifactBytes: 1024 * 1024 },
    exposure: {
      defaultMode: "private-network",
      privateNetworks: ["127.0.0.0/8"],
      authenticatedBearerAlias: "artifact.owner.bearer",
      authenticatedSessionAlias: "artifact.owner.session",
      customPolicyAliases: {},
    },
    signingKeyAlias: "artifact.signing.v1",
    secretBackend: {
      backend: "windows-dpapi",
      vaultRoot: join(home, "secrets", "main"),
    },
  });
  const secretStore = new TestManagedSecretStore("device-main");
  let runtime: Awaited<ReturnType<typeof createProductionMainArtifactRuntime>> | undefined;
  try {
    runtime = await createProductionMainArtifactRuntime({
      configuration,
      home,
      sourceCheckout,
      deviceId: "device-main",
      adminListeners: [
        {
          host: "127.0.0.1",
          port: 4380,
          origin: "http://admin.artifacts.localhost:4380",
        },
      ],
      secretStore,
    });
    const [staticHealth, interactiveHealth] = await Promise.all([
      requestArtifactHealth({
        port: staticPort,
        hostHeader: `127.0.0.1:${String(staticPort)}`,
        certificateAuthorityPem: tls.certificateAuthorityPem,
      }),
      requestArtifactHealth({
        port: interactivePort,
        servername: "localhost",
        hostHeader: `localhost:${String(interactivePort)}`,
        certificateAuthorityPem: tls.certificateAuthorityPem,
      }),
    ]);
    assert.equal(staticHealth.statusCode, 200);
    assert.equal(interactiveHealth.statusCode, 200);
    assert.equal(JSON.parse(staticHealth.body).service, "opendelegate-artifact-static");
    assert.equal(JSON.parse(interactiveHealth.body).service, "opendelegate-artifact-interactive");

    const uploadBytes = Buffer.from("remote Worker HTTPS upload", "utf8");
    const grant = await runtime.issueWorkerUploadGrant({
      artifactId: "artifact-direct-tls-upload",
      taskId: "task-direct-tls",
      producingRunId: "run-direct-tls",
      mediaType: "text/plain",
      originalFilename: "direct-tls.txt",
      declaredSizeBytes: uploadBytes.byteLength,
      expectedChecksum: { algorithm: "sha256", value: checksum(uploadBytes) },
      createdAtMs: Date.now(),
      retentionPolicy: { kind: "task" },
      exposurePolicy: { mode: "private-network" },
      provenance: { deviceId: "device-worker", source: "worker-upload" },
      expiresAtMs: Date.now() + 60_000,
      context: {
        actor: { type: "system", id: "main-worker-dispatch" },
        correlationId: "artifact-direct-tls-grant",
      },
    });
    assert.equal(new URL(grant.uploadUrl).protocol, "https:");
    assert.equal(new URL(grant.uploadUrl).port, String(staticPort));
  } finally {
    await runtime?.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("Main Artifact runtime isolates hostile content, authorization, and signed links across restart", async () => {
  const sourceCheckout = resolve(".");
  const home = await mkdtemp(join(tmpdir(), "opendelegate-main-artifacts-"));
  const secretStore = new TestManagedSecretStore("device-main");
  secretStore.seed("artifact.owner.bearer", "owner-artifact-token");
  secretStore.seed("artifact.owner.session", "artifact-session-token");
  const listeners = new RecordingListenerFactory();
  const configuration = validateMainArtifactConfiguration({
    schemaVersion: 1,
    enabled: true,
    listeners: {
      static: {
        host: "127.0.0.1",
        port: 4382,
        origin: "http://static.artifacts.localhost:4382",
      },
      interactive: {
        host: "127.0.0.1",
        port: 4383,
        origin: "http://interactive.artifacts.localhost:4383",
      },
    },
    storage: { maximumArtifactBytes: 1024 * 1024 },
    exposure: {
      defaultMode: "private-network",
      privateNetworks: ["127.0.0.0/8", "::1/128", "::ffff:127.0.0.0/104"],
      authenticatedBearerAlias: "artifact.owner.bearer",
      authenticatedSessionAlias: "artifact.owner.session",
      customPolicyAliases: {},
    },
    signingKeyAlias: "artifact.signing.v1",
    secretBackend: {
      backend: "windows-dpapi",
      vaultRoot: join(home, "secrets", "main"),
    },
  });
  let first: Awaited<ReturnType<typeof createProductionMainArtifactRuntime>> | undefined;
  let restarted: Awaited<ReturnType<typeof createProductionMainArtifactRuntime>> | undefined;
  try {
    first = await createProductionMainArtifactRuntime({
      configuration,
      home,
      sourceCheckout,
      deviceId: "device-main",
      adminListeners: [
        {
          host: "127.0.0.1",
          port: 4380,
          origin: "http://127.0.0.1:4380",
        },
      ],
      secretStore,
      listenerFactory: listeners,
    });
    assert.deepEqual(
      listeners.started.map(({ plane, host, port, origin }) => ({
        plane,
        host,
        port,
        origin,
      })),
      [
        {
          plane: "static",
          host: "127.0.0.1",
          port: 4382,
          origin: "http://static.artifacts.localhost:4382",
        },
        {
          plane: "interactive",
          host: "127.0.0.1",
          port: 4383,
          origin: "http://interactive.artifacts.localhost:4383",
        },
      ],
    );
    assert.deepEqual(await first.health(), {
      status: "ready",
      code: "ARTIFACT_RUNTIME_READY",
      listeners: {
        static: {
          host: "127.0.0.1",
          port: 4382,
          origin: "http://static.artifacts.localhost:4382",
        },
        interactive: {
          host: "127.0.0.1",
          port: 4383,
          origin: "http://interactive.artifacts.localhost:4383",
        },
      },
    });

    const hostileHtml = Buffer.from(
      `<script>fetch("http://127.0.0.1:4380/api/v1/auth/session",{credentials:"include"})</script>`,
    );
    await first.store.put({
      artifactId: "artifact-static",
      taskId: "task-artifact",
      producingRunId: "run-artifact",
      mediaType: "text/html",
      originalFilename: "hostile.html",
      bytes: hostileHtml,
      expectedChecksum: { algorithm: "sha256", value: checksum(hostileHtml) },
      createdAtMs: Date.now(),
      retentionPolicy: { kind: "task" },
      exposurePolicy: { mode: "private-network" },
      provenance: { deviceId: "device-worker", source: "worker-upload" },
      context: {
        actor: { type: "worker-agent", id: "worker-main-test" },
        correlationId: "artifact-runtime-static",
      },
    });
    const staticResponse = await first.staticApp.inject({
      method: "GET",
      url: "/artifacts/artifact-static",
      remoteAddress: "127.0.0.1",
      headers: {
        host: "static.artifacts.localhost:4382",
        cookie: "__Host-opendelegate_session=admin-cookie-must-not-authorize",
      },
    });
    assert.equal(staticResponse.statusCode, 200);
    assert.equal(staticResponse.body, hostileHtml.toString("utf8"));
    assert.match(staticResponse.headers["content-security-policy"] ?? "", /script-src 'none'/);
    assert.doesNotMatch(staticResponse.headers["content-security-policy"] ?? "", /allow-scripts/);
    assert.equal(staticResponse.headers["set-cookie"], undefined);

    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>`,
    );
    await first.store.put({
      artifactId: "artifact-svg",
      taskId: "task-artifact",
      producingRunId: "run-artifact",
      mediaType: "image/svg+xml",
      originalFilename: "hostile.svg",
      bytes: svg,
      expectedChecksum: { algorithm: "sha256", value: checksum(svg) },
      createdAtMs: Date.now(),
      retentionPolicy: { kind: "task" },
      exposurePolicy: { mode: "private-network" },
      provenance: { deviceId: "device-worker", source: "worker-upload" },
      context: {
        actor: { type: "worker-agent", id: "worker-main-test" },
        correlationId: "artifact-runtime-svg",
      },
    });
    const svgResponse = await first.staticApp.inject({
      method: "GET",
      url: "/artifacts/artifact-svg",
      remoteAddress: "127.0.0.1",
      headers: { host: "static.artifacts.localhost:4382" },
    });
    assert.equal(svgResponse.statusCode, 200);
    assert.match(svgResponse.headers["content-disposition"] ?? "", /^attachment;/);

    const authenticatedBytes = Buffer.from("owner-only", "utf8");
    await first.store.put({
      artifactId: "artifact-authenticated",
      taskId: "task-artifact",
      producingRunId: "run-artifact",
      mediaType: "text/plain",
      originalFilename: "owner.txt",
      bytes: authenticatedBytes,
      expectedChecksum: { algorithm: "sha256", value: checksum(authenticatedBytes) },
      createdAtMs: Date.now(),
      retentionPolicy: { kind: "task" },
      exposurePolicy: { mode: "authenticated" },
      provenance: { deviceId: "device-worker", source: "worker-upload" },
      context: {
        actor: { type: "worker-agent", id: "worker-main-test" },
        correlationId: "artifact-runtime-authenticated",
      },
    });
    const adminCookie = await first.staticApp.inject({
      method: "GET",
      url: "/artifacts/artifact-authenticated",
      headers: {
        host: "static.artifacts.localhost:4382",
        cookie: "__Host-opendelegate_session=admin-cookie-must-not-authorize",
      },
    });
    assert.equal(adminCookie.statusCode, 404);
    const artifactCookie = await first.staticApp.inject({
      method: "GET",
      url: "/artifacts/artifact-authenticated",
      headers: {
        host: "static.artifacts.localhost:4382",
        cookie: "__Host-opendelegate_artifact_session=artifact-session-token",
      },
    });
    assert.equal(artifactCookie.statusCode, 200);

    const browserAccess = await first.issueBrowserAccessGrant({
      artifactId: "artifact-authenticated",
      expiresAtMs: Date.now() + 60_000,
      context: {
        actor: { type: "owner", id: "owner-main" },
        correlationId: "artifact-runtime-browser-access",
      },
    });
    assert.equal(browserAccess.method, "POST");
    assert.equal(browserAccess.actionUrl.includes(browserAccess.fieldValue), false);
    const browserExchange = await first.staticApp.inject({
      method: "POST",
      url: "/owner-session/exchange",
      headers: {
        host: "static.artifacts.localhost:4382",
        origin: "http://127.0.0.1:4380",
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `${browserAccess.fieldName}=${encodeURIComponent(browserAccess.fieldValue)}`,
    });
    assert.equal(browserExchange.statusCode, 303);
    assert.match(String(browserExchange.headers["set-cookie"] ?? ""), /HttpOnly/);

    const workerUploadBytes = Buffer.from("uploaded through Main", "utf8");
    const workerUpload = await first.issueWorkerUploadGrant({
      artifactId: "artifact-worker-runtime-upload",
      taskId: "task-artifact",
      producingRunId: "run-artifact",
      mediaType: "text/plain",
      originalFilename: "worker-upload.txt",
      declaredSizeBytes: workerUploadBytes.byteLength,
      expectedChecksum: {
        algorithm: "sha256",
        value: checksum(workerUploadBytes),
      },
      createdAtMs: Date.now(),
      retentionPolicy: { kind: "task" },
      exposurePolicy: { mode: "authenticated" },
      provenance: { deviceId: "device-worker", source: "worker-upload" },
      expiresAtMs: Date.now() + 60_000,
      context: {
        actor: { type: "system", id: "main-worker-dispatch" },
        correlationId: "artifact-runtime-worker-upload",
      },
    });
    assert.equal(workerUpload.uploadUrl.includes(workerUpload.credential), false);
    const uploadResponse = await first.staticApp.inject({
      method: "PUT",
      url: new URL(workerUpload.uploadUrl).pathname,
      headers: {
        host: "static.artifacts.localhost:4382",
        authorization: `Bearer ${workerUpload.credential}`,
        "content-type": "application/octet-stream",
        "idempotency-key": "artifact-runtime-worker-chunk",
        "upload-offset": "0",
      },
      payload: workerUploadBytes,
    });
    assert.equal(uploadResponse.statusCode, 201);
    assert.deepEqual(
      Buffer.from((await first.store.read("artifact-worker-runtime-upload")).bytes),
      workerUploadBytes,
    );

    const signedBytes = Buffer.from("signed report", "utf8");
    await first.store.put({
      artifactId: "artifact-signed",
      taskId: "task-artifact",
      producingRunId: "run-artifact",
      mediaType: "text/plain",
      originalFilename: "signed.txt",
      bytes: signedBytes,
      expectedChecksum: { algorithm: "sha256", value: checksum(signedBytes) },
      createdAtMs: Date.now(),
      retentionPolicy: { kind: "task" },
      exposurePolicy: { mode: "signed-link" },
      provenance: { deviceId: "device-worker", source: "worker-upload" },
      context: {
        actor: { type: "worker-agent", id: "worker-main-test" },
        correlationId: "artifact-runtime-signed",
      },
    });
    const issued = await first.store.issueSignedToken({
      artifactId: "artifact-signed",
      expiresAtMs: Date.now() + 60_000,
      context: {
        actor: { type: "owner", id: "owner-main" },
        correlationId: "artifact-runtime-signed-link",
      },
    });
    await first.close();
    assert.equal((await first.health()).code, "ARTIFACT_RUNTIME_CLOSED");
    assert.deepEqual(
      listeners.started.map(({ closed }) => closed),
      [true, true],
    );
    first = undefined;

    restarted = await createProductionMainArtifactRuntime({
      configuration,
      home,
      sourceCheckout,
      deviceId: "device-main",
      adminListeners: [
        {
          host: "127.0.0.1",
          port: 4380,
          origin: "http://127.0.0.1:4380",
        },
      ],
      secretStore,
      listenerFactory: new RecordingListenerFactory(),
    });
    assert.equal((await restarted.store.getMetadata("artifact-static")).state, "available");
    const signedResponse = await restarted.staticApp.inject({
      method: "GET",
      url: `/artifacts/artifact-signed?token=${encodeURIComponent(issued.token)}`,
      headers: { host: "static.artifacts.localhost:4382" },
    });
    assert.equal(signedResponse.statusCode, 200);
    assert.equal(signedResponse.body, "signed report");
  } finally {
    await first?.close();
    await restarted?.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("external Artifact origins start only after an explicit reverse-proxy trust rule and live HTTPS verification", async () => {
  const home = await mkdtemp(join(tmpdir(), "opendelegate-main-artifact-proxy-"));
  const secretStore = new TestManagedSecretStore("device-main");
  const listenerFactory = new RecordingListenerFactory();
  const verifier = new RecordingExternalIngressVerifier();
  const configuration = validateMainArtifactConfiguration({
    schemaVersion: 1,
    enabled: true,
    listeners: {
      static: {
        host: "127.0.0.1",
        port: 4382,
        origin: "https://artifacts.example.test",
        reverseProxy: {
          trustedProxyNetworks: ["127.0.0.0/8", "::1/128"],
        },
      },
      interactive: {
        host: "127.0.0.1",
        port: 4383,
        origin: "https://interactive-artifacts.example.test",
        reverseProxy: {
          trustedProxyNetworks: ["127.0.0.0/8", "::1/128"],
        },
      },
    },
    storage: { maximumArtifactBytes: 1024 * 1024 },
    exposure: {
      defaultMode: "private-network",
      privateNetworks: ["100.64.0.0/10"],
      authenticatedBearerAlias: "artifact.owner.bearer",
      authenticatedSessionAlias: "artifact.owner.session",
      customPolicyAliases: {},
    },
    signingKeyAlias: "artifact.signing.v1",
    secretBackend: {
      backend: "windows-dpapi",
      vaultRoot: join(home, "secrets", "main"),
    },
  });
  let runtime: Awaited<ReturnType<typeof createProductionMainArtifactRuntime>> | undefined;
  try {
    await assert.rejects(
      createProductionMainArtifactRuntime({
        configuration,
        home,
        sourceCheckout: resolve("."),
        deviceId: "device-main",
        adminListeners: [
          {
            host: "127.0.0.1",
            port: 4380,
            origin: "https://admin.example.test:4380",
          },
        ],
        secretStore,
        listenerFactory,
      }),
      /external HTTPS verification/i,
    );

    runtime = await createProductionMainArtifactRuntime({
      configuration,
      home,
      sourceCheckout: resolve("."),
      deviceId: "device-main",
      adminListeners: [
        {
          host: "127.0.0.1",
          port: 4380,
          origin: "https://admin.example.test:4380",
        },
      ],
      secretStore,
      listenerFactory: new RecordingListenerFactory(),
      externalIngressVerifier: verifier,
    });
    assert.deepEqual(verifier.verified, [
      { plane: "static", origin: "https://artifacts.example.test" },
      {
        plane: "interactive",
        origin: "https://interactive-artifacts.example.test",
      },
    ]);
  } finally {
    await runtime?.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("Artifact startup closes the first listener when the isolated second listener fails", async () => {
  const home = await mkdtemp(join(tmpdir(), "opendelegate-main-artifact-failure-"));
  const secretStore = new TestManagedSecretStore("device-main");
  const listenerFactory = new FailingSecondListenerFactory();
  const configuration = validateMainArtifactConfiguration({
    schemaVersion: 1,
    enabled: true,
    listeners: {
      static: {
        host: "127.0.0.1",
        port: 4382,
        origin: "http://static.artifacts.localhost:4382",
      },
      interactive: {
        host: "127.0.0.1",
        port: 4383,
        origin: "http://interactive.artifacts.localhost:4383",
      },
    },
    storage: { maximumArtifactBytes: 1024 * 1024 },
    exposure: {
      defaultMode: "private-network",
      privateNetworks: ["127.0.0.0/8"],
      authenticatedBearerAlias: "artifact.owner.bearer",
      authenticatedSessionAlias: "artifact.owner.session",
      customPolicyAliases: {},
    },
    signingKeyAlias: "artifact.signing.v1",
    secretBackend: {
      backend: "windows-dpapi",
      vaultRoot: join(home, "secrets", "main"),
    },
  });
  try {
    await assert.rejects(
      createProductionMainArtifactRuntime({
        configuration,
        home,
        sourceCheckout: resolve("."),
        deviceId: "device-main",
        adminListeners: [
          {
            host: "127.0.0.1",
            port: 4380,
            origin: "http://127.0.0.1:4380",
          },
        ],
        secretStore,
        listenerFactory,
      }),
      /synthetic interactive-listener failure/,
    );
    assert.equal(listenerFactory.staticClosed, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
