import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryOwnerAuthRepository,
  OwnerAuth,
  type OwnerAuthClock,
  type PasswordHasher,
  type SecureRandomSource,
} from "@opendelegate/owner-auth";
import { InMemoryEventStore } from "@opendelegate/event-store";
import type {
  ApprovalDetailV1,
  ArtifactDetailV1,
  AuditEventSummaryV1,
  DeviceEnrollmentOverviewV1,
  DeviceSummaryV1,
  IssueEnrollmentGrantResponseV1,
  TaskBudgetSnapshotV1,
} from "@opendelegate/protocol";
import { TaskService } from "@opendelegate/task-service";

import {
  ConfigurationAgentPortError,
  createLocalClaimApp,
  createMainControlPlaneApp,
  OWNER_SESSION_COOKIE_NAME,
} from "../src/index.ts";
import type { ApprovalPort, SecureSecretIngestInput } from "../src/index.ts";
import type { ArtifactAdminPort, AuditAdminPort, DeviceEnrollmentAdminPort } from "../src/index.ts";
import type { TaskBudgetAdminPort } from "../src/index.ts";
import type { ServerFailureDiagnostic } from "../src/index.ts";

const ADMIN_ORIGIN = "https://admin.test";
const ADMIN_HOST = "admin.test";
const CLAIM_ORIGIN = "http://127.0.0.1:4310";
const CLAIM_HOST = "127.0.0.1:4310";
const PASSPHRASE = "🔐".repeat(10);
const NEW_PASSPHRASE = "🔑".repeat(10);
const MAIN_DEVICE = Object.freeze({
  deviceId: "device_main",
  name: "main-host",
  osFamily: "windows" as const,
  platformRelease: "10.0.26100",
  architecture: "x64",
  role: "main" as const,
  connection: "online" as const,
  runtime: "healthy" as const,
  serviceMode: "foreground" as const,
});

class TestClock implements OwnerAuthClock {
  public nowValue = Date.parse("2026-07-24T00:00:00.000Z");

  public now(): number {
    return this.nowValue;
  }
}

class TestRandom implements SecureRandomSource {
  private nextByte = 1;

  public bytes(length: number): Uint8Array {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      bytes[index] = this.nextByte;
      this.nextByte = (this.nextByte % 251) + 1;
    }
    return bytes;
  }
}

class TestPasswordHasher implements PasswordHasher {
  public async hash(passphrase: string): Promise<string> {
    return `$test$${passphrase}`;
  }

  public async verify(encodedPhc: string, passphrase: string): Promise<boolean> {
    return encodedPhc === `$test$${passphrase}`;
  }

  public needsRehash(_encodedPhc: string): boolean {
    return false;
  }
}

interface AuthFixture {
  readonly ownerAuth: OwnerAuth;
  readonly clock: TestClock;
}

function createAuthFixture(): AuthFixture {
  const clock = new TestClock();
  return {
    clock,
    ownerAuth: new OwnerAuth({
      allowedOrigins: [ADMIN_ORIGIN],
      clock,
      passwordHasher: new TestPasswordHasher(),
      random: new TestRandom(),
      repository: new InMemoryOwnerAuthRepository(),
    }),
  };
}

function publicMutationHeaders(origin = ADMIN_ORIGIN): Record<string, string> {
  return {
    host: ADMIN_HOST,
    origin,
    "content-type": "application/json",
    "sec-fetch-site": "same-origin",
  };
}

function authenticatedMutationHeaders(input: {
  readonly cookie: string;
  readonly csrfToken: string;
  readonly origin?: string;
  readonly contentType?: string;
  readonly secFetchSite?: string;
}): Record<string, string> {
  return {
    host: ADMIN_HOST,
    origin: input.origin ?? ADMIN_ORIGIN,
    "content-type": input.contentType ?? "application/json",
    "sec-fetch-site": input.secFetchSite ?? "same-origin",
    cookie: input.cookie,
    "x-opendelegate-csrf": input.csrfToken,
  };
}

function responseHeader(value: string | string[] | undefined): string {
  const header = typeof value === "string" ? value : value?.[0];
  assert.ok(header, "expected a response header");
  return header;
}

function cookiePair(setCookie: string | string[] | undefined): string {
  const pair = responseHeader(setCookie).split(";")[0];
  assert.ok(pair);
  return pair;
}

async function claimOwner(ownerAuth: OwnerAuth): Promise<{
  readonly ownerId: string;
  readonly recoveryCodes: readonly string[];
}> {
  const claim = await ownerAuth.issueInitialClaim({
    channel: "local-bootstrap",
  });
  const app = await createLocalClaimApp({
    ownerAuth,
    allowedOrigins: [CLAIM_ORIGIN],
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/claim",
      headers: {
        host: CLAIM_HOST,
        origin: CLAIM_ORIGIN,
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
      payload: {
        claimToken: claim.claimToken,
        passphrase: PASSPHRASE,
      },
    });

    assert.equal(response.statusCode, 201);
    return response.json();
  } finally {
    await app.close();
  }
}

async function login(ownerAuth: OwnerAuth): Promise<{
  readonly cookie: string;
  readonly csrfToken: string;
  readonly sessionId: string;
  readonly setCookie: string;
}> {
  const app = await createMainControlPlaneApp({
    ownerAuth,
    allowedOrigins: [ADMIN_ORIGIN],
    build: {
      version: "0.0.0-test",
      buildId: "commit-404e432",
    },
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: publicMutationHeaders(),
      payload: { passphrase: PASSPHRASE },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    const setCookie = responseHeader(response.headers["set-cookie"]);
    return {
      cookie: cookiePair(setCookie),
      csrfToken: body.csrfToken,
      sessionId: body.session.sessionId,
      setCookie,
    };
  } finally {
    await app.close();
  }
}

test("normal Main exposes detail-free liveness and never mounts owner claim", async () => {
  const { ownerAuth } = createAuthFixture();
  const app = await createMainControlPlaneApp({
    ownerAuth,
    allowedOrigins: [ADMIN_ORIGIN],
    build: {
      version: "0.0.0-test",
      buildId: "commit-404e432",
    },
  });

  try {
    const live = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { host: ADMIN_HOST },
    });
    assert.equal(live.statusCode, 200);
    assert.deepEqual(live.json(), {
      status: "ok",
      service: "opendelegate-main",
      version: "0.0.0-test",
      buildId: "commit-404e432",
    });
    assert.equal(live.headers["access-control-allow-origin"], undefined);
    assert.match(live.headers["content-security-policy"] ?? "", /default-src 'self'/);

    const claim = await app.inject({
      method: "POST",
      url: "/api/v1/auth/claim",
      headers: {
        ...publicMutationHeaders(),
        "x-forwarded-for": "127.0.0.1",
      },
      payload: {
        claimToken: "a".repeat(43),
        passphrase: PASSPHRASE,
      },
    });
    assert.equal(claim.statusCode, 404);
    assert.equal(claim.json().code, "ROUTE_NOT_FOUND");

    const openApi = app.swagger() as {
      readonly paths?: Readonly<Record<string, unknown>>;
    };
    assert.equal(openApi.paths?.["/api/v1/auth/claim"], undefined);
    assert.notEqual(openApi.paths?.["/api/v1/auth/login"], undefined);
    assert.notEqual(openApi.paths?.["/health/live"], undefined);
  } finally {
    await app.close();
  }
});

