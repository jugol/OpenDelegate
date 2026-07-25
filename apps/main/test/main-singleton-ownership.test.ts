import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
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
  acquireMainSingletonOwnership,
  MainSingletonOwnershipError,
  type PostgreSqlOwnershipClient,
} from "../src/main-singleton-ownership.ts";

test("SQLite singleton authority rejects a second holder and releases cleanly", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "opendelegate-main-ownership-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));

  const first = await acquireMainSingletonOwnership({
    database: { adapter: "sqlite" },
    stateDirectory,
  });
  first.assertCurrent();
  await assert.rejects(
    acquireMainSingletonOwnership({
      database: { adapter: "sqlite" },
      stateDirectory,
    }),
    isOwnershipError("MAIN_ALREADY_RUNNING"),
  );

  await first.release();
  await first.release();
  assert.throws(() => first.assertCurrent(), isOwnershipError("MAIN_OWNERSHIP_LOST"));

  const restarted = await acquireMainSingletonOwnership({
    database: { adapter: "sqlite" },
    stateDirectory,
  });
  restarted.assertCurrent();
  await restarted.release();
});

test("SQLite singleton authority is exclusive across processes and recovers after a crash", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "opendelegate-main-process-ownership-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const fixture = resolve("test-fixtures/hold-main-singleton.mjs");
  const child = spawn(process.execPath, ["--experimental-strip-types", fixture, stateDirectory], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(() => {
    child.kill();
  });
  await waitForReady(child);

  await assert.rejects(
    acquireMainSingletonOwnership({
      database: { adapter: "sqlite" },
      stateDirectory,
    }),
    isOwnershipError("MAIN_ALREADY_RUNNING"),
  );

  assert.equal(child.kill(), true);
  const [exitCode, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  assert.equal(exitCode !== 0 || signal !== null, true);

  const restarted = await acquireMainSingletonOwnership({
    database: { adapter: "sqlite" },
    stateDirectory,
  });
  await restarted.release();
});

test("PostgreSQL singleton authority uses one session lock and rejects an existing holder", async () => {
  const client = new FakePostgreSqlOwnershipClient({ acquired: false });
  await assert.rejects(
    acquireMainSingletonOwnership(
      {
        database: {
          adapter: "postgresql",
          uriRef: "secret://main/database-primary",
          schema: "opendelegate",
        },
        stateDirectory: resolve("."),
        secretStore: managedPostgresSecretStore(),
      },
      {
        postgresClientFactory: () => client,
        postgresHeartbeatIntervalMs: 60_000,
      },
    ),
    isOwnershipError("MAIN_ALREADY_RUNNING"),
  );
  assert.equal(client.connectCalls, 1);
  assert.equal(client.endCalls, 1);
  assert.equal(
    client.queries.some((query) => query.includes("pg_try_advisory_lock")),
    true,
  );
  assert.equal(
    client.queries.some((query) => query.includes("pg_advisory_unlock")),
    false,
  );
});

test("PostgreSQL session loss fails ownership closed and clean release unlocks once", async () => {
  const client = new FakePostgreSqlOwnershipClient({ acquired: true });
  const ownership = await acquireMainSingletonOwnership(
    {
      database: {
        adapter: "postgresql",
        uriRef: "secret://main/database-primary",
        schema: "opendelegate",
      },
      stateDirectory: resolve("."),
      secretStore: managedPostgresSecretStore(),
    },
    {
      postgresClientFactory: () => client,
      postgresHeartbeatIntervalMs: 60_000,
    },
  );
  const loss = deferred<MainSingletonOwnershipError>();
  ownership.onLost((error) => loss.resolve(error));
  client.emit("error", new Error("connection reset"));
  const lost = await loss.promise;
  assert.equal(lost.code, "MAIN_OWNERSHIP_LOST");
  assert.throws(() => ownership.assertCurrent(), isOwnershipError("MAIN_OWNERSHIP_LOST"));
  await ownership.release();
  assert.equal(client.endCalls, 1);
  assert.equal(
    client.queries.some((query) => query.includes("pg_advisory_unlock")),
    false,
  );

  const cleanClient = new FakePostgreSqlOwnershipClient({ acquired: true });
  const clean = await acquireMainSingletonOwnership(
    {
      database: {
        adapter: "postgresql",
        uriRef: "secret://main/database-primary",
      },
      stateDirectory: resolve("."),
      secretStore: managedPostgresSecretStore(),
    },
    {
      postgresClientFactory: () => cleanClient,
      postgresHeartbeatIntervalMs: 60_000,
    },
  );
  clean.assertCurrent();
  await clean.release();
  await clean.release();
  assert.equal(cleanClient.endCalls, 1);
  assert.equal(
    cleanClient.queries.filter((query) => query.includes("pg_advisory_unlock")).length,
    1,
  );
});

class FakePostgreSqlOwnershipClient extends EventEmitter implements PostgreSqlOwnershipClient {
  readonly #acquired: boolean;
  public readonly queries: string[] = [];
  public connectCalls = 0;
  public endCalls = 0;

  public constructor(input: { readonly acquired: boolean }) {
    super();
    this.#acquired = input.acquired;
  }

  public async connect(): Promise<void> {
    this.connectCalls += 1;
  }

  public async query(
    text: string,
    _values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Readonly<Record<string, unknown>>[] }> {
    this.queries.push(text);
    if (text.includes("pg_try_advisory_lock")) {
      return { rows: [{ acquired: this.#acquired }] };
    }
    if (text.includes("pg_advisory_unlock")) {
      return { rows: [{ released: true }] };
    }
    return { rows: [{ alive: true }] };
  }

  public async end(): Promise<void> {
    this.endCalls += 1;
  }

  public override on(event: "error", listener: (error: Error) => void): this;
  public override on(event: "end", listener: () => void): this;
  public override on(
    event: "error" | "end",
    listener: ((error: Error) => void) | (() => void),
  ): this {
    return super.on(event, listener);
  }

  public override off(event: "error", listener: (error: Error) => void): this;
  public override off(event: "end", listener: () => void): this;
  public override off(
    event: "error" | "end",
    listener: ((error: Error) => void) | (() => void),
  ): this {
    return super.off(event, listener);
  }
}

function managedPostgresSecretStore(): ManagedSecretStore {
  const bytes = Buffer.from("postgresql://owner:password@database.example.test/opendelegate");
  return {
    backend: "linux-systemd-credential-vault",
    deviceId: "device_main",
    async health(): Promise<ManagedSecretStoreHealth> {
      return {
        backend: "linux-systemd-credential-vault",
        deviceId: "device_main",
        status: "ready",
      };
    },
    async availability(alias: string): Promise<SecretAvailability> {
      return { alias, ready: true };
    },
    async store(): Promise<ManagedSecretMutation> {
      return { status: "stored" };
    },
    async rotate(): Promise<ManagedSecretMutation> {
      return { status: "rotated" };
    },
    async delete(): Promise<ManagedSecretDeletion> {
      return { status: "deleted" };
    },
    async executeWithSecretBytes(
      _alias: string,
      executor: (value: Uint8Array) => unknown | Promise<unknown>,
    ): Promise<void> {
      const copy = Buffer.from(bytes);
      try {
        await executor(copy);
      } finally {
        copy.fill(0);
      }
    },
  };
}

async function waitForReady(child: ReturnType<typeof spawn>): Promise<void> {
  const ready = deferred<void>();
  let stdout = "";
  let stderr = "";
  const timeout = setTimeout(() => {
    ready.reject(new Error(`Timed out waiting for fixture. stderr=${stderr}`));
  }, 10_000);
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
    if (stdout.includes("ready\n")) {
      ready.resolve();
    }
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.once("exit", (code) => {
    if (!stdout.includes("ready\n")) {
      ready.reject(
        new Error(`Fixture exited before readiness (${String(code)}). stderr=${stderr}`),
      );
    }
  });
  try {
    await ready.promise;
  } finally {
    clearTimeout(timeout);
  }
}

function isOwnershipError(code: MainSingletonOwnershipError["code"]) {
  return (error: unknown): boolean =>
    error instanceof MainSingletonOwnershipError && error.code === code;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}
