import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemorySecretStore,
  SecretError,
  SecretLeaseBroker,
  SecretRedactor,
  type Clock,
  type SecretLeaseIdSource,
  type SecretStore,
} from "../src/index.ts";

class MutableClock implements Clock {
  public value: number;

  public constructor(value: number) {
    this.value = value;
  }

  public now(): number {
    return this.value;
  }
}

class DeterministicLeaseIds implements SecretLeaseIdSource {
  readonly #ids = ["opaque-lease-001", "opaque-lease-002"];

  public nextLeaseId(): string {
    const id = this.#ids.shift();

    if (id === undefined) {
      throw new Error("No deterministic lease ID remains.");
    }

    return id;
  }
}

const secretValue = "super-secret-device-token";

function createBroker(clock = new MutableClock(1_000)) {
  const store = new InMemorySecretStore({
    deviceId: "device-main",
    secrets: {
      "github-token": secretValue,
      "artifact-key": "artifact-secret-value",
    },
  });
  const broker = new SecretLeaseBroker({
    deviceId: "device-main",
    store,
    clock,
    ids: new DeterministicLeaseIds(),
  });

  return { broker, store, clock };
}

test("exposes alias readiness and confines a single-use Secret to its executor callback", async () => {
  const { broker, store } = createBroker();

  assert.deepEqual(broker.health(), {
    status: "ready",
    deviceId: "device-main",
    aliases: [
      { alias: "artifact-key", ready: true },
      { alias: "github-token", ready: true },
    ],
  });
  assert.deepEqual(broker.availability("missing-alias"), {
    alias: "missing-alias",
    ready: false,
  });

  const lease = broker.issueLease({
    deviceId: "device-main",
    consumerId: "worker-agent",
    runId: "run-001",
    secretAlias: "github-token",
    ttlMs: 500,
  });

  assert.deepEqual(lease, {
    leaseId: "opaque-lease-001",
    expiresAt: 1_500,
  });
  assert.equal(JSON.stringify(lease).includes("github-token"), false);

  let observedInsideCallback: string | undefined;
  const receipt = await broker.executeWithLease(
    {
      leaseId: lease.leaseId,
      deviceId: "device-main",
      consumerId: "worker-agent",
      runId: "run-001",
    },
    (value) => {
      observedInsideCallback = value;
      return value;
    },
  );

  assert.equal(observedInsideCallback, secretValue);
  assert.deepEqual(receipt, { status: "executed" });
  assert.equal(JSON.stringify(receipt).includes(secretValue), false);
  assert.equal(JSON.stringify(store).includes(secretValue), false);
  assert.equal(JSON.stringify(broker).includes(secretValue), false);

  await assert.rejects(
    broker.executeWithLease(
      {
        leaseId: lease.leaseId,
        deviceId: "device-main",
        consumerId: "worker-agent",
        runId: "run-001",
      },
      () => undefined,
    ),
    (error: unknown) => {
      assert.ok(error instanceof SecretError);
      assert.equal(error.code, "SECRET_LEASE_REPLAYED");
      return true;
    },
  );
});

test("expires leases at the injected-clock boundary and honors revocation", async () => {
  const { broker, clock } = createBroker();
  const expiredLease = broker.issueLease({
    deviceId: "device-main",
    consumerId: "worker-agent",
    runId: "run-expired",
    secretAlias: "github-token",
    ttlMs: 100,
  });
  clock.value = expiredLease.expiresAt;
  let callbackCalls = 0;

  await assert.rejects(
    broker.executeWithLease(
      {
        leaseId: expiredLease.leaseId,
        deviceId: "device-main",
        consumerId: "worker-agent",
        runId: "run-expired",
      },
      () => {
        callbackCalls += 1;
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof SecretError);
      assert.equal(error.code, "SECRET_LEASE_EXPIRED");
      return true;
    },
  );

  clock.value = 2_000;
  const revokedLease = broker.issueLease({
    deviceId: "device-main",
    consumerId: "worker-agent",
    runId: "run-revoked",
    secretAlias: "artifact-key",
    ttlMs: 100,
  });
  assert.deepEqual(broker.revokeLease(revokedLease.leaseId), {
    status: "revoked",
  });

  await assert.rejects(
    broker.executeWithLease(
      {
        leaseId: revokedLease.leaseId,
        deviceId: "device-main",
        consumerId: "worker-agent",
        runId: "run-revoked",
      },
      () => {
        callbackCalls += 1;
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof SecretError);
      assert.equal(error.code, "SECRET_LEASE_REVOKED");
      return true;
    },
  );
  assert.equal(callbackCalls, 0);
});