test("runtime features expose declared and effective release identity separately", async () => {
  const { ownerAuth } = createAuthFixture();
  await claimOwner(ownerAuth);
  const authenticated = await login(ownerAuth);
  const app = await createMainControlPlaneApp({
    ownerAuth,
    allowedOrigins: [ADMIN_ORIGIN],
    build: {
      version: "0.0.0-test",
      buildId: "commit-404e432",
    },
  });

  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/runtime/features",
      headers: {
        host: ADMIN_HOST,
        cookie: authenticated.cookie,
      },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      declaredReleaseChannel: "development",
      releaseChannel: "development",
      releaseVerification: { status: "not-applicable" },
      taskExecution: { status: "unavailable", code: "ORCHESTRATION_NOT_CONNECTED" },
      configurationAgent: {
        status: "unavailable",
        code: "CONFIGURATION_AGENT_NOT_CONNECTED",
      },
      discord: { status: "unavailable", code: "DISCORD_NOT_CONFIGURED" },
    });
  } finally {
    await app.close();
  }
});

test("claim listener accepts one local claim and ignores forwarded loopback identity", async () => {
  const remoteFixture = createAuthFixture();
  const claim = await remoteFixture.ownerAuth.issueInitialClaim({
    channel: "local-bootstrap",
  });
  const app = await createLocalClaimApp({
    ownerAuth: remoteFixture.ownerAuth,
    allowedOrigins: [CLAIM_ORIGIN],
  });

  try {
    const remote = await app.inject({
      method: "POST",
      url: "/api/v1/auth/claim",
      remoteAddress: "192.0.2.44",
      headers: {
        host: CLAIM_HOST,
        origin: CLAIM_ORIGIN,
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
        "x-forwarded-for": "127.0.0.1",
      },
      payload: {
        claimToken: claim.claimToken,
        passphrase: PASSPHRASE,
      },
    });
    assert.equal(remote.statusCode, 403);
    assert.equal(remote.json().code, "LOCAL_ACCESS_REQUIRED");
    assert.equal(remote.headers["content-type"], "application/problem+json; charset=utf-8");
    assert.equal(remote.headers["cache-control"], "no-store");

    const local = await app.inject({
      method: "POST",
      url: "/api/v1/auth/claim",
      headers: {
        host: CLAIM_HOST,
        origin: CLAIM_ORIGIN,
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
      payload: {
        claimToken: claim.claimToken,
        passphrase: PASSPHRASE,
      },
    });
    assert.equal(local.statusCode, 201);
    assert.equal(local.json().recoveryCodes.length, 10);
    assert.equal(local.headers["cache-control"], "no-store");

    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/auth/claim",
      headers: {
        host: CLAIM_HOST,
        origin: CLAIM_ORIGIN,
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
      payload: {
        claimToken: claim.claimToken,
        passphrase: PASSPHRASE,
      },
    });
    assert.equal(replay.statusCode, 400);
    assert.equal(replay.json().code, "CLAIM_INVALID");

    const healthIsAbsent = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { host: CLAIM_HOST },
    });
    assert.equal(healthIsAbsent.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("login uses the exact host-only secure cookie and unlocks session/readiness", async () => {
  const { ownerAuth } = createAuthFixture();
  await claimOwner(ownerAuth);
  const app = await createMainControlPlaneApp({
    ownerAuth,
    allowedOrigins: [ADMIN_ORIGIN],
    build: {
      version: "0.0.0-test",
      buildId: "commit-404e432",
    },
    readiness: () => ({
      status: "ready",
      checks: [{ status: "ready", code: "CONTROL_PLANE_READY" }],
    }),
  });

  try {
    const loginResponse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: publicMutationHeaders(),
      payload: { passphrase: PASSPHRASE },
    });
    assert.equal(loginResponse.statusCode, 200);
    const setCookie = responseHeader(loginResponse.headers["set-cookie"]);
    assert.match(setCookie, new RegExp(`^${OWNER_SESSION_COOKIE_NAME}=`));
    assert.match(setCookie, /;\s*Path=\//i);
    assert.match(setCookie, /;\s*Secure/i);
    assert.match(setCookie, /;\s*HttpOnly/i);
    assert.match(setCookie, /;\s*SameSite=Lax/i);
    assert.doesNotMatch(setCookie, /;\s*Domain=/i);
    assert.equal(loginResponse.headers["cache-control"], "no-store");
    assert.equal(loginResponse.json().sessionToken, undefined);

    const cookie = cookiePair(setCookie);
    const session = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { host: ADMIN_HOST, cookie },
    });
    assert.equal(session.statusCode, 200);
    assert.equal(session.json().csrfToken.length, 43);

    const readiness = await app.inject({
      method: "GET",
      url: "/api/v1/readiness",
      headers: { host: ADMIN_HOST, cookie },
    });
    assert.equal(readiness.statusCode, 200);
    assert.deepEqual(readiness.json(), {
      status: "ready",
      checks: [{ status: "ready", code: "CONTROL_PLANE_READY" }],
    });

    const anonymousReadiness = await app.inject({
      method: "GET",
      url: "/api/v1/readiness",
      headers: { host: ADMIN_HOST },
    });
    assert.equal(anonymousReadiness.statusCode, 401);
    assert.equal(anonymousReadiness.json().code, "AUTHENTICATION_REQUIRED");
  } finally {
    await app.close();
  }
});

test("unsafe routes fail closed on origin, content type, Fetch Metadata, CSRF, and unknown fields", async () => {
  const { ownerAuth } = createAuthFixture();
  await claimOwner(ownerAuth);
  const authenticated = await login(ownerAuth);
  const app = await createMainControlPlaneApp({
    ownerAuth,
    allowedOrigins: [ADMIN_ORIGIN],
    build: {
      version: "0.0.0-test",
      buildId: "commit-404e432",
    },
  });

  try {
    const attempts = [
      authenticatedMutationHeaders({
        ...authenticated,
        origin: "https://admin.test.evil.invalid",
      }),
      authenticatedMutationHeaders({
        ...authenticated,
        contentType: "text/plain",
      }),
      authenticatedMutationHeaders({
        ...authenticated,
        secFetchSite: "cross-site",
      }),
      authenticatedMutationHeaders({
        ...authenticated,
        csrfToken: "x".repeat(43),
      }),
    ];

    for (const headers of attempts) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/logout",
        headers,
        payload: {},
      });
      assert.equal(response.statusCode, 403);
      assert.equal(response.json().code, "CSRF_INVALID");
      assert.equal(response.headers["access-control-allow-origin"], undefined);
    }

    const unknownField = await app.inject({
      method: "POST",
      url: "/api/v1/auth/reauthenticate",
      headers: authenticatedMutationHeaders(authenticated),
      payload: {
        passphrase: PASSPHRASE,
        passwordPhc: "$argon2id$must-not-leak",
      },
    });
    assert.equal(unknownField.statusCode, 400);
    assert.deepEqual(Object.keys(unknownField.json()).sort(), [
      "code",
      "correlationId",
      "status",
      "title",
      "type",
    ]);
    assert.equal(unknownField.json().code, "INVALID_REQUEST");
    assert.doesNotMatch(unknownField.body, /argon2|passwordPhc|additionalProperties/i);
  } finally {
    await app.close();
  }
});

