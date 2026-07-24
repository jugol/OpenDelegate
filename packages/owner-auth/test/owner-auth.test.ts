import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  Argon2idPasswordHasher,
  InMemoryOwnerAuthRepository,
  OwnerAuth,
  OwnerAuthError,
  redactOwnerAuthCredentials,
  type OwnerAuthClock,
  type PasswordHasher,
  type SecureRandomSource,
} from "../src/index.ts";

test("a loopback-only claim creates exactly one owner and returns recovery codes once", async () => {
  const harness = createHarness();
  const issued = await harness.auth.issueInitialClaim({ channel: "local-bootstrap" });

  assert.equal(issued.expiresAt, NOW + 10 * 60_000);
  assert.match(issued.claimToken, /^[A-Za-z0-9_-]{43}$/);

  const claimed = await harness.auth.claimOwner({
    channel: "local-bootstrap",
    claimToken: issued.claimToken,
    passphrase: "correct horse battery staple",
  });

  assert.equal(claimed.recoveryCodes.length, 10);
  assert.equal(new Set(claimed.recoveryCodes).size, 10);
  assert.equal(
    claimed.recoveryCodes.every((code) => /^odr_[A-Za-z0-9_-]{22}$/.test(code)),
    true,
  );

  await assert.rejects(
    harness.auth.claimOwner({
      channel: "local-bootstrap",
      claimToken: issued.claimToken,
      passphrase: "correct horse battery staple",
    }),
    isAuthError("CLAIM_INVALID"),
  );

  const snapshot = await harness.repository.snapshot();
  const serialized = JSON.stringify(snapshot);
  assert.equal(snapshot.claim, null);
  assert.equal(snapshot.owner?.passwordPhc.startsWith("$fake$"), true);
  assert.equal(snapshot.recoveryCodes.length, 10);
  assert.equal(snapshot.sessions.length, 0);
  assert.equal(serialized.includes(issued.claimToken), false);
  assert.equal(serialized.includes("correct horse battery staple"), false);
  for (const recoveryCode of claimed.recoveryCodes) {
    assert.equal(serialized.includes(recoveryCode), false);
  }
});

test("remote, expired, weak, and concurrent claims fail closed with one atomic winner", async () => {
  const harness = createHarness();
  await assert.rejects(
    harness.auth.issueInitialClaim({ channel: "external-admin" }),
    isAuthError("LOCAL_ACCESS_REQUIRED"),
  );
  const issued = await harness.auth.issueInitialClaim({ channel: "local-bootstrap" });
  await assert.rejects(
    harness.auth.claimOwner({
      channel: "external-admin",
      claimToken: issued.claimToken,
      passphrase: "correct horse battery staple",
    }),
    isAuthError("LOCAL_ACCESS_REQUIRED"),
  );
  await assert.rejects(
    harness.auth.claimOwner({
      channel: "local-bootstrap",
      claimToken: issued.claimToken,
      passphrase: "elevenchars",
    }),
    isAuthError("PASSPHRASE_INVALID"),
  );

  const attempts = await Promise.allSettled(
    Array.from({ length: 12 }, () =>
      harness.auth.claimOwner({
        channel: "local-bootstrap",
        claimToken: issued.claimToken,
        passphrase: "correct horse battery staple",
      }),
    ),
  );
  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(
    attempts.filter(
      (result) =>
        result.status === "rejected" &&
        result.reason instanceof OwnerAuthError &&
        result.reason.code === "CLAIM_INVALID",
    ).length,
    11,
  );

  const snapshot = await harness.repository.snapshot();
  assert.equal(
    snapshot.auditRecords.filter((record) => record.event === "owner.auth.claimed").length,
    1,
  );

  const expiredHarness = createHarness();
  const expired = await expiredHarness.auth.issueInitialClaim({ channel: "local-bootstrap" });
  expiredHarness.clock.value += 10 * 60_000;
  await assert.rejects(
    expiredHarness.auth.claimOwner({
      channel: "local-bootstrap",
      claimToken: expired.claimToken,
      passphrase: "correct horse battery staple",
    }),
    isAuthError("CLAIM_INVALID"),
  );
  assert.equal((await expiredHarness.repository.snapshot()).owner, null);
});

