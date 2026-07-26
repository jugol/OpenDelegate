import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  ManagedSecretDeletion,
  ManagedSecretMutation,
  ManagedSecretStore,
  ManagedSecretStoreHealth,
  SecretAvailability,
} from "@opendelegate/secrets";

import {
  MainSecureSecretIngestService,
  createDefaultMainManagedSecretStore,
} from "../src/secure-secret-ingest.ts";

class TestManagedSecretStore implements ManagedSecretStore {
  public readonly backend = "windows-dpapi" as const;
  public readonly deviceId = "device_main";
  public readonly values = new Map<string, Buffer>();
  public readonly observedStoreInputs: Uint8Array[] = [];
  public onStore: (() => void | Promise<void>) | undefined;

  public async health(): Promise<ManagedSecretStoreHealth> {
    return {
      backend: this.backend,
      deviceId: this.deviceId,
      status: "ready",
    };
  }

  public async availability(alias: string): Promise<SecretAvailability> {
    return { alias, ready: this.values.has(alias) };
  }

  public async store(alias: string, value: Uint8Array): Promise<ManagedSecretMutation> {
    if (this.values.has(alias)) {
      throw new Error("alias conflict");
    }
    this.observedStoreInputs.push(value);
    this.values.set(alias, Buffer.from(value));
    await this.onStore?.();
    return { status: "stored" };
  }

  public async rotate(alias: string, value: Uint8Array): Promise<ManagedSecretMutation> {
    if (!this.values.has(alias)) {
      throw new Error("alias unavailable");
    }
    this.values.set(alias, Buffer.from(value));
    return { status: "rotated" };
  }

  public async delete(alias: string): Promise<ManagedSecretDeletion> {
    return { status: this.values.delete(alias) ? "deleted" : "absent" };
  }

  public async executeWithSecretBytes(
    alias: string,
    executor: (value: Uint8Array) => unknown | Promise<unknown>,
  ): Promise<void> {
    const stored = this.values.get(alias);
    if (stored === undefined) {
      throw new Error("alias unavailable");
    }
    const copy = Buffer.from(stored);
    try {
      await executor(copy);
    } finally {
      copy.fill(0);
    }
  }
}