test("rejects wrong Device, consumer, and Run scopes without consuming the lease", async () => {
  const { broker } = createBroker();
  const lease = broker.issueLease({
    deviceId: "device-main",
    consumerId: "worker-agent",
    runId: "run-scoped",
    secretAlias: "github-token",
    ttlMs: 500,
  });
  const mismatches = [
    {
      request: {
        leaseId: lease.leaseId,
        deviceId: "device-other",
        consumerId: "worker-agent",
        runId: "run-scoped",
      },
      code: "SECRET_LEASE_DEVICE_MISMATCH",
    },
    {
      request: {
        leaseId: lease.leaseId,
        deviceId: "device-main",
        consumerId: "other-consumer",
        runId: "run-scoped",
      },
      code: "SECRET_LEASE_CONSUMER_MISMATCH",
    },
    {
      request: {
        leaseId: lease.leaseId,
        deviceId: "device-main",
        consumerId: "worker-agent",
        runId: "run-other",
      },
      code: "SECRET_LEASE_RUN_MISMATCH",
    },
  ] as const;
  let callbackCalls = 0;

  for (const mismatch of mismatches) {
    await assert.rejects(
      broker.executeWithLease(mismatch.request, () => {
        callbackCalls += 1;
      }),
      (error: unknown) => {
        assert.ok(error instanceof SecretError);
        assert.equal(error.code, mismatch.code);
        return true;
      },
    );
  }

  await broker.executeWithLease(
    {
      leaseId: lease.leaseId,
      deviceId: "device-main",
      consumerId: "worker-agent",
      runId: "run-scoped",
    },
    () => {
      callbackCalls += 1;
    },
  );
  assert.equal(callbackCalls, 1);

  assert.throws(
    () =>
      broker.issueLease({
        deviceId: "device-other",
        consumerId: "worker-agent",
        runId: "run-cross-device",
        secretAlias: "github-token",
        ttlMs: 500,
      }),
    (error: unknown) => {
      assert.ok(error instanceof SecretError);
      assert.equal(error.code, "SECRET_LEASE_DEVICE_MISMATCH");
      return true;
    },
  );
});

test("health and availability expose only immutable alias readiness metadata", () => {
  const { broker } = createBroker();
  const health = broker.health();

  assert.deepEqual(Object.keys(health), ["status", "deviceId", "aliases"]);
  assert.equal(Object.isFrozen(health), true);
  assert.equal(Object.isFrozen(health.aliases), true);
  assert.equal(Object.isFrozen(health.aliases[0]), true);

  const serialized = JSON.stringify({
    health,
    availability: broker.availability("github-token"),
  });
  assert.equal(serialized.includes(secretValue), false);
  assert.equal(serialized.includes("artifact-secret-value"), false);
  assert.equal(serialized.includes("secrets"), false);
  assert.equal(serialized.includes("value"), false);
});

