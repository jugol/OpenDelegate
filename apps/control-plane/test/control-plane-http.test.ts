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
import { TaskService } from "@opendelegate/task-service";

import {
  createLocalClaimApp,
  createMainControlPlaneApp,
  OWNER_SESSION_COOKIE_NAME,
} from "../src/index.ts";

const ADMIN_ORIGIN = "https://admin.test";
const ADMIN_HOST = "admin.test";
const CLAIM_ORIGIN = "http://127.0.0.1:4310";
const CLAIM_HOST = "127.0.0.1:4310";
const PASSPHRASE = "correct horse battery staple";
const NEW_PASSPHRASE = "new correct horse battery staple";
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
      releaseChannel: "development",
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