test("reauthentication rotates the bearer and sessions can be listed, revoked, and logged out", async () => {
  const { ownerAuth } = createAuthFixture();
  await claimOwner(ownerAuth);
  const first = await login(ownerAuth);
  const second = await login(ownerAuth);
  const app = await createMainControlPlaneApp({
    ownerAuth,
    allowedOrigins: [ADMIN_ORIGIN],
    build: {
      version: "0.0.0-test",
      buildId: "commit-404e432",
    },
  });

  try {
    const reauthenticated = await app.inject({
      method: "POST",
      url: "/api/v1/auth/reauthenticate",
      headers: authenticatedMutationHeaders(first),
      payload: { passphrase: PASSPHRASE },
    });
    assert.equal(reauthenticated.statusCode, 200);
    const replacementCookie = cookiePair(reauthenticated.headers["set-cookie"]);
    assert.notEqual(replacementCookie, first.cookie);

    const oldSession = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { host: ADMIN_HOST, cookie: first.cookie },
    });
    assert.equal(oldSession.statusCode, 401);
    assert.equal(oldSession.json().code, "AUTHENTICATION_REQUIRED");

    const sessions = await app.inject({
      method: "GET",
      url: "/api/v1/auth/sessions",
      headers: { host: ADMIN_HOST, cookie: replacementCookie },
    });
    assert.equal(sessions.statusCode, 200);
    assert.equal(
      sessions
        .json()
        .sessions.some((session: { sessionId: string }) => session.sessionId === second.sessionId),
      true,
    );
    const replacementCsrf = reauthenticated.json().csrfToken;

    const revoked = await app.inject({
      method: "POST",
      url: `/api/v1/auth/sessions/${second.sessionId}/revoke`,
      headers: authenticatedMutationHeaders({
        cookie: replacementCookie,
        csrfToken: replacementCsrf,
      }),
      payload: {},
    });
    assert.equal(revoked.statusCode, 200);
    assert.deepEqual(revoked.json(), { status: "ok" });

    const revokedSession = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { host: ADMIN_HOST, cookie: second.cookie },
    });
    assert.equal(revokedSession.statusCode, 401);

    const logout = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: authenticatedMutationHeaders({
        cookie: replacementCookie,
        csrfToken: replacementCsrf,
      }),
      payload: {},
    });
    assert.equal(logout.statusCode, 200);
    assert.match(responseHeader(logout.headers["set-cookie"]), /Max-Age=0/i);

    const loggedOut = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { host: ADMIN_HOST, cookie: replacementCookie },
    });
    assert.equal(loggedOut.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("recovery works without Discord and revokes every browser session", async () => {
  const { ownerAuth } = createAuthFixture();
  const claimed = await claimOwner(ownerAuth);
  const authenticated = await login(ownerAuth);
  const app = await createMainControlPlaneApp({
    ownerAuth,
    allowedOrigins: [ADMIN_ORIGIN],
    build: {
      version: "0.0.0-test",
      buildId: "commit-404e432",
    },
  });

  try {
    const begun = await app.inject({
      method: "POST",
      url: "/api/v1/auth/recovery/begin",
      headers: publicMutationHeaders(),
      payload: { recoveryCode: claimed.recoveryCodes[0] },
    });
    assert.equal(begun.statusCode, 200);
    assert.equal(begun.headers["cache-control"], "no-store");

    const completed = await app.inject({
      method: "POST",
      url: "/api/v1/auth/recovery/complete",
      headers: publicMutationHeaders(),
      payload: {
        recoveryToken: begun.json().recoveryToken,
        newPassphrase: NEW_PASSPHRASE,
      },
    });
    assert.equal(completed.statusCode, 200);
    assert.equal(completed.headers["cache-control"], "no-store");
    assert.equal(completed.json().recoveryCodes.length, 10);
    assert.notDeepEqual(completed.json().recoveryCodes, claimed.recoveryCodes);

    const priorSession = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { host: ADMIN_HOST, cookie: authenticated.cookie },
    });
    assert.equal(priorSession.statusCode, 401);

    const oldLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: publicMutationHeaders(),
      payload: { passphrase: PASSPHRASE },
    });
    assert.equal(oldLogin.statusCode, 401);

    const newLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: publicMutationHeaders(),
      payload: { passphrase: NEW_PASSPHRASE },
    });
    assert.equal(newLogin.statusCode, 200);
  } finally {
    await app.close();
  }
});

test("problems are correlation-bound, bounded, and redact raw validation/internal detail", async () => {
  const { ownerAuth } = createAuthFixture();
  const app = await createMainControlPlaneApp({
    ownerAuth,
    allowedOrigins: [ADMIN_ORIGIN],
    build: {
      version: "0.0.0-test",
      buildId: "commit-404e432",
    },
  });

  try {
    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: {
        ...publicMutationHeaders(),
        "x-correlation-id": "task:release-check",
      },
      payload: { passphrase: "short", databaseUri: "postgres://owner:secret@db" },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.headers["content-type"], "application/problem+json; charset=utf-8");
    assert.equal(invalid.headers["x-correlation-id"], "task:release-check");
    assert.equal(invalid.json().correlationId, "task:release-check");
    assert.doesNotMatch(invalid.body, /secret|databaseUri|passphrase|minLength|stack/i);

    const tooLarge = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: publicMutationHeaders(),
      payload: { passphrase: "a".repeat(256 * 1024) },
    });
    assert.equal(tooLarge.statusCode, 413);
    assert.equal(tooLarge.json().code, "REQUEST_BODY_TOO_LARGE");

    const invalidCorrelation = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: {
        host: ADMIN_HOST,
        "x-correlation-id": "contains whitespace",
      },
    });
    assert.equal(invalidCorrelation.statusCode, 400);
    assert.equal(invalidCorrelation.json().code, "CORRELATION_ID_INVALID");
    assert.match(invalidCorrelation.json().correlationId, /^correlation_[0-9a-f-]{36}$/);

    const spoofedHost = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: {
        host: "evil.invalid",
        "x-forwarded-host": ADMIN_HOST,
      },
    });
    assert.equal(spoofedHost.statusCode, 421);
    assert.equal(spoofedHost.json().code, "HOST_NOT_ALLOWED");
  } finally {
    await app.close();
  }
});

test("HTTP ingress rate limiting returns a sanitized problem", async () => {
  const { ownerAuth } = createAuthFixture();
  await claimOwner(ownerAuth);
  const app = await createMainControlPlaneApp({
    ownerAuth,
    allowedOrigins: [ADMIN_ORIGIN],
    build: {
      version: "0.0.0-test",
      buildId: "commit-404e432",
    },
  });

  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/recovery/complete",
        headers: publicMutationHeaders(),
        payload: {
          recoveryToken: "r".repeat(43),
          newPassphrase: NEW_PASSPHRASE,
        },
      });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().code, "RECOVERY_INVALID");
    }
    const recoveryCompletionLimited = await app.inject({
      method: "POST",
      url: "/api/v1/auth/recovery/complete",
      headers: publicMutationHeaders(),
      payload: {
        recoveryToken: "r".repeat(43),
        newPassphrase: NEW_PASSPHRASE,
      },
    });
    assert.equal(recoveryCompletionLimited.statusCode, 429);
    assert.equal(recoveryCompletionLimited.json().code, "RATE_LIMITED");

    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/recovery/begin",
        headers: publicMutationHeaders(),
        payload: { recoveryCode: `odr_${"z".repeat(22)}` },
      });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().code, "RECOVERY_INVALID");
    }

    const limited = await app.inject({
      method: "POST",
      url: "/api/v1/auth/recovery/begin",
      headers: publicMutationHeaders(),
      payload: { recoveryCode: `odr_${"z".repeat(22)}` },
    });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().code, "RATE_LIMITED");
    assert.deepEqual(Object.keys(limited.json()).sort(), [
      "code",
      "correlationId",
      "status",
      "title",
      "type",
    ]);
  } finally {
    await app.close();
  }
});