test("sanitizes executor failures, discards callback output, and consumes the lease even on throw", async () => {
  const { broker } = createBroker();
  const lease = broker.issueLease({
    deviceId: "device-main",
    consumerId: "worker-agent",
    runId: "run-throwing",
    secretAlias: "github-token",
    ttlMs: 500,
  });

  await assert.rejects(
    broker.executeWithLease(
      {
        leaseId: lease.leaseId,
        deviceId: "device-main",
        consumerId: "worker-agent",
        runId: "run-throwing",
      },
      (value) => {
        throw new Error(`Executor leaked ${value}`);
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof SecretError);
      assert.equal(error.code, "SECRET_EXECUTOR_FAILED");
      assert.equal(error.message.includes(secretValue), false);
      assert.equal(error.stack?.includes(secretValue), false);
      assert.equal(JSON.stringify(error).includes(secretValue), false);
      return true;
    },
  );

  await assert.rejects(
    broker.executeWithLease(
      {
        leaseId: lease.leaseId,
        deviceId: "device-main",
        consumerId: "worker-agent",
        runId: "run-throwing",
      },
      () => undefined,
    ),
    (error: unknown) => {
      assert.ok(error instanceof SecretError);
      assert.equal(error.code, "SECRET_LEASE_REPLAYED");
      return true;
    },
  );
});

test("a buggy Secret Store cannot invoke a lease executor more than once", async () => {
  const store: SecretStore = {
    deviceId: "device-main",
    health: () => ({
      status: "ready",
      deviceId: "device-main",
      aliases: [{ alias: "github-token", ready: true }],
    }),
    availability: (alias) => ({ alias, ready: true }),
    executeWithSecret: async (_alias, executor) => {
      await Promise.all([executor(secretValue), executor(secretValue)]);
    },
  };
  const broker = new SecretLeaseBroker({
    deviceId: "device-main",
    store,
    clock: new MutableClock(1_000),
    ids: new DeterministicLeaseIds(),
  });
  const lease = broker.issueLease({
    deviceId: "device-main",
    consumerId: "worker-agent",
    runId: "run-malicious-store",
    secretAlias: "github-token",
    ttlMs: 500,
  });
  let executorCalls = 0;

  await assert.rejects(
    broker.executeWithLease(
      {
        leaseId: lease.leaseId,
        deviceId: "device-main",
        consumerId: "worker-agent",
        runId: "run-malicious-store",
      },
      () => {
        executorCalls += 1;
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof SecretError);
      assert.equal(error.code, "SECRET_STORE_ACCESS_FAILED");
      assert.equal(error.message.includes(secretValue), false);
      assert.equal(error.stack?.includes(secretValue), false);
      return true;
    },
  );
  assert.equal(executorCalls, 1);

  await assert.rejects(
    broker.executeWithLease(
      {
        leaseId: lease.leaseId,
        deviceId: "device-main",
        consumerId: "worker-agent",
        runId: "run-malicious-store",
      },
      () => {
        executorCalls += 1;
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof SecretError);
      assert.equal(error.code, "SECRET_LEASE_REPLAYED");
      return true;
    },
  );
  assert.equal(executorCalls, 1);
});

test("redacts registered values and sensitive keys across adversarial nested and circular diagnostics", () => {
  const artifactValue = "artifact-secret-value";
  const redactor = new SecretRedactor([secretValue, artifactValue]);
  let getterCalls = 0;
  const payload: Record<string, unknown> = {
    password: "plain-password-value",
    safe: "visible",
    message: `prefix ${secretValue} suffix`,
    array: [
      secretValue,
      {
        authorization: "Bearer unregistered-sensitive-token",
      },
    ],
    map: new Map<string, unknown>([
      ["safe", artifactValue],
      ["apiKey", "unregistered-api-key"],
    ]),
    set: new Set([artifactValue, "visible-set-value"]),
    error: new Error(`Provider failed with ${secretValue}`),
    binary: Buffer.from(secretValue),
    count: 9n,
    [`key-${artifactValue}`]: "safe-key-value",
  };
  Object.defineProperty(payload, "secretGetter", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error(`getter leaked ${secretValue}`);
    },
  });
  payload.self = payload;

  const redacted = redactor.redact(payload);
  const serialized = JSON.stringify(redacted);

  assert.equal(getterCalls, 0);
  for (const forbidden of [
    secretValue,
    artifactValue,
    "plain-password-value",
    "unregistered-sensitive-token",
    "unregistered-api-key",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.ok(serialized.includes("[REDACTED]"));
  assert.ok(serialized.includes("[Circular]"));
  assert.ok(serialized.includes("[Binary data redacted]"));
  assert.ok(serialized.includes("visible"));
  assert.equal(Object.isFrozen(redacted), true);
});