test("passphrase login returns opaque browser credentials while persisting only a session digest", async () => {
  const harness = createHarness();
  await initializeOwner(harness);

  const login = await harness.auth.login({
    passphrase: "correct horse battery staple",
    sourceKey: "192.0.2.10",
  });

  assert.match(login.sessionToken, /^[A-Za-z0-9_-]{43}$/);
  assert.match(login.csrfToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(login.session.createdAt, NOW);
  assert.equal(login.session.idleExpiresAt, NOW + 24 * 60 * 60_000);
  assert.equal(login.session.absoluteExpiresAt, NOW + 30 * 24 * 60 * 60_000);

  const snapshot = await harness.repository.snapshot();
  const serialized = JSON.stringify(snapshot);
  assert.equal(snapshot.sessions.length, 1);
  assert.match(snapshot.sessions[0]?.tokenDigest ?? "", /^sha256:[a-f0-9]{64}$/);
  assert.equal("csrfDigest" in (snapshot.sessions[0] ?? {}), false);
  assert.equal(serialized.includes(login.sessionToken), false);
  assert.equal(serialized.includes(login.csrfToken), false);
});

test("login throttles both the source and single owner account without persisting the source value", async () => {
  const harness = createHarness();
  await initializeOwner(harness);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(
      harness.auth.login({
        passphrase: "incorrect passphrase",
        sourceKey: "sensitive-client-address",
      }),
      isAuthError("AUTHENTICATION_FAILED"),
    );
  }
  await assert.rejects(
    harness.auth.login({
      passphrase: "correct horse battery staple",
      sourceKey: "a-different-client",
    }),
    isAuthError("RATE_LIMITED"),
  );

  const throttled = await harness.repository.snapshot();
  assert.equal(JSON.stringify(throttled).includes("sensitive-client-address"), false);

  harness.clock.value += 15 * 60_000;
  const login = await harness.auth.login({
    passphrase: "correct horse battery staple",
    sourceKey: "a-different-client",
  });
  assert.equal(login.session.ownerId.startsWith("owner_"), true);
});

test("session and CSRF checks enforce idle expiry, exact origin, JSON, and cross-site rejection", async () => {
  const harness = createHarness();
  await initializeOwner(harness);
  const login = await harness.auth.login({
    passphrase: "correct horse battery staple",
    sourceKey: "192.0.2.20",
  });

  assert.deepEqual(
    await harness.auth.validateUnsafeRequest({
      sessionToken: login.sessionToken,
      csrfToken: login.csrfToken,
      origin: "https://admin.example.test",
      contentType: "application/json; charset=utf-8",
      secFetchSite: "same-origin",
    }),
    login.session,
  );
  assert.equal(await harness.auth.issueCsrfToken(login.sessionToken), login.csrfToken);

  const invalidRequests = [
    { csrfToken: "wrong" },
    { origin: "https://attacker.example" },
    { contentType: "text/plain" },
    { secFetchSite: "cross-site" },
  ] as const;
  for (const override of invalidRequests) {
    await assert.rejects(
      harness.auth.validateUnsafeRequest({
        sessionToken: login.sessionToken,
        csrfToken: login.csrfToken,
        origin: "https://admin.example.test",
        contentType: "application/json",
        secFetchSite: "same-origin",
        ...override,
      }),
      isAuthError("CSRF_INVALID"),
    );
  }

  harness.clock.value = NOW + 24 * 60 * 60_000;
  await assert.rejects(
    harness.auth.validateSession(login.sessionToken),
    isAuthError("SESSION_INVALID"),
  );
});

test("allowed origins are immutable trusted configuration and non-loopback HTTP is rejected", async () => {
  const origins = ["https://admin.example.test"];
  const harness = createHarness({ allowedOrigins: origins });
  origins[0] = "https://attacker.example";
  await initializeOwner(harness);
  const login = await harness.auth.login({
    passphrase: "correct horse battery staple",
    sourceKey: "192.0.2.21",
  });

  await assert.rejects(
    harness.auth.validateUnsafeRequest({
      sessionToken: login.sessionToken,
      csrfToken: login.csrfToken,
      origin: "https://attacker.example",
      contentType: "application/json",
      secFetchSite: "same-origin",
    }),
    isAuthError("CSRF_INVALID"),
  );
  assert.throws(
    () =>
      createHarness({
        allowedOrigins: ["http://admin.example.test"],
      }),
    isAuthError("AUTHENTICATION_UNAVAILABLE"),
  );
});

