import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LocalArtifactStore,
  LocalArtifactAccessBroker,
  type ArtifactClock,
  type ArtifactMutationContext,
  type ArtifactRandomSource,
  type ArtifactStore,
} from "@opendelegate/artifact-store";

import {
  ARTIFACT_SESSION_COOKIE_NAME,
  createArtifactGatewayApp,
  type ArtifactAuthorizationPort,
} from "../src/index.ts";

const STATIC_ORIGIN = "https://artifacts.example.test";
const INTERACTIVE_ORIGIN = "https://interactive-artifacts.example.test";
const ADMIN_ORIGIN = "https://admin.example.test";
const staticHost = "artifacts.example.test";
const interactiveHost = "interactive-artifacts.example.test";
const context: ArtifactMutationContext = {
  actor: { type: "system", id: "test-control-plane" },
  correlationId: "correlation-gateway-test",
};

class MutableClock implements ArtifactClock {
  public value: number;

  public constructor(value: number) {
    this.value = value;
  }

  public nowMs(): number {
    return this.value;
  }
}

class DeterministicRandom implements ArtifactRandomSource {
  private counter = 20;

  public bytes(length: number): Uint8Array {
    this.counter += 1;
    return Buffer.alloc(length, this.counter);
  }
}

function checksum(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function putArtifact(
  store: ArtifactStore,
  input: {
    artifactId: string;
    bytes: Buffer;
    mediaType?: string;
    originalFilename?: string;
    exposureMode?: "public" | "signed-link" | "authenticated" | "private-network" | "custom";
    customPolicyId?: string;
    presentation?: "inline" | "download" | "static-html" | "interactive-html";
    expiresAtMs?: number;
  },
): Promise<void> {
  const mediaType = input.mediaType ?? "text/plain";
  await store.put({
    artifactId: input.artifactId,
    taskId: "task-gateway",
    producingRunId: "run-gateway",
    mediaType,
    originalFilename: input.originalFilename ?? `${input.artifactId}.txt`,
    bytes: input.bytes,
    expectedChecksum: { algorithm: "sha256", value: checksum(input.bytes) },
    createdAtMs: 1_000,
    retentionPolicy:
      input.expiresAtMs === undefined
        ? { kind: "task" }
        : { kind: "temporary", expiresAtMs: input.expiresAtMs },
    exposurePolicy:
      input.exposureMode === "custom"
        ? { mode: "custom", customPolicyId: input.customPolicyId ?? "policy-preview" }
        : { mode: input.exposureMode ?? "public" },
    provenance: { deviceId: "device-main", source: "gateway-test" },
    ...(input.presentation === undefined ? {} : { presentation: input.presentation }),
    context,
  });
}

async function withGateway(
  run: (fixture: {
    clock: MutableClock;
    store: LocalArtifactStore;
    staticApp: Awaited<ReturnType<typeof createArtifactGatewayApp>>;
    interactiveApp: Awaited<ReturnType<typeof createArtifactGatewayApp>>;
    accessBroker: LocalArtifactAccessBroker;
    authorizationCalls: string[];
  }) => Promise<void>,
): Promise<void> {
  const rootDirectory = await mkdtemp(join(tmpdir(), "opendelegate-gateway-"));
  const clock = new MutableClock(1_000);
  const store = await LocalArtifactStore.open({
    rootDirectory,
    maxArtifactBytes: 64 * 1024,
    clock,
    signingKey: Buffer.alloc(32, 8),
    random: new DeterministicRandom(),
  });
  const authorizationCalls: string[] = [];
  const accessBroker = await LocalArtifactAccessBroker.open({
    rootDirectory: join(rootDirectory, "access"),
    store,
    clock,
    random: new DeterministicRandom(),
    maximumArtifactBytes: 64 * 1024,
    maximumChunkBytes: 8,
  });
  const authorization: ArtifactAuthorizationPort = {
    async authorizeOwner(input) {
      authorizationCalls.push(`owner:${input.credentialKind}:${input.credential}`);
      return (
        (input.credentialKind === "bearer" && input.credential === "owner-artifact-token") ||
        (input.credentialKind === "artifact-session" &&
          (input.credential === "artifact-session-token" ||
            (await accessBroker.authorizeBrowserSession({
              artifactId: input.artifactId,
              credential: input.credential,
            }))))
      );
    },
    async authorizePrivateNetwork(input) {
      authorizationCalls.push(`network:${input.remoteAddress}`);
      return input.remoteAddress === "127.0.0.1";
    },
    async authorizeCustom(input) {
      authorizationCalls.push(`custom:${input.customPolicyId}:${input.bearerToken ?? ""}`);
      return (
        input.customPolicyId === "policy-preview" && input.bearerToken === "custom-artifact-token"
      );
    },
  };
  const common = {
    store,
    authorization,
    staticOrigin: STATIC_ORIGIN,
    interactiveOrigin: INTERACTIVE_ORIGIN,
    adminOrigins: [ADMIN_ORIGIN],
    workerUploads: accessBroker,
    browserSessions: accessBroker,
    maximumUploadChunkBytes: 8,
  } as const;
  const staticApp = await createArtifactGatewayApp({ ...common, plane: "static" });
  const interactiveApp = await createArtifactGatewayApp({
    ...common,
    plane: "interactive",
  });

  try {
    await run({
      clock,
      store,
      staticApp,
      interactiveApp,
      accessBroker,
      authorizationCalls,
    });
  } finally {
    await Promise.all([staticApp.close(), interactiveApp.close()]);
    await accessBroker.close();
    await store.close();
    await rm(rootDirectory, { recursive: true, force: true });
  }
}

test("Worker upload endpoint resumes by durable offset and never accepts its grant in the URL", async () => {
  await withGateway(async ({ accessBroker, staticApp, store }) => {
    const bytes = Buffer.from("worker report");
    const issued = await accessBroker.issueUploadGrant({
      artifactId: "artifact-worker-upload",
      taskId: "task-worker-upload",
      producingRunId: "run-worker-upload",
      mediaType: "text/plain",
      originalFilename: "worker-report.txt",
      declaredSizeBytes: bytes.byteLength,
      expectedChecksum: { algorithm: "sha256", value: checksum(bytes) },
      createdAtMs: 1_000,
      retentionPolicy: { kind: "task" },
      exposurePolicy: { mode: "authenticated" },
      provenance: { deviceId: "device-worker", source: "worker-upload" },
      expiresAtMs: 5_000,
      context,
    });

    const denied = await staticApp.inject({
      method: "GET",
      url: `/worker-uploads/${issued.uploadId}?token=${encodeURIComponent(issued.credential)}`,
      headers: { host: staticHost },
    });
    assert.equal(denied.statusCode, 404);

    const first = await staticApp.inject({
      method: "PUT",
      url: `/worker-uploads/${issued.uploadId}`,
      headers: {
        host: staticHost,
        authorization: `Bearer ${issued.credential}`,
        "content-type": "application/octet-stream",
        "idempotency-key": "gateway-chunk-1",
        "upload-offset": "0",
      },
      payload: bytes.subarray(0, 8),
    });
    assert.equal(first.statusCode, 202);
    assert.equal(first.headers["upload-offset"], "8");

    const probe = await staticApp.inject({
      method: "GET",
      url: `/worker-uploads/${issued.uploadId}`,
      headers: {
        host: staticHost,
        authorization: `Bearer ${issued.credential}`,
      },
    });
    assert.equal(probe.statusCode, 200);
    assert.equal(probe.json().nextOffsetBytes, 8);

    const completed = await staticApp.inject({
      method: "PUT",
      url: `/worker-uploads/${issued.uploadId}`,
      headers: {
        host: staticHost,
        authorization: `Bearer ${issued.credential}`,
        "content-type": "application/octet-stream",
        "idempotency-key": "gateway-chunk-2",
        "upload-offset": "8",
      },
      payload: bytes.subarray(8),
    });
    assert.equal(completed.statusCode, 201);
    assert.equal(completed.headers["upload-complete"], "true");
    assert.deepEqual(Buffer.from((await store.read("artifact-worker-upload")).bytes), bytes);
  });
});

test("owner exchanges an authenticated Artifact grant by POST for an HttpOnly scoped cookie", async () => {
  await withGateway(async ({ accessBroker, staticApp, store }) => {
    await putArtifact(store, {
      artifactId: "artifact-browser-session",
      bytes: Buffer.from("private browser report"),
      exposureMode: "authenticated",
    });
    const grant = await accessBroker.issueBrowserGrant({
      artifactId: "artifact-browser-session",
      expiresAtMs: 5_000,
      context,
    });

    const exchange = await staticApp.inject({
      method: "POST",
      url: "/owner-session/exchange",
      headers: {
        host: staticHost,
        origin: ADMIN_ORIGIN,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `grant=${encodeURIComponent(grant.credential)}`,
    });
    assert.equal(exchange.statusCode, 303);
    assert.equal(exchange.headers.location, "/artifacts/artifact-browser-session");
    assert.equal(String(exchange.headers.location).includes(grant.credential), false);
    const setCookie = String(exchange.headers["set-cookie"] ?? "");
    assert.match(setCookie, new RegExp(`^${ARTIFACT_SESSION_COOKIE_NAME}=`));
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.equal(setCookie.includes(grant.credential), false);

    const cookie = setCookie.split(";")[0] ?? "";
    const opened = await staticApp.inject({
      method: "GET",
      url: "/artifacts/artifact-browser-session",
      headers: { host: staticHost, cookie },
    });
    assert.equal(opened.statusCode, 200);

    const replayedGrant = await staticApp.inject({
      method: "POST",
      url: "/owner-session/exchange",
      headers: {
        host: staticHost,
        origin: ADMIN_ORIGIN,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `grant=${encodeURIComponent(grant.credential)}`,
    });
    assert.equal(replayedGrant.statusCode, 404);
  });
});

test("public Artifact supports bounded byte ranges and hardened non-CORS responses", async () => {
  await withGateway(async ({ staticApp, store }) => {
    await putArtifact(store, {
      artifactId: "artifact-public",
      bytes: Buffer.from("0123456789", "utf8"),
      originalFilename: "résumé.txt",
    });

    const response = await staticApp.inject({
      method: "GET",
      url: "/artifacts/artifact-public",
      headers: {
        host: staticHost,
        origin: "https://attacker.example",
        range: "bytes=2-5",
      },
    });

    assert.equal(response.statusCode, 206);
    assert.equal(response.body, "2345");
    assert.equal(response.headers["content-range"], "bytes 2-5/10");
    assert.equal(response.headers["accept-ranges"], "bytes");
    assert.equal(response.headers["cache-control"], "private, no-store");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.equal(response.headers["referrer-policy"], "no-referrer");
    assert.equal(response.headers["cross-origin-resource-policy"], "same-origin");
    assert.equal(response.headers["cross-origin-embedder-policy"], "require-corp");
    assert.equal(response.headers["x-frame-options"], "DENY");
    assert.match(
      String(response.headers["x-opendelegate-correlation-id"] ?? ""),
      /^artifact-request:/,
    );
    assert.equal(response.headers["access-control-allow-origin"], undefined);
    assert.match(response.headers["content-disposition"] ?? "", /filename\*=UTF-8''/);

    const multipleRanges = await staticApp.inject({
      method: "GET",
      url: "/artifacts/artifact-public",
      headers: { host: staticHost, range: "bytes=0-1,4-5" },
    });
    assert.equal(multipleRanges.statusCode, 416);
    assert.equal(multipleRanges.headers["content-range"], "bytes */10");
  });
});

test("Artifact authorization and lookup are rate-limited without throttling liveness", async () => {
  await withGateway(async ({ staticApp }) => {
    for (let request = 0; request < 120; request += 1) {
      const response = await staticApp.inject({
        method: "GET",
        url: `/artifacts/missing-${String(request)}`,
        headers: { host: staticHost },
      });
      assert.equal(response.statusCode, 404);
    }

    const limited = await staticApp.inject({
      method: "GET",
      url: "/artifacts/missing-limited",
      headers: { host: staticHost },
    });
    assert.equal(limited.statusCode, 429);
    assert.deepEqual(limited.json(), {
      type: "about:blank",
      title: "Too Many Requests",
      status: 429,
      code: "ARTIFACT_RATE_LIMITED",
    });

    const health = await staticApp.inject({
      method: "GET",
      url: "/health/live",
      headers: { host: staticHost },
    });
    assert.equal(health.statusCode, 200);
  });
});

test("authenticated exposure ignores Admin cookies and delegates explicit Artifact credentials", async () => {
  await withGateway(async ({ staticApp, store, authorizationCalls }) => {
    await putArtifact(store, {
      artifactId: "artifact-owner",
      bytes: Buffer.from("owner report"),
      exposureMode: "authenticated",
    });

    const cookieOnly = await staticApp.inject({
      method: "GET",
      url: "/artifacts/artifact-owner",
      headers: {
        host: staticHost,
        cookie: "__Host-opendelegate_session=admin-cookie-must-not-authorize",
      },
    });
    assert.equal(cookieOnly.statusCode, 404);
    assert.deepEqual(authorizationCalls, []);

    const bearer = await staticApp.inject({
      method: "GET",
      url: "/artifacts/artifact-owner",
      headers: {
        host: staticHost,
        authorization: "Bearer owner-artifact-token",
      },
    });
    assert.equal(bearer.statusCode, 200);
    assert.deepEqual(authorizationCalls, ["owner:bearer:owner-artifact-token"]);
    assert.equal(bearer.headers["set-cookie"], undefined);

    const artifactSession = await staticApp.inject({
      method: "GET",
      url: "/artifacts/artifact-owner",
      headers: {
        host: staticHost,
        cookie: `${ARTIFACT_SESSION_COOKIE_NAME}=artifact-session-token`,
      },
    });
    assert.equal(artifactSession.statusCode, 200);
    assert.deepEqual(authorizationCalls, [
      "owner:bearer:owner-artifact-token",
      "owner:artifact-session:artifact-session-token",
    ]);
  });
});

test("private-network and custom exposure use their dedicated authorization ports", async () => {
  await withGateway(async ({ staticApp, store, authorizationCalls }) => {
    await putArtifact(store, {
      artifactId: "artifact-private",
      bytes: Buffer.from("private report"),
      exposureMode: "private-network",
    });
    await putArtifact(store, {
      artifactId: "artifact-custom",
      bytes: Buffer.from("custom report"),
      exposureMode: "custom",
    });

    const privateResponse = await staticApp.inject({
      method: "GET",
      url: "/artifacts/artifact-private",
      remoteAddress: "127.0.0.1",
      headers: {
        host: staticHost,
        "x-forwarded-for": "203.0.113.50",
      },
    });
    assert.equal(privateResponse.statusCode, 200);

    const customDenied = await staticApp.inject({
      method: "GET",
      url: "/artifacts/artifact-custom",
      headers: { host: staticHost },
    });
    assert.equal(customDenied.statusCode, 404);
    const customAllowed = await staticApp.inject({
      method: "GET",
      url: "/artifacts/artifact-custom",
      headers: {
        host: staticHost,
        authorization: "Bearer custom-artifact-token",
      },
    });
    assert.equal(customAllowed.statusCode, 200);
    assert.deepEqual(authorizationCalls, [
      "network:127.0.0.1",
      "custom:policy-preview:",
      "custom:policy-preview:custom-artifact-token",
    ]);
  });
});

test("reverse-proxy client and HTTPS headers are trusted only from the configured proxy source", async () => {
  await withGateway(async ({ store }) => {
    await putArtifact(store, {
      artifactId: "artifact-proxied-private",
      bytes: Buffer.from("proxied private report"),
      exposureMode: "private-network",
    });
    const observedAddresses: string[] = [];
    const app = await createArtifactGatewayApp({
      plane: "static",
      store,
      authorization: {
        async authorizeOwner() {
          return false;
        },
        async authorizePrivateNetwork(input) {
          observedAddresses.push(input.remoteAddress);
          return input.remoteAddress === "100.64.0.10";
        },
        async authorizeCustom() {
          return false;
        },
      },
      staticOrigin: STATIC_ORIGIN,
      interactiveOrigin: INTERACTIVE_ORIGIN,
      adminOrigins: [ADMIN_ORIGIN],
      trustProxyAddress: (address) => address === "127.0.0.1",
      requireForwardedHttps: true,
    });
    try {
      const allowed = await app.inject({
        method: "GET",
        url: "/artifacts/artifact-proxied-private",
        remoteAddress: "127.0.0.1",
        headers: {
          host: staticHost,
          "x-forwarded-for": "100.64.0.10",
          "x-forwarded-proto": "https",
        },
      });
      assert.equal(allowed.statusCode, 200);
      assert.deepEqual(observedAddresses, ["100.64.0.10"]);

      const missingHttpsProof = await app.inject({
        method: "GET",
        url: "/artifacts/artifact-proxied-private",
        remoteAddress: "127.0.0.1",
        headers: {
          host: staticHost,
          "x-forwarded-for": "100.64.0.10",
        },
      });
      assert.equal(missingHttpsProof.statusCode, 421);

      const untrustedProxy = await app.inject({
        method: "GET",
        url: "/artifacts/artifact-proxied-private",
        remoteAddress: "192.0.2.10",
        headers: {
          host: staticHost,
          "x-forwarded-for": "100.64.0.10",
          "x-forwarded-proto": "https",
        },
      });
      assert.equal(untrustedProxy.statusCode, 421);
      assert.deepEqual(observedAddresses, ["100.64.0.10"]);
    } finally {
      await app.close();
    }
  });
});

test("signed-link replay is Artifact-bound until revocation or expiry", async () => {
  await withGateway(async ({ clock, staticApp, store }) => {
    await putArtifact(store, {
      artifactId: "artifact-signed",
      bytes: Buffer.from("signed report"),
      exposureMode: "signed-link",
    });
    await putArtifact(store, {
      artifactId: "artifact-other",
      bytes: Buffer.from("other report"),
      exposureMode: "signed-link",
    });
    const issued = await store.issueSignedToken({
      artifactId: "artifact-signed",
      expiresAtMs: 5_000,
      context,
    });
    const signedUrl = `/artifacts/artifact-signed?token=${encodeURIComponent(issued.token)}`;

    assert.equal(
      (
        await staticApp.inject({
          method: "GET",
          url: signedUrl,
          headers: { host: staticHost },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await staticApp.inject({
          method: "GET",
          url: signedUrl,
          headers: { host: staticHost },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await staticApp.inject({
          method: "GET",
          url: `/artifacts/artifact-other?token=${encodeURIComponent(issued.token)}`,
          headers: { host: staticHost },
        })
      ).statusCode,
      404,
    );

    await store.revokeSignedToken(issued.tokenId, context);
    assert.equal(
      (
        await staticApp.inject({
          method: "GET",
          url: signedUrl,
          headers: { host: staticHost },
        })
      ).statusCode,
      404,
    );

    const expiring = await store.issueSignedToken({
      artifactId: "artifact-signed",
      expiresAtMs: 6_000,
      context,
    });
    clock.value = 6_000;
    assert.equal(
      (
        await staticApp.inject({
          method: "GET",
          url: `/artifacts/artifact-signed?token=${encodeURIComponent(expiring.token)}`,
          headers: { host: staticHost },
        })
      ).statusCode,
      404,
    );
  });
});

test("malicious static HTML keeps scripts inert and interactive HTML uses a distinct opaque sandbox", async () => {
  await withGateway(async ({ interactiveApp, staticApp, store }) => {
    const malicious = Buffer.from(
      `<script>fetch("${ADMIN_ORIGIN}/api/v1/auth/session",{credentials:"include"})</script>` +
        `<form action="${ADMIN_ORIGIN}/api/v1/tasks" method="post"></form>`,
      "utf8",
    );
    await putArtifact(store, {
      artifactId: "artifact-static-html",
      bytes: malicious,
      mediaType: "text/html",
      originalFilename: "report.html",
      exposureMode: "public",
    });
    await putArtifact(store, {
      artifactId: "artifact-interactive-html",
      bytes: malicious,
      mediaType: "text/html",
      originalFilename: "interactive.html",
      exposureMode: "public",
      presentation: "interactive-html",
    });

    const staticResponse = await staticApp.inject({
      method: "GET",
      url: "/artifacts/artifact-static-html",
      headers: { host: staticHost },
    });
    assert.equal(staticResponse.statusCode, 200);
    assert.equal(staticResponse.body, malicious.toString("utf8"));
    const staticCsp = staticResponse.headers["content-security-policy"] ?? "";
    assert.match(staticCsp, /script-src 'none'/);
    assert.match(staticCsp, /sandbox(?:;|$)/);
    assert.doesNotMatch(staticCsp, /allow-scripts/);
    assert.equal(staticResponse.headers["set-cookie"], undefined);

    const wrongPlane = await staticApp.inject({
      method: "GET",
      url: "/artifacts/artifact-interactive-html",
      headers: { host: staticHost },
    });
    assert.equal(wrongPlane.statusCode, 404);
    const interactiveResponse = await interactiveApp.inject({
      method: "GET",
      url: "/artifacts/artifact-interactive-html",
      headers: { host: interactiveHost },
    });
    assert.equal(interactiveResponse.statusCode, 200);
    const interactiveCsp = interactiveResponse.headers["content-security-policy"] ?? "";
    assert.match(interactiveCsp, /sandbox allow-scripts/);
    assert.doesNotMatch(interactiveCsp, /allow-same-origin/);
    assert.match(interactiveCsp, /connect-src 'none'/);
    assert.match(interactiveCsp, /form-action 'none'/);
  });
});

test("malicious SVG is attachment-only and unavailable Artifact states stay non-enumerable", async () => {
  await withGateway(async ({ clock, staticApp, store }) => {
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>`,
    );
    await putArtifact(store, {
      artifactId: "artifact-svg",
      bytes: svg,
      mediaType: "image/svg+xml",
      originalFilename: "malicious.svg",
      exposureMode: "public",
    });
    await putArtifact(store, {
      artifactId: "artifact-expiring",
      bytes: Buffer.from("temporary"),
      exposureMode: "public",
      expiresAtMs: 2_000,
    });

    const svgResponse = await staticApp.inject({
      method: "GET",
      url: "/artifacts/artifact-svg",
      headers: { host: staticHost },
    });
    assert.equal(svgResponse.statusCode, 200);
    assert.match(svgResponse.headers["content-disposition"] ?? "", /^attachment;/);
    assert.match(svgResponse.headers["content-security-policy"] ?? "", /script-src 'none'/);

    clock.value = 2_000;
    const expired = await staticApp.inject({
      method: "GET",
      url: "/artifacts/artifact-expiring",
      headers: { host: staticHost },
    });
    const missing = await staticApp.inject({
      method: "GET",
      url: "/artifacts/artifact-missing",
      headers: { host: staticHost },
    });
    assert.equal(expired.statusCode, 404);
    assert.equal(missing.statusCode, 404);
    assert.equal(expired.body, missing.body);
    assert.equal(expired.body.includes("expired"), false);
  });
});

test("Gateway configuration rejects shared Admin, static, or interactive authority", async () => {
  const authorization: ArtifactAuthorizationPort = {
    async authorizeOwner() {
      return false;
    },
    async authorizePrivateNetwork() {
      return false;
    },
    async authorizeCustom() {
      return false;
    },
  };
  const store = {} as ArtifactStore;

  await assert.rejects(
    createArtifactGatewayApp({
      plane: "static",
      store,
      authorization,
      staticOrigin: ADMIN_ORIGIN,
      interactiveOrigin: INTERACTIVE_ORIGIN,
      adminOrigins: [ADMIN_ORIGIN],
    }),
    /origins and cookie hosts must be distinct/,
  );
  await assert.rejects(
    createArtifactGatewayApp({
      plane: "interactive",
      store,
      authorization,
      staticOrigin: STATIC_ORIGIN,
      interactiveOrigin: STATIC_ORIGIN,
      adminOrigins: [ADMIN_ORIGIN],
    }),
    /origins and cookie hosts must be distinct/,
  );
  await assert.rejects(
    createArtifactGatewayApp({
      plane: "static",
      store,
      authorization,
      staticOrigin: "https://shared.example.test:8443",
      interactiveOrigin: "https://shared.example.test:9443",
      adminOrigins: [ADMIN_ORIGIN],
    }),
    /origins and cookie hosts must be distinct/,
  );
});