test("rejects invalid lease lifetimes, clocks, and overflowing expirations before issuing a lease", () => {
  const invalidTtls = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY];

  for (const ttlMs of invalidTtls) {
    const { broker } = createBroker();
    assert.throws(
      () =>
        broker.issueLease({
          deviceId: "device-main",
          consumerId: "worker-agent",
          runId: "run-invalid-ttl",
          secretAlias: "github-token",
          ttlMs,
        }),
      (error: unknown) => {
        assert.ok(error instanceof SecretError);
        assert.equal(error.code, "SECRET_LEASE_TTL_INVALID");
        return true;
      },
    );
  }

  for (const clockValue of [
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    const { broker } = createBroker(new MutableClock(clockValue));
    assert.throws(
      () =>
        broker.issueLease({
          deviceId: "device-main",
          consumerId: "worker-agent",
          runId: "run-invalid-clock",
          secretAlias: "github-token",
          ttlMs: 100,
        }),
      (error: unknown) => {
        assert.ok(error instanceof SecretError);
        assert.equal(error.code, "SECRET_CLOCK_INVALID");
        return true;
      },
    );
  }

  const { broker } = createBroker(new MutableClock(Number.MAX_SAFE_INTEGER - 5));
  assert.throws(
    () =>
      broker.issueLease({
        deviceId: "device-main",
        consumerId: "worker-agent",
        runId: "run-overflow",
        secretAlias: "github-token",
        ttlMs: 10,
      }),
    (error: unknown) => {
      assert.ok(error instanceof SecretError);
      assert.equal(error.code, "SECRET_LEASE_EXPIRY_INVALID");
      return true;
    },
  );
});

test("rejects blank, untrimmed, controlled, or oversized lease identifiers", async () => {
  const invalidIdentifiers = ["", " ", " leading", "trailing ", "line\nbreak", "x".repeat(257)];

  for (const identifier of invalidIdentifiers) {
    const { broker } = createBroker();
    assert.throws(
      () =>
        broker.issueLease({
          deviceId: "device-main",
          consumerId: identifier,
          runId: "run-identifier",
          secretAlias: "github-token",
          ttlMs: 100,
        }),
      (error: unknown) => {
        assert.ok(error instanceof SecretError);
        assert.equal(error.code, "SECRET_IDENTIFIER_INVALID");
        return true;
      },
    );
  }

  const { broker } = createBroker();
  const lease = broker.issueLease({
    deviceId: "device-main",
    consumerId: "worker-agent",
    runId: "run-valid",
    secretAlias: "github-token",
    ttlMs: 100,
  });
  let callbackCalls = 0;

  await assert.rejects(
    broker.executeWithLease(
      {
        leaseId: lease.leaseId,
        deviceId: "device-main",
        consumerId: " worker-agent",
        runId: "run-valid",
      },
      () => {
        callbackCalls += 1;
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof SecretError);
      assert.equal(error.code, "SECRET_IDENTIFIER_INVALID");
      return true;
    },
  );

  await broker.executeWithLease(
    {
      leaseId: lease.leaseId,
      deviceId: "device-main",
      consumerId: "worker-agent",
      runId: "run-valid",
    },
    () => {
      callbackCalls += 1;
    },
  );
  assert.equal(callbackCalls, 1);
});

test("an invalid execution clock neither consumes the lease nor invokes Secret access", async () => {
  const clock = new MutableClock(1_000);
  const { broker } = createBroker(clock);
  const lease = broker.issueLease({
    deviceId: "device-main",
    consumerId: "worker-agent",
    runId: "run-clock-retry",
    secretAlias: "github-token",
    ttlMs: 500,
  });
  let callbackCalls = 0;
  clock.value = Number.NaN;

  await assert.rejects(
    broker.executeWithLease(
      {
        leaseId: lease.leaseId,
        deviceId: "device-main",
        consumerId: "worker-agent",
        runId: "run-clock-retry",
      },
      () => {
        callbackCalls += 1;
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof SecretError);
      assert.equal(error.code, "SECRET_CLOCK_INVALID");
      return true;
    },
  );
  assert.equal(callbackCalls, 0);

  clock.value = 1_100;
  await broker.executeWithLease(
    {
      leaseId: lease.leaseId,
      deviceId: "device-main",
      consumerId: "worker-agent",
      runId: "run-clock-retry",
    },
    () => {
      callbackCalls += 1;
    },
  );
  assert.equal(callbackCalls, 1);
});