test("last use is bounded while absolute expiry cannot be extended", async () => {
  const harness = createHarness();
  await initializeOwner(harness);
  const login = await harness.auth.login({
    passphrase: "correct horse battery staple",
    sourceKey: "192.0.2.22",
  });

  harness.clock.value = NOW + 4 * 60_000;
  await harness.auth.validateSession(login.sessionToken);
  assert.equal((await harness.repository.snapshot()).sessions[0]?.lastUsedAt, NOW);
  harness.clock.value = NOW + 5 * 60_000;
  await harness.auth.validateSession(login.sessionToken);
  assert.equal((await harness.repository.snapshot()).sessions[0]?.lastUsedAt, harness.clock.value);

  for (let offset = 23 * 60 * 60_000; offset < 30 * 24 * 60 * 60_000; offset += 23 * 60 * 60_000) {
    harness.clock.value = NOW + offset;
    await harness.auth.validateSession(login.sessionToken);
  }
  harness.clock.value = NOW + 30 * 24 * 60 * 60_000;
  await assert.rejects(
    harness.auth.validateSession(login.sessionToken),
    isAuthError("SESSION_INVALID"),
  );
});

test("reauthentication requires the passphrase, rotates the bearer and CSRF, and restores freshness", async () => {
  const harness = createHarness();
  await initializeOwner(harness);
  const login = await harness.auth.login({
    passphrase: "correct horse battery staple",
    sourceKey: "192.0.2.30",
  });

  harness.clock.value = NOW + 5 * 60_000 + 1;
  await assert.rejects(
    harness.auth.requireFreshAuthentication(login.sessionToken),
    isAuthError("AUTHENTICATION_STALE"),
  );

  const rotated = await harness.auth.reauthenticate({
    sessionToken: login.sessionToken,
    passphrase: "correct horse battery staple",
    sourceKey: "192.0.2.30",
  });

  assert.notEqual(rotated.sessionToken, login.sessionToken);
  assert.notEqual(rotated.csrfToken, login.csrfToken);
  assert.equal(
    (await harness.auth.requireFreshAuthentication(rotated.sessionToken)).authenticatedAt,
    harness.clock.value,
  );
  await assert.rejects(
    harness.auth.validateSession(login.sessionToken),
    isAuthError("SESSION_INVALID"),
  );
});

test("an owner can list safe session metadata, revoke another session, and log out", async () => {
  const harness = createHarness();
  await initializeOwner(harness);
  const first = await harness.auth.login({
    passphrase: "correct horse battery staple",
    sourceKey: "192.0.2.40",
  });
  const second = await harness.auth.login({
    passphrase: "correct horse battery staple",
    sourceKey: "192.0.2.41",
  });

  const sessions = await harness.auth.listSessions(first.sessionToken);
  assert.equal(sessions.length, 2);
  assert.equal(sessions.filter((session) => session.current).length, 1);
  assert.equal(JSON.stringify(sessions).includes("tokenDigest"), false);

  await harness.auth.revokeSession({
    sessionToken: first.sessionToken,
    sessionId: second.session.sessionId,
  });
  await assert.rejects(
    harness.auth.validateSession(second.sessionToken),
    isAuthError("SESSION_INVALID"),
  );

  await harness.auth.logout(first.sessionToken);
  await assert.rejects(
    harness.auth.validateSession(first.sessionToken),
    isAuthError("SESSION_INVALID"),
  );
});

test("one recovery code creates one short-lived recovery state under concurrent replay", async () => {
  const harness = createHarness();
  const recoveryCodes = await initializeOwner(harness);
  const code = recoveryCodes[0];
  if (code === undefined) {
    throw new Error("Expected an initial recovery code.");
  }

  const attempts = await Promise.allSettled(
    Array.from({ length: 12 }, () => harness.auth.beginRecovery({ recoveryCode: code })),
  );
  const winners = attempts.filter(
    (result): result is PromiseFulfilledResult<Awaited<ReturnType<OwnerAuth["beginRecovery"]>>> =>
      result.status === "fulfilled",
  );

  assert.equal(winners.length, 1);
  assert.equal(
    attempts.filter(
      (result) =>
        result.status === "rejected" &&
        result.reason instanceof OwnerAuthError &&
        result.reason.code === "RECOVERY_INVALID",
    ).length,
    11,
  );

  const recovery = winners[0]?.value;
  if (recovery === undefined) {
    throw new Error("Expected one recovery winner.");
  }
  const snapshot = await harness.repository.snapshot();
  const serialized = JSON.stringify(snapshot);
  assert.equal(snapshot.recoveryCodes.filter((item) => item.consumedAt === NOW).length, 1);
  assert.equal(snapshot.recoveryStates.length, 1);
  assert.equal(serialized.includes(code), false);
  assert.equal(serialized.includes(recovery.recoveryToken), false);
});