test("Configuration Chat is authenticated, Device-scoped, and idempotency-bound", async () => {
  const { ownerAuth } = createAuthFixture();
  const owner = await claimOwner(ownerAuth);
  const authenticated = await login(ownerAuth);
  const calls: unknown[] = [];
  const app = await createMainControlPlaneApp({
    ownerAuth,
    allowedOrigins: [ADMIN_ORIGIN],
    build: {
      version: "0.0.0-test",
      buildId: "commit-404e432",
    },
    devices: [MAIN_DEVICE],
    runtimeFeatures: {
      declaredReleaseChannel: "development",
      releaseChannel: "development",
      releaseVerification: { status: "not-applicable" },
      taskExecution: { status: "unavailable", code: "TEST_TASK_UNAVAILABLE" },
      configurationAgent: { status: "ready", code: "TEST_CONFIGURATION_AGENT_READY" },
      discord: { status: "unavailable", code: "TEST_DISCORD_UNAVAILABLE" },
    },
    configurationAgent: {
      async listMessages(input) {
        assert.deepEqual(input, {
          deviceId: MAIN_DEVICE.deviceId,
          principalId: owner.ownerId,
        });
        return {
          messages: [
            {
              messageId: "configuration_owner_001",
              role: "owner",
              content: "Inspect this Device and recommend a safe setup.",
              occurredAt: "2026-07-24T00:00:00.000Z",
            },
            {
              messageId: "configuration_message_001",
              role: "agent",
              content: "I prepared a reviewable Device-scoped proposal.",
              occurredAt: "2026-07-24T00:00:01.000Z",
            },
          ],
        };
      },
      async sendMessage(input) {
        calls.push(input);
        if (input.message === "Trigger an interrupted provider turn.") {
          throw new ConfigurationAgentPortError(
            "CONFIGURATION_AGENT_UNAVAILABLE",
            "The Configuration Agent did not complete its turn. Diagnostic code: PROVIDER_CONNECTION_CLOSED.",
            "PROVIDER_CONNECTION_CLOSED",
          );
        }
        return {
          messageId: "configuration_message_001",
          sessionId: "configuration_session_device_main",
          content: "I prepared a reviewable Device-scoped proposal.",
          occurredAt: "2026-07-24T00:00:00.000Z",
        };
      },
    },
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/devices/${MAIN_DEVICE.deviceId}/configuration/messages`,
      headers: {
        ...authenticatedMutationHeaders(authenticated),
        "accept-language": "ko-KR, en;q=0.8",
        "idempotency-key": "configuration-message-1",
      },
      payload: {
        message: "Inspect this Device and recommend a safe setup.",
      },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      messageId: "configuration_message_001",
      sessionId: "configuration_session_device_main",
      content: "I prepared a reviewable Device-scoped proposal.",
      occurredAt: "2026-07-24T00:00:00.000Z",
    });
    assert.deepEqual(calls, [
      {
        deviceId: MAIN_DEVICE.deviceId,
        principalId: owner.ownerId,
        idempotencyKey: "configuration-message-1",
        message: "Inspect this Device and recommend a safe setup.",
        responseLocale: "ko",
      },
    ]);

    const interrupted = await app.inject({
      method: "POST",
      url: `/api/v1/devices/${MAIN_DEVICE.deviceId}/configuration/messages`,
      headers: {
        ...authenticatedMutationHeaders(authenticated),
        "idempotency-key": "configuration-message-interrupted",
      },
      payload: { message: "Trigger an interrupted provider turn." },
    });
    assert.equal(interrupted.statusCode, 503);
    assert.equal(interrupted.json().code, "CONFIGURATION_AGENT_UNAVAILABLE");
    assert.equal(
      interrupted.json().detail,
      "The Configuration Agent did not complete its turn. Diagnostic code: PROVIDER_CONNECTION_CLOSED.",
    );
    assert.equal(interrupted.json().diagnosticCode, "PROVIDER_CONNECTION_CLOSED");
    assert.equal(typeof interrupted.json().correlationId, "string");

    const history = await app.inject({
      method: "GET",
      url: `/api/v1/devices/${MAIN_DEVICE.deviceId}/configuration/messages`,
      headers: { host: ADMIN_HOST, cookie: authenticated.cookie },
    });
    assert.equal(history.statusCode, 200);
    assert.deepEqual(
      history
        .json()
        .messages.map((message: { readonly role: string; readonly content: string }) => ({
          role: message.role,
          content: message.content,
        })),
      [
        {
          role: "owner",
          content: "Inspect this Device and recommend a safe setup.",
        },
        {
          role: "agent",
          content: "I prepared a reviewable Device-scoped proposal.",
        },
      ],
    );

    const unknownDevice = await app.inject({
      method: "POST",
      url: "/api/v1/devices/device_unknown/configuration/messages",
      headers: {
        ...authenticatedMutationHeaders(authenticated),
        "idempotency-key": "configuration-message-2",
      },
      payload: { message: "Inspect an unknown Device." },
    });
    assert.equal(unknownDevice.statusCode, 404);
    assert.equal(unknownDevice.json().code, "DEVICE_NOT_FOUND");
    assert.equal(calls.length, 2);

    const secretShapedField = await app.inject({
      method: "POST",
      url: `/api/v1/devices/${MAIN_DEVICE.deviceId}/configuration/messages`,
      headers: {
        ...authenticatedMutationHeaders(authenticated),
        "idempotency-key": "configuration-message-3",
      },
      payload: {
        message: "Configure a credential reference.",
        secretValue: "must-not-cross-this-contract",
      },
    });
    assert.equal(secretShapedField.statusCode, 400);
    assert.doesNotMatch(secretShapedField.body, /must-not-cross|secretValue/i);
    assert.equal(calls.length, 2);
  } finally {
    await app.close();
  }
});

test("an unconnected Configuration Agent runtime reports its readiness code as the diagnostic", async () => {
  const { ownerAuth } = createAuthFixture();
  await claimOwner(ownerAuth);
  const authenticated = await login(ownerAuth);
  const app = await createMainControlPlaneApp({
    ownerAuth,
    allowedOrigins: [ADMIN_ORIGIN],
    build: {
      version: "0.0.0-test",
      buildId: "commit-404e432",
    },
    devices: [MAIN_DEVICE],
    runtimeFeatures: {
      declaredReleaseChannel: "development",
      releaseChannel: "development",
      releaseVerification: { status: "not-applicable" },
      taskExecution: { status: "unavailable", code: "TEST_TASK_UNAVAILABLE" },
      configurationAgent: {
        status: "unavailable",
        code: "CONFIGURATION_AGENT_NOT_CONNECTED",
      },
      discord: { status: "unavailable", code: "TEST_DISCORD_UNAVAILABLE" },
    },
  });

  try {
    const send = await app.inject({
      method: "POST",
      url: `/api/v1/devices/${MAIN_DEVICE.deviceId}/configuration/messages`,
      headers: {
        ...authenticatedMutationHeaders(authenticated),
        "idempotency-key": "configuration-message-not-connected",
      },
      payload: { message: "Change the Coordinator profile." },
    });
    assert.equal(send.statusCode, 503);
    assert.equal(send.json().code, "CONFIGURATION_AGENT_UNAVAILABLE");
    assert.equal(send.json().diagnosticCode, "CONFIGURATION_AGENT_NOT_CONNECTED");
  } finally {
    await app.close();
  }
});

test("every 5xx problem reaches the diagnostic sink with its correlation ID and route template", async () => {
  const { ownerAuth } = createAuthFixture();
  await claimOwner(ownerAuth);
  const authenticated = await login(ownerAuth);
  const failures: ServerFailureDiagnostic[] = [];
  const app = await createMainControlPlaneApp({
    ownerAuth,
    allowedOrigins: [ADMIN_ORIGIN],
    build: {
      version: "0.0.0-test",
      buildId: "commit-404e432",
    },
    devices: [MAIN_DEVICE],
    onServerFailure: (diagnostic) => {
      failures.push(diagnostic);
    },
    runtimeFeatures: {
      declaredReleaseChannel: "development",
      releaseChannel: "development",
      releaseVerification: { status: "not-applicable" },
      taskExecution: { status: "unavailable", code: "TEST_TASK_UNAVAILABLE" },
      configurationAgent: { status: "ready", code: "TEST_CONFIGURATION_AGENT_READY" },
      discord: { status: "unavailable", code: "TEST_DISCORD_UNAVAILABLE" },
    },
    configurationAgent: {
      async sendMessage() {
        throw new ConfigurationAgentPortError(
          "CONFIGURATION_AGENT_UNAVAILABLE",
          "The Configuration Agent stopped before creating the required owner Approval.",
          "CONFIGURATION_PROPOSAL_APPROVAL_NOT_CREATED",
        );
      },
    },
  });

  try {
    const send = await app.inject({
      method: "POST",
      url: `/api/v1/devices/${MAIN_DEVICE.deviceId}/configuration/messages`,
      headers: {
        ...authenticatedMutationHeaders(authenticated),
        "idempotency-key": "configuration-message-diagnostic-sink",
      },
      payload: { message: "Change the Coordinator profile." },
    });
    assert.equal(send.statusCode, 503);

    assert.equal(failures.length, 1);
    const failure = failures[0];
    assert.equal(failure?.code, "CONFIGURATION_AGENT_UNAVAILABLE");
    assert.equal(failure?.diagnosticCode, "CONFIGURATION_PROPOSAL_APPROVAL_NOT_CREATED");
    assert.equal(failure?.status, 503);
    assert.equal(failure?.method, "POST");
    assert.equal(failure?.correlationId, send.json().correlationId);
    // The route template keeps the Device ID out of the diagnostic record.
    assert.equal(failure?.route, "/api/v1/devices/:deviceId/configuration/messages");
    assert.doesNotMatch(failure?.route ?? "", new RegExp(MAIN_DEVICE.deviceId, "u"));
    assert.equal(
      failure?.detail,
      "The Configuration Agent stopped before creating the required owner Approval.",
    );

    // A rejected 4xx request is an ordinary outcome, not a server failure.
    const rejected = await app.inject({
      method: "POST",
      url: `/api/v1/devices/${MAIN_DEVICE.deviceId}/configuration/messages`,
      headers: { host: ADMIN_HOST, "idempotency-key": "configuration-message-rejected" },
      payload: { message: "Change the Coordinator profile." },
    });
    assert.equal(rejected.statusCode, 403);
    assert.equal(failures.length, 1);
  } finally {
    await app.close();
  }
});

test("durable Configuration Chat history remains readable when native messaging is unavailable", async () => {
  const { ownerAuth } = createAuthFixture();
  await claimOwner(ownerAuth);
  const authenticated = await login(ownerAuth);
  const app = await createMainControlPlaneApp({
    ownerAuth,
    allowedOrigins: [ADMIN_ORIGIN],
    build: {
      version: "0.0.0-test",
      buildId: "commit-404e432",
    },
    devices: [MAIN_DEVICE],
    runtimeFeatures: {
      declaredReleaseChannel: "development",
      releaseChannel: "development",
      releaseVerification: { status: "not-applicable" },
      taskExecution: { status: "unavailable", code: "TEST_TASK_UNAVAILABLE" },
      configurationAgent: { status: "unavailable", code: "TEST_PROVIDER_UNAVAILABLE" },
      discord: { status: "unavailable", code: "TEST_DISCORD_UNAVAILABLE" },
    },
    configurationAgent: {
      async listMessages() {
        return {
          messages: [
            {
              messageId: "configuration_agent_degraded_001",
              role: "agent",
              content: "This completed exchange remains durable.",
              occurredAt: "2026-07-24T00:00:01.000Z",
            },
          ],
        };
      },
      async sendMessage() {
        throw new Error("Native messaging is unavailable.");
      },
    },
  });

  try {
    const history = await app.inject({
      method: "GET",
      url: `/api/v1/devices/${MAIN_DEVICE.deviceId}/configuration/messages`,
      headers: { host: ADMIN_HOST, cookie: authenticated.cookie },
    });
    assert.equal(history.statusCode, 200);
    assert.equal(history.json().messages[0]?.content, "This completed exchange remains durable.");

    const send = await app.inject({
      method: "POST",
      url: `/api/v1/devices/${MAIN_DEVICE.deviceId}/configuration/messages`,
      headers: {
        ...authenticatedMutationHeaders(authenticated),
        "idempotency-key": "configuration-message-degraded",
      },
      payload: { message: "Continue setup." },
    });
    assert.equal(send.statusCode, 503);
    assert.equal(send.json().code, "CONFIGURATION_AGENT_UNAVAILABLE");
  } finally {
    await app.close();
  }
});

test("Approval routes require owner auth, CSRF, and idempotency for exact decisions", async () => {
  const { ownerAuth } = createAuthFixture();
  const owner = await claimOwner(ownerAuth);
  const authenticated = await login(ownerAuth);
  const projected: ApprovalDetailV1 = {
    approvalId: "approval_001",
    state: "pending" as const,
    executionStatus: "waiting" as const,
    requestedAt: "2026-07-24T00:00:00.000Z",
    expiresAt: "2026-07-25T00:00:00.000Z",
    action: {
      category: "policy-relaxation" as const,
      type: "configuration.apply",
      fingerprint: `sha256:${"a".repeat(64)}`,
      targetDeviceId: "device_main",
      resource: "configuration-proposal:proposal_001",
    },
    reason: "Allow automatic network changes.",
    target: "device_main",
    risk: "high" as const,
    evidence: ["policy.network-change at Device scope"],
    configuration: {
      proposalId: "proposal_001",
      baseRevision: 4,
      changes: [
        {
          key: "policy.network-change",
          scope: { kind: "device" as const, id: "device_main" },
          before: { present: true as const, valueJson: '"require-approval"' },
          after: { present: true as const, valueJson: '"allow"' },
        },
      ],
    },
  };
  const calls: unknown[] = [];
  const decisions = new Map<string, ApprovalDetailV1>();
  const approvals: ApprovalPort = {
    list: async () => [projected],
    get: async (approvalId) => {
      assert.equal(approvalId, projected.approvalId);
      return projected;
    },
    decide: async (input) => {
      calls.push(input);
      const existing = decisions.get(input.idempotencyKey);
      if (existing !== undefined) {
        return existing;
      }
      assert.deepEqual(input.decision, { decision: "approve", scope: "once" });
      const result = {
        ...projected,
        state: "approved" as const,
        executionStatus: "succeeded" as const,
        decision: {
          decision: "approve" as const,
          scope: "once" as const,
          decidedBy: input.principalId,
          decidedAt: "2026-07-24T00:01:00.000Z",
        },
      };
      decisions.set(input.idempotencyKey, result);
      return result;
    },
  };
  const app = await createMainControlPlaneApp({
    ownerAuth,
    allowedOrigins: [ADMIN_ORIGIN],
    build: {
      version: "0.0.0-test",
      buildId: "commit-404e432",
    },
    approvals,
  });

  try {
    const anonymous = await app.inject({
      method: "GET",
      url: "/api/v1/approvals",
      headers: { host: ADMIN_HOST },
    });
    assert.equal(anonymous.statusCode, 401);

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/approvals",
      headers: { host: ADMIN_HOST, cookie: authenticated.cookie },
    });
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(listed.json(), { approvals: [projected] });

    const preview = await app.inject({
      method: "GET",
      url: `/api/v1/approvals/${projected.approvalId}`,
      headers: { host: ADMIN_HOST, cookie: authenticated.cookie },
    });
    assert.equal(preview.statusCode, 200);
    assert.deepEqual(preview.json(), projected);

    const missingCsrf = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${projected.approvalId}/decision`,
      headers: {
        host: ADMIN_HOST,
        cookie: authenticated.cookie,
        origin: ADMIN_ORIGIN,
        "content-type": "application/json",
        "idempotency-key": "approval-decision-001",
      },
      payload: { decision: "approve", scope: "once" },
    });
    assert.equal(missingCsrf.statusCode, 403);
    assert.equal(calls.length, 0);

    const headers = {
      ...authenticatedMutationHeaders(authenticated),
      "idempotency-key": "approval-decision-001",
    };
    const approved = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${projected.approvalId}/decision`,
      headers,
      payload: { decision: "approve", scope: "once" },
    });
    const replay = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${projected.approvalId}/decision`,
      headers,
      payload: { decision: "approve", scope: "once" },
    });
    assert.equal(approved.statusCode, 200);
    assert.deepEqual(replay.json(), approved.json());
    assert.deepEqual(calls, [
      {
        approvalId: projected.approvalId,
        principalId: owner.ownerId,
        idempotencyKey: "approval-decision-001",
        decision: { decision: "approve", scope: "once" },
      },
      {
        approvalId: projected.approvalId,
        principalId: owner.ownerId,
        idempotencyKey: "approval-decision-001",
        decision: { decision: "approve", scope: "once" },
      },
    ]);

    const leaked = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${projected.approvalId}/decision`,
      headers: {
        ...authenticatedMutationHeaders(authenticated),
        "idempotency-key": "approval-decision-leaked",
      },
      payload: {
        decision: "approve",
        scope: "once",
        secretValue: "must-not-cross-the-approval-boundary",
      },
    });
    assert.equal(leaked.statusCode, 400);
    assert.doesNotMatch(leaked.body, /must-not-cross|secretValue/i);
  } finally {
    await app.close();
  }
});

test("owner operations routes expose Device enrollment, Artifact metadata, and redacted Audit diagnostics", async () => {
  const { ownerAuth } = createAuthFixture();
  const owner = await claimOwner(ownerAuth);
  const authenticated = await login(ownerAuth);
  const NOW = "2026-07-25T00:00:00.000Z";
  const enrollmentOverview: DeviceEnrollmentOverviewV1 = {
    available: true,
    mainDeviceId: MAIN_DEVICE.deviceId,
    expectedMainSpkiSha256: "a".repeat(64),
    enrollmentUrl: "https://main.test:9443/api/v1/device/enroll",
    channelEndpoints: [
      {
        endpointId: "main-worker-channel",
        label: "Main Worker channel",
        kind: "wss",
        url: "wss://main.test:9444/api/v1/device/channel",
      },
    ],
    grants: [],
  };
  const issued: IssueEnrollmentGrantResponseV1 = {
    summary: {
      grantId: "grant_001",
      deviceId: "device_worker",
      status: "active",
      allowedBootstrapRoles: ["worker"],
      createdAt: NOW,
      expiresAt: "2026-07-25T00:05:00.000Z",
    },
    suggestedFilename: "opendelegate-device_worker-grant.json",
    document: {
      schemaVersion: 1,
      grantId: "grant_001",
      token: "g".repeat(43),
      deviceId: "device_worker",
      mainDeviceId: MAIN_DEVICE.deviceId,
      expectedMainSpkiSha256: "a".repeat(64),
      certificateAuthorityPem: `-----BEGIN CERTIFICATE-----\n${"A".repeat(96)}\n-----END CERTIFICATE-----\n`,
      enrollmentUrl: "https://main.test:9443/api/v1/device/enroll",
      channelEndpoints: enrollmentOverview.channelEndpoints ?? [],
      protocolRange: { minimum: 1, maximum: 1 },
      expiresAt: Date.parse("2026-07-25T00:05:00.000Z"),
    },
  };
  const artifact: ArtifactDetailV1 = {
    artifactId: "artifact_report",
    taskId: "task_release",
    producingRunId: "run_worker",
    mediaType: "text/html",
    originalFilename: "release-report.html",
    sizeBytes: 4096,
    checksum: { algorithm: "sha256", value: "b".repeat(64) },
    createdAt: NOW,
    retentionPolicy: {
      kind: "temporary",
      expiresAt: "2026-07-26T00:00:00.000Z",
    },
    exposurePolicy: { mode: "authenticated" },
    provenance: {
      deviceId: "device_worker",
      source: "worker-upload",
    },
    presentation: "static-html",
    state: "available",
  };
  const auditEvent: AuditEventSummaryV1 = {
    auditId: "audit_001",
    source: "device-identity",
    type: "device.enrolled",
    occurredAt: NOW,
    outcome: "succeeded",
    subjectId: "device_worker",
    deviceId: "device_worker",
  };
  const calls: unknown[] = [];
  const enrollment: DeviceEnrollmentAdminPort = {
    overview: async () => enrollmentOverview,
    issue: async (input) => {
      calls.push(input);
      return issued;
    },
  };
  const artifacts: ArtifactAdminPort = {
    list: async () => [artifact],
    get: async (artifactId) => {
      assert.equal(artifactId, artifact.artifactId);
      return artifact;
    },
    open: async (input) => {
      calls.push(input);
      return {
        method: "POST",
        actionUrl: "https://static.artifacts.test/artifacts/artifact_report",
        fieldName: "grant",
        fieldValue: "x".repeat(43),
        artifactId: artifact.artifactId,
        expiresAt: "2026-07-25T00:01:00.000Z",
      };
    },
  };
  const audit: AuditAdminPort = {
    list: async () => [auditEvent],
  };
  const app = await createMainControlPlaneApp({
    ownerAuth,
    allowedOrigins: [ADMIN_ORIGIN],
    build: {
      version: "0.0.0-test",
      buildId: "commit-404e432",
    },
    enrollment,
    artifacts,
    audit,
  });

  try {
    for (const url of ["/api/v1/device-enrollment", "/api/v1/artifacts", "/api/v1/audit-events"]) {
      const anonymous = await app.inject({ method: "GET", url, headers: { host: ADMIN_HOST } });
      assert.equal(anonymous.statusCode, 401);
    }

    const overview = await app.inject({
      method: "GET",
      url: "/api/v1/device-enrollment",
      headers: { host: ADMIN_HOST, cookie: authenticated.cookie },
    });
    assert.deepEqual(overview.json(), enrollmentOverview);

    const grant = await app.inject({
      method: "POST",
      url: "/api/v1/device-enrollment/grants",
      headers: {
        ...authenticatedMutationHeaders(authenticated),
        "idempotency-key": "enrollment-grant-001",
      },
      payload: { deviceId: "device_worker", expiresInSeconds: 300 },
    });
    assert.equal(grant.statusCode, 201);
    assert.deepEqual(grant.json(), issued);
    assert.match(grant.headers["cache-control"] ?? "", /no-store/u);

    const artifactList = await app.inject({
      method: "GET",
      url: "/api/v1/artifacts",
      headers: { host: ADMIN_HOST, cookie: authenticated.cookie },
    });
    assert.deepEqual(artifactList.json(), { artifacts: [artifact] });
    const artifactDetail = await app.inject({
      method: "GET",
      url: `/api/v1/artifacts/${artifact.artifactId}`,
      headers: { host: ADMIN_HOST, cookie: authenticated.cookie },
    });
    assert.deepEqual(artifactDetail.json(), artifact);
    const opened = await app.inject({
      method: "POST",
      url: `/api/v1/artifacts/${artifact.artifactId}/open`,
      headers: {
        ...authenticatedMutationHeaders(authenticated),
        "idempotency-key": "artifact-open-001",
      },
      payload: {},
    });
    assert.equal(opened.statusCode, 200);
    assert.equal(opened.json().method, "POST");

    const auditResponse = await app.inject({
      method: "GET",
      url: "/api/v1/audit-events",
      headers: { host: ADMIN_HOST, cookie: authenticated.cookie },
    });
    assert.deepEqual(auditResponse.json(), { events: [auditEvent] });
    assert.doesNotMatch(auditResponse.body, /knowledge|secret|payload/iu);

    assert.deepEqual(calls, [
      {
        deviceId: "device_worker",
        expiresInSeconds: 300,
        principalId: owner.ownerId,
        idempotencyKey: "enrollment-grant-001",
      },
      {
        artifactId: artifact.artifactId,
        principalId: owner.ownerId,
        idempotencyKey: "artifact-open-001",
      },
    ]);
  } finally {
    await app.close();
  }
});

test("authenticated Task routes provide idempotent Discord-independent emergency control", async () => {
  const { ownerAuth, clock } = createAuthFixture();
  await claimOwner(ownerAuth);
  const authenticated = await login(ownerAuth);
  const eventClock = {
    now: () => new Date(clock.now()).toISOString(),
  };
  const tasks = new TaskService({
    clock: eventClock,
    eventStore: new InMemoryEventStore({ clock: eventClock }),
  });
  const app = await createMainControlPlaneApp({
    ownerAuth,
    allowedOrigins: [ADMIN_ORIGIN],
    build: {
      version: "0.0.0-test",
      buildId: "commit-404e432",
    },
    runtimeFeatures: {
      declaredReleaseChannel: "development",
      releaseChannel: "development",
      releaseVerification: { status: "not-applicable" },
      taskExecution: { status: "ready", code: "TEST_TASK_EXECUTION_READY" },
      configurationAgent: { status: "unavailable", code: "TEST_AGENT_UNAVAILABLE" },
      discord: { status: "unavailable", code: "TEST_DISCORD_UNAVAILABLE" },
    },
    tasks,
  });

  try {
    const createHeaders = {
      ...authenticatedMutationHeaders(authenticated),
      "idempotency-key": "admin-task-1",
    };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: createHeaders,
      payload: {
        objective: "Inspect Tasks while Discord is unavailable.",
        completionCriteria: ["The Task is visible in Admin."],
        constraints: ["Do not require Discord."],
        selectedInputRefs: [],
      },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().mode, "auto");
    assert.equal(created.json().state, "intake");

    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: createHeaders,
      payload: {
        objective: "Inspect Tasks while Discord is unavailable.",
        completionCriteria: ["The Task is visible in Admin."],
        constraints: ["Do not require Discord."],
        selectedInputRefs: [],
      },
    });
    assert.equal(replay.statusCode, 201);
    assert.equal(replay.json().taskId, created.json().taskId);

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/tasks",
      headers: {
        host: ADMIN_HOST,
        cookie: authenticated.cookie,
      },
    });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().tasks.length, 1);

    const paused = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${created.json().taskId}/actions`,
      headers: {
        ...authenticatedMutationHeaders(authenticated),
        "idempotency-key": "admin-pause-1",
      },
      payload: { command: "pause" },
    });
    assert.equal(paused.statusCode, 200);
    assert.equal(paused.json().state, "paused");

    const missingIdempotency = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${created.json().taskId}/actions`,
      headers: authenticatedMutationHeaders(authenticated),
      payload: { command: "cancel" },
    });
    assert.equal(missingIdempotency.statusCode, 400);
    assert.equal(missingIdempotency.json().code, "IDEMPOTENCY_KEY_INVALID");

    const anonymous = await app.inject({
      method: "GET",
      url: "/api/v1/tasks",
      headers: { host: ADMIN_HOST },
    });
    assert.equal(anonymous.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("Task Budget routes require owner auth, CSRF, exact limits, and an idempotency identity", async () => {
  const { ownerAuth } = createAuthFixture();
  const claimed = await claimOwner(ownerAuth);
  const authenticated = await login(ownerAuth);
  const snapshot = taskBudgetSnapshot();
  const extensionInputs: Parameters<TaskBudgetAdminPort["extend"]>[0][] = [];
  const budgets: TaskBudgetAdminPort = {
    async get(taskId) {
      assert.equal(taskId, snapshot.taskId);
      return snapshot;
    },
    async extend(input) {
      extensionInputs.push(structuredClone(input));
      return {
        ...snapshot,
        revision: snapshot.revision + 1,
      };
    },
  };
  const app = await createMainControlPlaneApp({
    ownerAuth,
    allowedOrigins: [ADMIN_ORIGIN],
    build: {
      version: "0.0.0-test",
      buildId: "commit-budget",
    },
    budgets,
  });

  try {
    const anonymous = await app.inject({
      method: "GET",
      url: `/api/v1/tasks/${snapshot.taskId}/budget`,
      headers: { host: ADMIN_HOST },
    });
    assert.equal(anonymous.statusCode, 401);

    const read = await app.inject({
      method: "GET",
      url: `/api/v1/tasks/${snapshot.taskId}/budget`,
      headers: { host: ADMIN_HOST, cookie: authenticated.cookie },
    });
    assert.equal(read.statusCode, 200);
    assert.deepEqual(read.json(), snapshot);

    const invalidCsrf = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${snapshot.taskId}/budget/extensions`,
      headers: {
        ...authenticatedMutationHeaders({
          ...authenticated,
          csrfToken: "x".repeat(43),
        }),
        "idempotency-key": "extend-budget-invalid-csrf",
      },
      payload: {
        baseRevision: snapshot.revision,
        limits: snapshot.limits,
      },
    });
    assert.equal(invalidCsrf.statusCode, 403);
    assert.equal(extensionInputs.length, 0);

    const incomplete = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${snapshot.taskId}/budget/extensions`,
      headers: {
        ...authenticatedMutationHeaders(authenticated),
        "idempotency-key": "extend-budget-incomplete",
      },
      payload: {
        baseRevision: snapshot.revision,
        limits: { tokens: { hard: 2_000 } },
      },
    });
    assert.equal(incomplete.statusCode, 400);
    assert.equal(incomplete.json().code, "INVALID_REQUEST");
    assert.equal(extensionInputs.length, 0);

    const missingIdempotency = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${snapshot.taskId}/budget/extensions`,
      headers: authenticatedMutationHeaders(authenticated),
      payload: {
        baseRevision: snapshot.revision,
        limits: snapshot.limits,
      },
    });
    assert.equal(missingIdempotency.statusCode, 400);
    assert.equal(missingIdempotency.json().code, "IDEMPOTENCY_KEY_INVALID");

    const extended = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${snapshot.taskId}/budget/extensions`,
      headers: {
        ...authenticatedMutationHeaders(authenticated),
        "idempotency-key": "extend-budget-release",
      },
      payload: {
        baseRevision: snapshot.revision,
        limits: snapshot.limits,
      },
    });
    assert.equal(extended.statusCode, 200);
    assert.equal(extended.json().revision, snapshot.revision + 1);
    assert.deepEqual(extensionInputs, [
      {
        taskId: snapshot.taskId,
        principalId: claimed.ownerId,
        idempotencyKey: "extend-budget-release",
        baseRevision: snapshot.revision,
        limits: snapshot.limits,
      },
    ]);
  } finally {
    await app.close();
  }
});

test("secure Secret ingest requires owner auth and CSRF, forwards bounded bytes, and zeroizes them", async () => {
  const { ownerAuth } = createAuthFixture();
  const owner = await claimOwner(ownerAuth);
  const authenticated = await login(ownerAuth);
  const calls: SecureSecretIngestInput[] = [];
  const app = await createMainControlPlaneApp({
    ownerAuth,
    allowedOrigins: [ADMIN_ORIGIN],
    build: {
      version: "0.0.0-test",
      buildId: "commit-404e432",
    },
    secretIngest: {
      ingest: async (input) => {
        assert.equal(
          Buffer.from(input.secret).toString("utf8"),
          "postgresql://owner:secure-only@database.test/main",
        );
        calls.push(input);
        return {
          schemaVersion: 1,
          secretRef: "secret://main/database_test",
          availability: "ready",
        };
      },
    },
  });
  const material = Buffer.from("postgresql://owner:secure-only@database.test/main", "utf8");
  const payload = {
    purpose: "database-uri",
    secretBase64: material.toString("base64"),
  };

  try {
    const anonymous = await app.inject({
      method: "POST",
      url: "/api/v1/secrets/ingest",
      headers: {
        ...publicMutationHeaders(),
        "idempotency-key": "secret-ingest-anonymous",
      },
      payload,
    });
    assert.equal(anonymous.statusCode, 401);
    assert.equal(anonymous.json().code, "AUTHENTICATION_REQUIRED");
    assert.equal(calls.length, 0);

    const invalidCsrf = await app.inject({
      method: "POST",
      url: "/api/v1/secrets/ingest",
      headers: {
        ...authenticatedMutationHeaders({
          ...authenticated,
          csrfToken: "x".repeat(43),
        }),
        "idempotency-key": "secret-ingest-invalid-csrf",
      },
      payload,
    });
    assert.equal(invalidCsrf.statusCode, 403);
    assert.equal(invalidCsrf.json().code, "CSRF_INVALID");
    assert.equal(calls.length, 0);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/secrets/ingest",
      headers: {
        ...authenticatedMutationHeaders(authenticated),
        "idempotency-key": "secret-ingest-database-1",
      },
      payload,
    });
    assert.equal(response.statusCode, 201);
    assert.deepEqual(response.json(), {
      schemaVersion: 1,
      secretRef: "secret://main/database_test",
      availability: "ready",
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.principalId, owner.ownerId);
    assert.equal(calls[0]?.idempotencyKey, "secret-ingest-database-1");
    assert.equal(calls[0]?.purpose, "database-uri");
    assert.ok(calls[0]?.secret.every((byte) => byte === 0));
    assert.equal(response.body.includes(payload.secretBase64), false);
    assert.equal(response.body.includes("secure-only"), false);

    const oversized = Buffer.alloc(65_537, 0x61);
    const rejected = await app.inject({
      method: "POST",
      url: "/api/v1/secrets/ingest",
      headers: {
        ...authenticatedMutationHeaders(authenticated),
        "idempotency-key": "secret-ingest-oversized",
      },
      payload: {
        purpose: "service-credential",
        secretBase64: oversized.toString("base64"),
      },
    });
    oversized.fill(0);
    assert.equal(rejected.statusCode, 400);
    assert.equal(rejected.json().code, "SECRET_INGEST_INVALID");
    assert.equal(calls.length, 1);
    assert.equal(rejected.body.includes("YWFhYWFh"), false);
  } finally {
    material.fill(0);
    await app.close();
  }
});

test("authenticated Device route returns exactly the supplied Device and no inferred state", async () => {
  const { ownerAuth } = createAuthFixture();
  await claimOwner(ownerAuth);
  const authenticated = await login(ownerAuth);
  const app = await createMainControlPlaneApp({
    ownerAuth,
    allowedOrigins: [ADMIN_ORIGIN],
    build: {
      version: "0.0.0-test",
      buildId: "commit-404e432",
    },
    devices: [MAIN_DEVICE],
  });

  try {
    const anonymous = await app.inject({
      method: "GET",
      url: "/api/v1/devices",
      headers: { host: ADMIN_HOST },
    });
    assert.equal(anonymous.statusCode, 401);
    assert.equal(anonymous.json().code, "AUTHENTICATION_REQUIRED");

    const authenticatedResponse = await app.inject({
      method: "GET",
      url: "/api/v1/devices",
      headers: {
        host: ADMIN_HOST,
        cookie: authenticated.cookie,
      },
    });
    assert.equal(authenticatedResponse.statusCode, 200);
    assert.deepEqual(authenticatedResponse.json(), {
      devices: [MAIN_DEVICE],
    });
    assert.deepEqual(Object.keys(authenticatedResponse.json().devices[0]).sort(), [
      "architecture",
      "connection",
      "deviceId",
      "name",
      "osFamily",
      "platformRelease",
      "role",
      "runtime",
      "serviceMode",
    ]);
  } finally {
    await app.close();
  }
});

test("authenticated Device routes read the current durable fleet projection", async () => {
  const { ownerAuth } = createAuthFixture();
  await claimOwner(ownerAuth);
  const authenticated = await login(ownerAuth);
  let devices: DeviceSummaryV1[] = [MAIN_DEVICE];
  const app = await createMainControlPlaneApp({
    ownerAuth,
    allowedOrigins: [ADMIN_ORIGIN],
    build: {
      version: "0.0.0-test",
      buildId: "commit-404e432",
    },
    deviceDirectory: {
      list: async () => devices,
    },
  });

  try {
    devices = [
      MAIN_DEVICE,
      {
        ...MAIN_DEVICE,
        deviceId: "device-worker-1",
        name: "Worker",
        role: "worker",
      },
    ];
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/devices",
      headers: {
        host: ADMIN_HOST,
        cookie: authenticated.cookie,
      },
    });
    assert.deepEqual(
      response.json().devices.map((device: { deviceId: string }) => device.deviceId),
      ["device_main", "device-worker-1"],
    );
  } finally {
    await app.close();
  }
});

function taskBudgetSnapshot(): TaskBudgetSnapshotV1 {
  const limits = {
    wallTimeMs: { soft: 50_000, hard: 60_000 },
    idleTimeMs: { soft: 5_000, hard: 10_000 },
    retries: { soft: 1, hard: 2 },
    childWorkOrders: { soft: 1, hard: 2 },
    concurrentRuns: { soft: 1, hard: 2 },
    nativeTurns: { soft: 3, hard: 4 },
    tokens: { soft: 800, hard: 1_000 },
    costUsdMicros: { soft: 8_000, hard: 10_000 },
  };
  return {
    schemaVersion: 1,
    taskId: "task_budget_release",
    kind: "requested",
    revision: 1,
    createdAt: "2026-07-25T00:00:00.000Z",
    lastActivityAt: "2026-07-25T00:00:01.000Z",
    limits,
    usage: {
      wallTimeMs: 1_000,
      idleTimeMs: 100,
      retries: 0,
      childWorkOrders: 1,
      concurrentRuns: 1,
      nativeTurns: 1,
      tokens: 850,
      costUsdMicros: 5_000,
    },
    workOrders: [],
    activeRunIds: ["run_budget_release"],
    limitEvents: [
      {
        eventId: "event_budget_soft_tokens",
        metric: "tokens",
        state: "soft-limit",
        current: 850,
        hard: 1_000,
        attempted: 850,
        occurredAt: "2026-07-25T00:00:01.000Z",
      },
    ],
    extensions: [],
    omitted: {
      workOrders: 0,
      activeRunIds: 0,
      limitEvents: 0,
      extensions: 0,
    },
  };
}