test("rejects an invalid generated lease identifier without storing it", () => {
  const store = new InMemorySecretStore({
    deviceId: "device-main",
    secrets: { "github-token": secretValue },
  });
  const ids = [" ", "lease-valid"];
  const broker = new SecretLeaseBroker({
    deviceId: "device-main",
    store,
    clock: new MutableClock(1_000),
    ids: {
      nextLeaseId: () => ids.shift() ?? "lease-fallback",
    },
  });

  assert.throws(
    () =>
      broker.issueLease({
        deviceId: "device-main",
        consumerId: "worker-agent",
        runId: "run-one",
        secretAlias: "github-token",
        ttlMs: 100,
      }),
    (error: unknown) => {
      assert.ok(error instanceof SecretError);
      assert.equal(error.code, "SECRET_IDENTIFIER_INVALID");
      return true;
    },
  );

  assert.deepEqual(
    broker.issueLease({
      deviceId: "device-main",
      consumerId: "worker-agent",
      runId: "run-two",
      secretAlias: "github-token",
      ttlMs: 100,
    }),
    { leaseId: "lease-valid", expiresAt: 1_100 },
  );
});

test("rejects invalid Secret Store metadata and alias lookup identifiers", () => {
  assert.throws(
    () =>
      new InMemorySecretStore({
        deviceId: " ",
        secrets: { "github-token": secretValue },
      }),
    (error: unknown) => {
      assert.ok(error instanceof SecretError);
      assert.equal(error.code, "SECRET_IDENTIFIER_INVALID");
      return true;
    },
  );
  assert.throws(
    () =>
      new InMemorySecretStore({
        deviceId: "device-main",
        secrets: { "bad\nalias": secretValue },
      }),
    (error: unknown) => {
      assert.ok(error instanceof SecretError);
      assert.equal(error.code, "SECRET_IDENTIFIER_INVALID");
      return true;
    },
  );

  const { broker } = createBroker();
  assert.throws(
    () => broker.availability(" "),
    (error: unknown) => {
      assert.ok(error instanceof SecretError);
      assert.equal(error.code, "SECRET_IDENTIFIER_INVALID");
      return true;
    },
  );
});

test("snapshots immutable Secret Store metadata without leaking implementation fields", () => {
  const aliases = [{ alias: "github-token", ready: true }];
  const store: SecretStore = {
    deviceId: "device-main",
    health: () =>
      ({
        status: "ready",
        deviceId: "device-main",
        aliases,
        leakedValue: secretValue,
      }) as ReturnType<SecretStore["health"]>,
    availability: (alias) =>
      ({
        alias,
        ready: true,
        leakedValue: secretValue,
      }) as ReturnType<SecretStore["availability"]>,
    executeWithSecret: async (_alias, executor) => {
      await executor(secretValue);
    },
  };
  const broker = new SecretLeaseBroker({
    deviceId: "device-main",
    store,
    clock: new MutableClock(1_000),
    ids: new DeterministicLeaseIds(),
  });

  const health = broker.health();
  const availability = broker.availability("github-token");
  aliases[0]!.ready = false;

  assert.deepEqual(health, {
    status: "ready",
    deviceId: "device-main",
    aliases: [{ alias: "github-token", ready: true }],
  });
  assert.deepEqual(availability, { alias: "github-token", ready: true });
  assert.equal(Object.isFrozen(health), true);
  assert.equal(Object.isFrozen(health.aliases), true);
  assert.equal(Object.isFrozen(health.aliases[0]), true);
  assert.equal(Object.isFrozen(availability), true);
  assert.equal(JSON.stringify({ health, availability }).includes(secretValue), false);
});