test("recovery rotates every code and credential while revoking every browser session atomically", async () => {
  const harness = createHarness();
  const originalCodes = await initializeOwner(harness);
  const firstSession = await harness.auth.login({
    passphrase: "correct horse battery staple",
    sourceKey: "192.0.2.50",
  });
  const secondSession = await harness.auth.login({
    passphrase: "correct horse battery staple",
    sourceKey: "192.0.2.51",
  });
  const recovery = await harness.auth.beginRecovery({
    recoveryCode: originalCodes[0] ?? "",
  });

  const completed = await harness.auth.completeRecovery({
    recoveryToken: recovery.recoveryToken,
    newPassphrase: "a new and independent passphrase",
  });

  assert.equal(completed.recoveryCodes.length, 10);
  assert.equal(
    completed.recoveryCodes.some((code) => originalCodes.includes(code)),
    false,
  );
  await assert.rejects(
    harness.auth.validateSession(firstSession.sessionToken),
    isAuthError("SESSION_INVALID"),
  );
  await assert.rejects(
    harness.auth.validateSession(secondSession.sessionToken),
    isAuthError("SESSION_INVALID"),
  );
  await assert.rejects(
    harness.auth.beginRecovery({ recoveryCode: originalCodes[1] ?? "" }),
    isAuthError("RECOVERY_INVALID"),
  );
  await assert.rejects(
    harness.auth.completeRecovery({
      recoveryToken: recovery.recoveryToken,
      newPassphrase: "another passphrase",
    }),
    isAuthError("RECOVERY_INVALID"),
  );
  await assert.rejects(
    harness.auth.login({
      passphrase: "correct horse battery staple",
      sourceKey: "192.0.2.52",
    }),
    isAuthError("AUTHENTICATION_FAILED"),
  );
  const newSession = await harness.auth.login({
    passphrase: "a new and independent passphrase",
    sourceKey: "192.0.2.53",
  });
  assert.equal(newSession.session.ownerId, firstSession.session.ownerId);

  const snapshot = await harness.repository.snapshot();
  const serialized = JSON.stringify(snapshot);
  assert.equal(snapshot.owner?.credentialVersion, 2);
  assert.equal(
    snapshot.sessions.every((session) => session.revokedAt !== undefined),
    false,
  );
  for (const code of [...originalCodes, ...completed.recoveryCodes]) {
    assert.equal(serialized.includes(code), false);
  }
});

test("concurrent recovery completion has one winner and one atomic audit record", async () => {
  const harness = createHarness();
  const codes = await initializeOwner(harness);
  const recovery = await harness.auth.beginRecovery({
    recoveryCode: codes[0] ?? "",
  });

  const attempts = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      harness.auth.completeRecovery({
        recoveryToken: recovery.recoveryToken,
        newPassphrase: "a new and independent passphrase",
      }),
    ),
  );

  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(
    attempts.filter(
      (result) =>
        result.status === "rejected" &&
        result.reason instanceof OwnerAuthError &&
        result.reason.code === "RECOVERY_INVALID",
    ).length,
    7,
  );
  const snapshot = await harness.repository.snapshot();
  assert.equal(snapshot.owner?.credentialVersion, 2);
  assert.equal(
    snapshot.auditRecords.filter((record) => record.event === "owner.auth.recovered").length,
    1,
  );
});

test("an invalid recovery bearer is rejected before any passphrase hash work", async () => {
  const harness = createHarness();
  await initializeOwner(harness);
  const hashesBefore = harness.passwordHasher.hashCalls;

  await assert.rejects(
    harness.auth.completeRecovery({
      recoveryToken: "invalid-but-well-shaped-recovery-token",
      newPassphrase: "a new and independent passphrase",
    }),
    isAuthError("RECOVERY_INVALID"),
  );

  assert.equal(harness.passwordHasher.hashCalls, hashesBefore);
});