test("secure ingest stores only bytes in the Main-local store and replays an availability receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-secure-ingest-"));
  const store = new TestManagedSecretStore();
  let sequence = 0;
  try {
    const service = await MainSecureSecretIngestService.open({
      mainDeviceId: "device_main",
      ledgerDirectory: join(root, "ledger"),
      secretStore: store,
      idSource: () => `database_${++sequence}`,
    });
    const raw = Buffer.from(
      "postgresql://owner:local-only-password@database.test/opendelegate",
      "utf8",
    );
    const first = await service.ingest({
      principalId: "owner_personal",
      idempotencyKey: "database-uri-1",
      purpose: "database-uri",
      secret: raw,
    });
    assert.deepEqual(first, {
      schemaVersion: 1,
      secretRef: "secret://main/database_1",
      availability: "ready",
    });
    assert.equal(store.values.size, 1);
    assert.ok(store.observedStoreInputs[0]?.every((byte) => byte === 0));
    assert.equal(
      service.isAvailable({
        key: "database.uri-ref",
        locality: "main",
        scope: { kind: "main", id: "device_main" },
        secretRef: first.secretRef,
      }),
      true,
    );
    assert.equal(
      service.isAvailable({
        key: "database.uri-ref",
        locality: "main",
        scope: { kind: "main", id: "device_other" },
        secretRef: first.secretRef,
      }),
      false,
    );

    const replay = await service.ingest({
      principalId: "owner_personal",
      idempotencyKey: "database-uri-1",
      purpose: "database-uri",
      secret: raw,
    });
    assert.deepEqual(replay, first);
    assert.equal(store.values.size, 1);

    const files = await readdir(join(root, "ledger"));
    assert.equal(files.length, 1);
    const ledger = await readFile(join(root, "ledger", files[0]!), "utf8");
    assert.equal(ledger.includes("local-only-password"), false);
    assert.equal(ledger.includes(raw.toString("base64")), false);

    const restarted = await MainSecureSecretIngestService.open({
      mainDeviceId: "device_main",
      ledgerDirectory: join(root, "ledger"),
      secretStore: store,
    });
    assert.equal(
      restarted.isAvailable({
        key: "database.uri-ref",
        locality: "main",
        scope: { kind: "main", id: "device_main" },
        secretRef: first.secretRef,
      }),
      true,
    );
    raw.fill(0);
  } finally {
    for (const value of store.values.values()) {
      value.fill(0);
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("secure ingest rejects idempotency conflicts, invalid purpose material, and oversized input", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-secure-ingest-reject-"));
  const store = new TestManagedSecretStore();
  try {
    const service = await MainSecureSecretIngestService.open({
      mainDeviceId: "device_main",
      ledgerDirectory: join(root, "ledger"),
      secretStore: store,
      idSource: () => "database_conflict",
    });
    await service.ingest({
      principalId: "owner_personal",
      idempotencyKey: "database-uri-conflict",
      purpose: "database-uri",
      secret: Buffer.from("postgresql://owner:first@database.test/main", "utf8"),
    });
    await assert.rejects(
      service.ingest({
        principalId: "owner_personal",
        idempotencyKey: "database-uri-conflict",
        purpose: "database-uri",
        secret: Buffer.from("postgresql://owner:second@database.test/main", "utf8"),
      }),
      { code: "SECRET_INGEST_IDEMPOTENCY_CONFLICT" },
    );
    await assert.rejects(
      service.ingest({
        principalId: "owner_personal",
        idempotencyKey: "invalid-database-uri",
        purpose: "database-uri",
        secret: Buffer.from("not a database URI", "utf8"),
      }),
      { code: "SECRET_INGEST_INVALID" },
    );
    await assert.rejects(
      service.ingest({
        principalId: "owner_personal",
        idempotencyKey: "oversized-api-token",
        purpose: "api-token",
        secret: Buffer.alloc(16 * 1024 + 1, 0x61),
      }),
      { code: "SECRET_INGEST_INVALID" },
    );
  } finally {
    for (const value of store.values.values()) {
      value.fill(0);
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("secure ingest recovers a crash between atomic publication and temporary-link cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-secure-ingest-crash-"));
  const ledgerDirectory = join(root, "ledger");
  const store = new TestManagedSecretStore();
  const principalId = "owner_personal";
  const idempotencyKey = "crash-recovery";
  const operationId = createHash("sha256")
    .update(`${principalId}\0${idempotencyKey}`, "utf8")
    .digest("hex");
  const finalPath = join(ledgerDirectory, `${operationId}.json`);
  const temporaryPath = join(ledgerDirectory, `${operationId}.${"a".repeat(32)}.create.tmp`);
  try {
    await mkdir(ledgerDirectory, { mode: 0o700 });
    const service = await (async () => {
      const pendingHandle = await open(finalPath, "wx+", 0o600);
      try {
        await pendingHandle.writeFile(
          `${JSON.stringify({
            schemaVersion: 1,
            state: "pending",
            purpose: "database-uri",
            secretRef: "secret://main/crash_recovery",
          })}\n`,
          "utf8",
        );
        await pendingHandle.sync();
        await link(finalPath, temporaryPath);
        assert.equal((await pendingHandle.stat()).nlink, 2);

        const opened = await MainSecureSecretIngestService.open({
          mainDeviceId: "device_main",
          ledgerDirectory,
          secretStore: store,
        });
        assert.equal((await pendingHandle.stat()).nlink, 1);
        await assert.rejects(lstat(temporaryPath), { code: "ENOENT" });
        return opened;
      } finally {
        await pendingHandle.close();
      }
    })();

    const receipt = await service.ingest({
      principalId,
      idempotencyKey,
      purpose: "database-uri",
      secret: Buffer.from("postgresql://owner:recovered@database.test/main"),
    });
    assert.equal(receipt.secretRef, "secret://main/crash_recovery");
    const restarted = await MainSecureSecretIngestService.open({
      mainDeviceId: "device_main",
      ledgerDirectory,
      secretStore: store,
    });
    const replay = await restarted.ingest({
      principalId,
      idempotencyKey,
      purpose: "database-uri",
      secret: Buffer.from("postgresql://owner:recovered@database.test/main"),
    });
    assert.deepEqual(replay, receipt);
    assert.equal(store.observedStoreInputs.length, 1);
  } finally {
    for (const value of store.values.values()) {
      value.fill(0);
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("secure ingest rejects linked ledger roots, linked records, and path replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-secure-ingest-links-"));
  const actualLedger = join(root, "actual-ledger");
  const linkedLedger = join(root, "linked-ledger");
  const store = new TestManagedSecretStore();
  try {
    await mkdir(actualLedger, { mode: 0o700 });
    await symlink(actualLedger, linkedLedger, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
      MainSecureSecretIngestService.open({
        mainDeviceId: "device_main",
        ledgerDirectory: linkedLedger,
        secretStore: store,
      }),
      { code: "SECRET_INGEST_UNAVAILABLE" },
    );

    const service = await MainSecureSecretIngestService.open({
      mainDeviceId: "device_main",
      ledgerDirectory: actualLedger,
      secretStore: store,
      idSource: () => "path_replacement",
    });
    const operationId = createHash("sha256")
      .update("owner_personal\0replace-path", "utf8")
      .digest("hex");
    const finalPath = join(actualLedger, `${operationId}.json`);
    const attackerPath = join(root, "attacker.json");
    await writeFile(
      attackerPath,
      `${JSON.stringify({
        schemaVersion: 1,
        state: "pending",
        purpose: "database-uri",
        secretRef: "secret://main/path_replacement",
      })}\n`,
      { mode: 0o600 },
    );
    store.onStore = async () => {
      await unlink(finalPath);
      await link(attackerPath, finalPath);
    };
    await assert.rejects(
      service.ingest({
        principalId: "owner_personal",
        idempotencyKey: "replace-path",
        purpose: "database-uri",
        secret: Buffer.from("postgresql://owner:linked@database.test/main"),
      }),
      { code: "SECRET_INGEST_UNAVAILABLE" },
    );
    store.onStore = undefined;

    const cleanRoot = join(root, "hard-link-ledger");
    const cleanStore = new TestManagedSecretStore();
    const cleanService = await MainSecureSecretIngestService.open({
      mainDeviceId: "device_main",
      ledgerDirectory: cleanRoot,
      secretStore: cleanStore,
      idSource: () => "hard_link",
    });
    await cleanService.ingest({
      principalId: "owner_personal",
      idempotencyKey: "hard-link",
      purpose: "api-token",
      secret: Buffer.from("SyntheticToken_A1B2C3D4E5F6"),
    });
    const [recordName] = await readdir(cleanRoot);
    assert.ok(recordName);
    await link(join(cleanRoot, recordName), join(cleanRoot, `${"b".repeat(64)}.json`));
    await assert.rejects(
      MainSecureSecretIngestService.open({
        mainDeviceId: "device_main",
        ledgerDirectory: cleanRoot,
        secretStore: cleanStore,
      }),
      { code: "SECRET_INGEST_UNAVAILABLE" },
    );
    for (const value of cleanStore.values.values()) {
      value.fill(0);
    }
  } finally {
    for (const value of store.values.values()) {
      value.fill(0);
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("secure ingest enforces ledger capacity across concurrent operation IDs and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-secure-ingest-capacity-"));
  const ledgerDirectory = join(root, "ledger");
  const store = new TestManagedSecretStore();
  let sequence = 0;
  try {
    const service = await MainSecureSecretIngestService.open({
      mainDeviceId: "device_main",
      ledgerDirectory,
      secretStore: store,
      maximumLedgerEntries: 2,
      idSource: () => `capacity_${++sequence}`,
    });
    const results = await Promise.allSettled(
      ["one", "two", "three"].map((idempotencyKey) =>
        service.ingest({
          principalId: "owner_personal",
          idempotencyKey,
          purpose: "api-token",
          secret: Buffer.from(`SyntheticToken_${idempotencyKey}_A1B2C3`),
        }),
      ),
    );
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
    const rejected = results.find((result) => result.status === "rejected");
    assert.equal(
      rejected?.status === "rejected" ? rejected.reason.code : undefined,
      "SECRET_INGEST_UNAVAILABLE",
    );
    assert.equal((await readdir(ledgerDirectory)).length, 2);

    const restarted = await MainSecureSecretIngestService.open({
      mainDeviceId: "device_main",
      ledgerDirectory,
      secretStore: store,
      maximumLedgerEntries: 2,
    });
    await assert.rejects(
      restarted.ingest({
        principalId: "owner_personal",
        idempotencyKey: "four",
        purpose: "api-token",
        secret: Buffer.from("SyntheticToken_four_A1B2C3"),
      }),
      { code: "SECRET_INGEST_UNAVAILABLE" },
    );
  } finally {
    for (const value of store.values.values()) {
      value.fill(0);
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("secure ingest rejects permissive ledger roots and does not default headless Linux to Secret Service", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-secure-ingest-mode-"));
  const ledgerDirectory = join(root, "ledger");
  const store = new TestManagedSecretStore();
  try {
    if (process.platform !== "win32") {
      await mkdir(ledgerDirectory, { mode: 0o700 });
      await chmod(ledgerDirectory, 0o755);
      await assert.rejects(
        MainSecureSecretIngestService.open({
          mainDeviceId: "device_main",
          ledgerDirectory,
          secretStore: store,
        }),
        { code: "SECRET_INGEST_UNAVAILABLE" },
      );
    }

    await assert.rejects(
      createDefaultMainManagedSecretStore({
        deviceId: "device_main",
        home: root,
        sourceCheckout: join(root, "checkout"),
        hostPlatform: "linux",
        environment: {},
      }),
      { code: "SECRET_INGEST_UNAVAILABLE" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