test("a password-hasher failure cannot partially consume a claim or recovery state", async () => {
  const claimHarness = createHarness();
  const claim = await claimHarness.auth.issueInitialClaim({ channel: "local-bootstrap" });
  claimHarness.passwordHasher.failHash = true;
  await assert.rejects(
    claimHarness.auth.claimOwner({
      channel: "local-bootstrap",
      claimToken: claim.claimToken,
      passphrase: "correct horse battery staple",
    }),
    isAuthError("AUTHENTICATION_UNAVAILABLE"),
  );
  const failedClaim = await claimHarness.repository.snapshot();
  assert.notEqual(failedClaim.claim, null);
  assert.equal(failedClaim.owner, null);

  const recoveryHarness = createHarness();
  const codes = await initializeOwner(recoveryHarness);
  const login = await recoveryHarness.auth.login({
    passphrase: "correct horse battery staple",
    sourceKey: "192.0.2.54",
  });
  const recovery = await recoveryHarness.auth.beginRecovery({
    recoveryCode: codes[0] ?? "",
  });
  recoveryHarness.passwordHasher.failHash = true;
  await assert.rejects(
    recoveryHarness.auth.completeRecovery({
      recoveryToken: recovery.recoveryToken,
      newPassphrase: "a new and independent passphrase",
    }),
    isAuthError("AUTHENTICATION_UNAVAILABLE"),
  );
  const failedRecovery = await recoveryHarness.repository.snapshot();
  assert.equal(failedRecovery.owner?.credentialVersion, 1);
  assert.equal(failedRecovery.recoveryStates[0]?.consumedAt, undefined);
  assert.equal(
    failedRecovery.sessions.find((session) => session.sessionId === login.session.sessionId)
      ?.revokedAt,
    undefined,
  );
  assert.equal(
    failedRecovery.auditRecords.some((record) => record.event === "owner.auth.recovered"),
    false,
  );
});

test("claim and recovery expiry are evaluated at the atomic acceptance instant", async () => {
  const claimHarness = createHarness();
  const claim = await claimHarness.auth.issueInitialClaim({ channel: "local-bootstrap" });
  claimHarness.passwordHasher.onHash = () => {
    claimHarness.clock.value = claim.expiresAt;
  };
  await assert.rejects(
    claimHarness.auth.claimOwner({
      channel: "local-bootstrap",
      claimToken: claim.claimToken,
      passphrase: "correct horse battery staple",
    }),
    isAuthError("CLAIM_INVALID"),
  );
  assert.equal((await claimHarness.repository.snapshot()).owner, null);

  const recoveryHarness = createHarness();
  const codes = await initializeOwner(recoveryHarness);
  const recovery = await recoveryHarness.auth.beginRecovery({
    recoveryCode: codes[0] ?? "",
  });
  recoveryHarness.passwordHasher.onHash = () => {
    recoveryHarness.clock.value = recovery.expiresAt;
  };
  await assert.rejects(
    recoveryHarness.auth.completeRecovery({
      recoveryToken: recovery.recoveryToken,
      newPassphrase: "a new and independent passphrase",
    }),
    isAuthError("RECOVERY_INVALID"),
  );
  assert.equal((await recoveryHarness.repository.snapshot()).owner?.credentialVersion, 1);

  const sessionHarness = createHarness();
  await initializeOwner(sessionHarness);
  const login = await sessionHarness.auth.login({
    passphrase: "correct horse battery staple",
    sourceKey: "192.0.2.60",
  });
  for (let offset = 23 * 60 * 60_000; offset < 30 * 24 * 60 * 60_000; offset += 23 * 60 * 60_000) {
    sessionHarness.clock.value = NOW + offset;
    await sessionHarness.auth.validateSession(login.sessionToken);
  }
  sessionHarness.clock.value = login.session.absoluteExpiresAt - 1;
  sessionHarness.passwordHasher.onVerify = () => {
    sessionHarness.clock.value = login.session.absoluteExpiresAt;
  };
  await assert.rejects(
    sessionHarness.auth.reauthenticate({
      sessionToken: login.sessionToken,
      passphrase: "correct horse battery staple",
      sourceKey: "192.0.2.60",
    }),
    isAuthError("AUTHENTICATION_FAILED"),
  );
  const expiredSession = await sessionHarness.repository.snapshot();
  assert.equal(expiredSession.sessions.length, 1);
  assert.equal(
    expiredSession.auditRecords.some((record) => record.event === "owner.auth.reauthenticated"),
    false,
  );
});

test("credential redaction is structural, recursive, cycle-safe, and never invokes accessors", () => {
  const circular: Record<string, unknown> = {
    safe: "visible",
    passphrase: "raw-passphrase",
    nested: {
      sessionToken: "raw-session-token",
      recoveryCodes: ["raw-recovery-code"],
      csrfToken: "raw-csrf-token",
    },
  };
  circular.self = circular;
  let getterCalls = 0;
  Object.defineProperty(circular, "claimToken", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "raw-claim-token";
    },
  });

  const redacted = redactOwnerAuthCredentials(circular);
  const serialized = JSON.stringify(redacted);

  assert.equal(getterCalls, 0);
  assert.equal((redacted as { safe: string }).safe, "visible");
  for (const secret of [
    "raw-passphrase",
    "raw-session-token",
    "raw-recovery-code",
    "raw-csrf-token",
    "raw-claim-token",
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.equal(serialized.includes("[REDACTED]"), true);
  assert.equal(serialized.includes("[CIRCULAR]"), true);
});

test("the production Argon2id adapter emits the accepted PHC floor and verifies without retaining input", async () => {
  const hasher = new Argon2idPasswordHasher({
    random: new FixedRandomSource(),
  });

  const encoded = await hasher.hash("production-grade passphrase");

  assert.match(encoded, /^\$argon2id\$v=19\$m=65536,t=3,p=4\$/);
  assert.equal(await hasher.verify(encoded, "production-grade passphrase"), true);
  assert.equal(await hasher.verify(encoded, "not the passphrase"), false);
  assert.equal(hasher.needsRehash(encoded), false);
  assert.equal(
    hasher.needsRehash(
      "$argon2id$v=19$m=32768,t=2,p=1$MDEyMzQ1Njc4OWFiY2RlZg$MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY",
    ),
    true,
  );
});

const NOW = Date.parse("2026-07-24T00:00:00.000Z");

function createHarness(
  options: {
    readonly allowedOrigins?: readonly string[];
  } = {},
): {
  readonly auth: OwnerAuth;
  readonly clock: MutableClock;
  readonly passwordHasher: FakePasswordHasher;
  readonly repository: InMemoryOwnerAuthRepository;
} {
  const clock = new MutableClock(NOW);
  const passwordHasher = new FakePasswordHasher();
  const repository = new InMemoryOwnerAuthRepository();
  const auth = new OwnerAuth({
    allowedOrigins: options.allowedOrigins ?? [
      "https://admin.example.test",
      "http://127.0.0.1:4317/",
    ],
    clock,
    passwordHasher,
    random: new DeterministicRandomSource(),
    repository,
  });

  return { auth, clock, passwordHasher, repository };
}

async function initializeOwner(
  harness: ReturnType<typeof createHarness>,
): Promise<readonly string[]> {
  const claim = await harness.auth.issueInitialClaim({ channel: "local-bootstrap" });
  const result = await harness.auth.claimOwner({
    channel: "local-bootstrap",
    claimToken: claim.claimToken,
    passphrase: "correct horse battery staple",
  });
  return result.recoveryCodes;
}

class MutableClock implements OwnerAuthClock {
  public value: number;

  public constructor(value: number) {
    this.value = value;
  }

  public now(): number {
    return this.value;
  }
}

class DeterministicRandomSource implements SecureRandomSource {
  private counter = 0;

  public bytes(length: number): Uint8Array {
    this.counter += 1;
    return createHash("sha256")
      .update(`owner-auth-test-${this.counter}`)
      .digest()
      .subarray(0, length);
  }
}

class FixedRandomSource implements SecureRandomSource {
  public bytes(length: number): Uint8Array {
    return Uint8Array.from({ length }, (_, index) => index + 1);
  }
}

class FakePasswordHasher implements PasswordHasher {
  public failHash = false;
  public hashCalls = 0;
  public onHash: (() => void) | undefined;
  public onVerify: (() => void) | undefined;

  public async hash(passphrase: string): Promise<string> {
    this.hashCalls += 1;
    this.onHash?.();
    if (this.failHash) {
      throw new Error("injected password hash failure");
    }
    return `$fake$${digest(passphrase)}`;
  }

  public async verify(encodedPhc: string, passphrase: string): Promise<boolean> {
    this.onVerify?.();
    return encodedPhc === `$fake$${digest(passphrase)}`;
  }

  public needsRehash(_encodedPhc: string): boolean {
    return false;
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isAuthError(code: OwnerAuthError["code"]): (error: unknown) => boolean {
  return (error: unknown) => error instanceof OwnerAuthError && error.code === code;
}
