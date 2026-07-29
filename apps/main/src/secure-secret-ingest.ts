import { constants as fileConstants, type BigIntStats } from "node:fs";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, link, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { platform } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { TextDecoder } from "node:util";

import type { SecureSecretIngestInput, SecureSecretIngestPort } from "@opendelegate/control-plane";
import { SecureSecretIngestPortError } from "@opendelegate/control-plane";
import type {
  ConfigurationSecretReferenceAuthority,
  ConfigurationSecretReferenceAvailabilityInput,
} from "@opendelegate/configuration";
import type {
  SecureSecretIngestPurposeV1,
  SecureSecretIngestReceiptV1,
} from "@opendelegate/protocol";
import { createPlatformManagedSecretStore, type ManagedSecretStore } from "@opendelegate/secrets";

import { readStableRegularFile } from "./stable-file.ts";

const MAXIMUM_LEDGER_ENTRIES = 4_096;
const MAXIMUM_LEDGER_RECORD_BYTES = 4_096;
const SECRET_REFERENCE_PREFIX = "secret://main/";
const OPAQUE_SECRET_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;
const LEDGER_RECORD_NAME = /^[a-f0-9]{64}\.json$/u;
const LEDGER_TEMPORARY_NAME =
  /^(?<operationId>[a-f0-9]{64})\.(?<nonce>[a-f0-9]{32})\.(?<kind>create|replace)\.tmp$/u;
const INITIAL_DISCORD_CAPABILITY_OPERATION = digest(
  "opendelegate:init-discord-bot-token-capability:v1",
);
const PURPOSE_MAXIMUM_BYTES: Readonly<Record<SecureSecretIngestPurposeV1, number>> = Object.freeze({
  "api-token": 16 * 1024,
  "database-uri": 8 * 1024,
  "discord-bot-token": 4 * 1024,
  "private-key": 64 * 1024,
  "service-credential": 64 * 1024,
});
const DATABASE_SCHEMES = new Set(["postgres:", "postgresql:"]);
const PRIVATE_KEY_HEADER = /^-----BEGIN (?:EC |ENCRYPTED |OPENSSH |RSA )?PRIVATE KEY-----/u;

interface IngestLedgerRecord {
  readonly schemaVersion: 1;
  readonly state: "completed" | "pending";
  readonly purpose: SecureSecretIngestPurposeV1;
  readonly secretRef: string;
}

interface LedgerRecordSnapshot {
  readonly identity: BigIntStats;
  readonly record: IngestLedgerRecord;
}

export interface MainSecureSecretIngestServiceOptions {
  readonly mainDeviceId: string;
  readonly ledgerDirectory: string;
  readonly secretStore: ManagedSecretStore;
  readonly idSource?: () => string;
  readonly maximumLedgerEntries?: number;
}

/**
 * Main-local, owner-authenticated Secret intake. Durable records contain only
 * operation metadata and an opaque reference; raw bytes live exclusively in
 * the OS-backed ManagedSecretStore.
 */
export class MainSecureSecretIngestService
  implements SecureSecretIngestPort, ConfigurationSecretReferenceAuthority
{
  readonly #mainDeviceId: string;
  readonly #ledgerDirectory: string;
  readonly #secretStore: ManagedSecretStore;
  readonly #idSource: () => string;
  readonly #maximumLedgerEntries: number;
  readonly #availableReferences = new Set<string>();
  readonly #referencePurposes = new Map<string, SecureSecretIngestPurposeV1>();
  readonly #operationTails = new Map<string, Promise<void>>();
  #ledgerDirectoryIdentity: BigIntStats | undefined;
  #ledgerMutationTail: Promise<void> = Promise.resolve();
  #recordCount = 0;

  private constructor(options: MainSecureSecretIngestServiceOptions) {
    this.#mainDeviceId = requireIdentifier(options.mainDeviceId);
    if (
      options.secretStore === null ||
      typeof options.secretStore !== "object" ||
      options.secretStore.deviceId !== this.#mainDeviceId ||
      typeof options.secretStore.availability !== "function" ||
      typeof options.secretStore.executeWithSecretBytes !== "function" ||
      typeof options.secretStore.store !== "function"
    ) {
      throw new TypeError("A Main-local Managed Secret Store is required.");
    }
    if (!isAbsolute(options.ledgerDirectory) || options.ledgerDirectory.includes("\0")) {
      throw new TypeError("The secure-ingest ledger directory must be absolute.");
    }
    if (options.idSource !== undefined && typeof options.idSource !== "function") {
      throw new TypeError("The secure-ingest ID source is invalid.");
    }
    this.#ledgerDirectory = resolve(options.ledgerDirectory);
    this.#secretStore = options.secretStore;
    this.#maximumLedgerEntries = requireMaximumLedgerEntries(
      options.maximumLedgerEntries ?? MAXIMUM_LEDGER_ENTRIES,
    );
    this.#idSource =
      options.idSource ?? (() => `secret_${randomUUID().toLowerCase().replaceAll("-", "")}`);
  }

  public static async open(
    options: MainSecureSecretIngestServiceOptions,
  ): Promise<MainSecureSecretIngestService> {
    const service = new MainSecureSecretIngestService(options);
    await service.#initialize();
    return service;
  }

  public isAvailable(input: ConfigurationSecretReferenceAvailabilityInput): boolean {
    return (
      input.locality === "main" &&
      input.scope.kind === "main" &&
      input.scope.id === this.#mainDeviceId &&
      input.key === "database.uri-ref" &&
      this.#referencePurposes.get(input.secretRef) === "database-uri" &&
      this.#availableReferences.has(input.secretRef)
    );
  }

  /**
   * Returns only opaque aliases already reconciled with the managed store.
   * This metadata powers exact-match egress guards without exposing values.
   */
  public managedSecretAliases(): readonly string[] {
    return Object.freeze([...this.#availableReferences].map(aliasFromReference).sort());
  }

  /**
   * Reads only durable, non-secret capability metadata. Platform-vault
   * availability remains separate so an authoritative runtime can keep its
   * retry lifecycle while the vault is temporarily unavailable.
   */
  public hasAliasPurpose(alias: string, purpose: SecureSecretIngestPurposeV1): boolean {
    let normalizedAlias: string;
    try {
      normalizedAlias = requireOpaqueSecretId(alias);
    } catch {
      return false;
    }
    return this.#referencePurposes.get(`${SECRET_REFERENCE_PREFIX}${normalizedAlias}`) === purpose;
  }

  /**
   * Records the one Discord alias explicitly selected by a fresh Main init.
   * The fixed operation identity makes this a write-once capability: editing
   * bootstrap files on a later start cannot authorize another alias.
   */
  public async registerInitialDiscordBotTokenAlias(alias: string): Promise<void> {
    const secretRef = `${SECRET_REFERENCE_PREFIX}${requireOpaqueSecretId(alias)}`;
    await this.#enqueue(INITIAL_DISCORD_CAPABILITY_OPERATION, async () => {
      const path = join(this.#ledgerDirectory, `${INITIAL_DISCORD_CAPABILITY_OPERATION}.json`);
      const snapshot = await this.#withLedgerMutation(async () => {
        await this.#assertLedgerDirectory();
        const existing = await this.#readRecordIfPresent(path);
        if (existing !== undefined) {
          return existing;
        }
        if (this.#recordCount >= this.#maximumLedgerEntries) {
          throw new SecureSecretIngestPortError("SECRET_INGEST_UNAVAILABLE");
        }
        const record: IngestLedgerRecord = Object.freeze({
          schemaVersion: 1,
          state: "completed",
          purpose: "discord-bot-token",
          secretRef,
        });
        try {
          const created = await this.#createRecord(
            INITIAL_DISCORD_CAPABILITY_OPERATION,
            path,
            record,
          );
          this.#recordCount += 1;
          return created;
        } catch (error) {
          const published = await this.#readRecordIfPresent(path).catch(() => undefined);
          if (published !== undefined) {
            this.#recordCount += 1;
          }
          throw error;
        }
      });
      if (
        snapshot.record.state !== "completed" ||
        snapshot.record.purpose !== "discord-bot-token" ||
        snapshot.record.secretRef !== secretRef
      ) {
        throw new SecureSecretIngestPortError("SECRET_INGEST_IDEMPOTENCY_CONFLICT");
      }
      this.#referencePurposes.set(secretRef, "discord-bot-token");
      const availability = await this.#secretStore.availability(alias).catch(() => undefined);
      if (availability?.ready === true && availability.alias === alias) {
        this.#availableReferences.add(secretRef);
      }
    });
  }

  public async ingest(input: SecureSecretIngestInput): Promise<SecureSecretIngestReceiptV1> {
    const principalId = requireIdentifier(input.principalId);
    const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
    const purpose = requirePurpose(input.purpose);
    const material = copyAndValidateMaterial(input.secret, purpose);
    const operationId = digest(`${principalId}\0${idempotencyKey}`);
    try {
      return await this.#enqueue(operationId, () =>
        this.#ingestSerialized(operationId, purpose, material),
      );
    } finally {
      material.fill(0);
    }
  }

  async #initialize(): Promise<void> {
    await mkdir(this.#ledgerDirectory, { recursive: true, mode: 0o700 });
    this.#ledgerDirectoryIdentity = await inspectLedgerDirectory(this.#ledgerDirectory);
    const entries = await readdir(this.#ledgerDirectory, { withFileTypes: true });
    if (entries.length > this.#maximumLedgerEntries * 2) {
      throw new SecureSecretIngestPortError("SECRET_INGEST_UNAVAILABLE");
    }
    const recordEntries = entries.filter((entry) => LEDGER_RECORD_NAME.test(entry.name));
    if (
      recordEntries.length > this.#maximumLedgerEntries ||
      entries.some(
        (entry) =>
          !entry.isFile() ||
          entry.isSymbolicLink() ||
          (!LEDGER_RECORD_NAME.test(entry.name) && !LEDGER_TEMPORARY_NAME.test(entry.name)),
      )
    ) {
      throw new SecureSecretIngestPortError("SECRET_INGEST_UNAVAILABLE");
    }
    for (const entry of entries) {
      if (LEDGER_TEMPORARY_NAME.test(entry.name)) {
        await this.#recoverTemporaryRecord(entry.name);
      }
    }
    await this.#assertLedgerDirectory();
    this.#recordCount = recordEntries.length;
    await Promise.all(
      recordEntries.map(async (entry) => {
        const snapshot = await this.#readRecord(join(this.#ledgerDirectory, entry.name));
        if (snapshot.record.state !== "completed") {
          return;
        }
        this.#referencePurposes.set(snapshot.record.secretRef, snapshot.record.purpose);
        const alias = aliasFromReference(snapshot.record.secretRef);
        const availability = await this.#secretStore.availability(alias).catch(() => undefined);
        if (availability?.ready === true && availability.alias === alias) {
          this.#availableReferences.add(snapshot.record.secretRef);
        }
      }),
    );
  }

  async #ingestSerialized(
    operationId: string,
    purpose: SecureSecretIngestPurposeV1,
    material: Buffer,
  ): Promise<SecureSecretIngestReceiptV1> {
    const path = join(this.#ledgerDirectory, `${operationId}.json`);
    const snapshot = await this.#withLedgerMutation(async () => {
      await this.#assertLedgerDirectory();
      const existing = await this.#readRecordIfPresent(path);
      if (existing !== undefined) {
        return existing;
      }
      if (this.#recordCount >= this.#maximumLedgerEntries) {
        throw new SecureSecretIngestPortError("SECRET_INGEST_UNAVAILABLE");
      }
      const secretId = requireOpaqueSecretId(this.#idSource());
      const record: IngestLedgerRecord = Object.freeze({
        schemaVersion: 1,
        state: "pending",
        purpose,
        secretRef: `${SECRET_REFERENCE_PREFIX}${secretId}`,
      });
      try {
        const created = await this.#createRecord(operationId, path, record);
        this.#recordCount += 1;
        return created;
      } catch (error) {
        const published = await this.#readRecordIfPresent(path).catch(() => undefined);
        if (published !== undefined) {
          this.#recordCount += 1;
        }
        throw error;
      }
    });
    if (snapshot.record.purpose !== purpose) {
      throw new SecureSecretIngestPortError("SECRET_INGEST_IDEMPOTENCY_CONFLICT");
    }
    await this.#recoverOrVerify(path, snapshot, material);
    return receipt(snapshot.record.secretRef);
  }

  async #recoverOrVerify(
    path: string,
    snapshot: LedgerRecordSnapshot,
    material: Buffer,
  ): Promise<void> {
    const record = snapshot.record;
    const alias = aliasFromReference(record.secretRef);
    let availability;
    try {
      availability = await this.#secretStore.availability(alias);
    } catch {
      throw new SecureSecretIngestPortError("SECRET_INGEST_UNAVAILABLE");
    }
    if (availability.alias !== alias) {
      throw new SecureSecretIngestPortError("SECRET_INGEST_UNAVAILABLE");
    }
    if (availability.ready) {
      if (!(await this.#secretMatches(alias, material))) {
        throw new SecureSecretIngestPortError("SECRET_INGEST_IDEMPOTENCY_CONFLICT");
      }
    } else {
      try {
        await this.#secretStore.store(alias, material);
      } catch {
        throw new SecureSecretIngestPortError("SECRET_INGEST_UNAVAILABLE");
      }
    }
    if (record.state !== "completed") {
      await this.#replaceRecord(path, snapshot, {
        ...record,
        state: "completed",
      });
    }
    this.#referencePurposes.set(record.secretRef, record.purpose);
    this.#availableReferences.add(record.secretRef);
  }

  async #secretMatches(alias: string, material: Buffer): Promise<boolean> {
    let matches = false;
    try {
      await this.#secretStore.executeWithSecretBytes(alias, (stored) => {
        matches =
          stored.byteLength === material.byteLength &&
          timingSafeEqual(
            Buffer.from(stored.buffer, stored.byteOffset, stored.byteLength),
            material,
          );
      });
      return matches;
    } catch {
      throw new SecureSecretIngestPortError("SECRET_INGEST_UNAVAILABLE");
    }
  }

  #enqueue<TResult>(operationId: string, operation: () => Promise<TResult>): Promise<TResult> {
    const prior = this.#operationTails.get(operationId) ?? Promise.resolve();
    const result = prior.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#operationTails.set(operationId, tail);
    void tail.finally(() => {
      if (this.#operationTails.get(operationId) === tail) {
        this.#operationTails.delete(operationId);
      }
    });
    return result;
  }

  #withLedgerMutation<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const result = this.#ledgerMutationTail.catch(() => undefined).then(operation);
    this.#ledgerMutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #assertLedgerDirectory(): Promise<void> {
    const expected = this.#ledgerDirectoryIdentity;
    if (expected === undefined) {
      throw new SecureSecretIngestPortError("SECRET_INGEST_UNAVAILABLE");
    }
    const observed = await inspectLedgerDirectory(this.#ledgerDirectory);
    if (!sameFile(expected, observed)) {
      throw new SecureSecretIngestPortError("SECRET_INGEST_UNAVAILABLE");
    }
  }

  async #recoverTemporaryRecord(name: string): Promise<void> {
    const match = LEDGER_TEMPORARY_NAME.exec(name);
    const operationId = match?.groups?.["operationId"];
    const kind = match?.groups?.["kind"];
    if (operationId === undefined || kind === undefined) {
      throw new SecureSecretIngestPortError("SECRET_INGEST_UNAVAILABLE");
    }
    await this.#assertLedgerDirectory();
    const temporaryPath = join(this.#ledgerDirectory, name);
    let temporary: BigIntStats;
    try {
      temporary = await lstat(temporaryPath, { bigint: true });
    } catch {
      throw new SecureSecretIngestPortError("SECRET_INGEST_UNAVAILABLE");
    }
    if (
      temporary.isSymbolicLink() ||
      !temporary.isFile() ||
      (process.platform !== "win32" && (temporary.mode & 0o077n) !== 0n)
    ) {
      throw new SecureSecretIngestPortError("SECRET_INGEST_UNAVAILABLE");
    }

    if (kind === "create") {
      const finalPath = join(this.#ledgerDirectory, `${operationId}.json`);
      const final = await safeLstat(finalPath);
      if (final === undefined) {
        if (temporary.nlink !== 1n) {
          throw new SecureSecretIngestPortError("SECRET_INGEST_UNAVAILABLE");
        }
      } else if (
        final.isSymbolicLink() ||
        !final.isFile() ||
        temporary.nlink !== 2n ||
        final.nlink !== 2n ||
        !sameFile(temporary, final)
      ) {
        throw new SecureSecretIngestPortError("SECRET_INGEST_UNAVAILABLE");
      }
    } else if (temporary.nlink !== 1n) {
      throw new SecureSecretIngestPortError("SECRET_INGEST_UNAVAILABLE");
    }

    try {
      await unlink(temporaryPath);
      await syncDirectory(this.#ledgerDirectory);
      await this.#assertLedgerDirectory();
    } catch {
      throw new SecureSecretIngestPortError("SECRET_INGEST_UNAVAILABLE");
    }
  }

  async #readRecordIfPresent(path: string): Promise<LedgerRecordSnapshot | undefined> {
    try {
      return await this.#readRecord(path);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return undefined;
      }
      if (error instanceof SecureSecretIngestPortError) {
        throw error;
      }
      throw new SecureSecretIngestPortError("SECRET_INGEST_UNAVAILABLE");
    }
  }

  async #readRecord(path: string): Promise<LedgerRecordSnapshot> {
    let bytes: Buffer | undefined;
    try {
      await this.#assertLedgerDirectory();
      const metadata = await lstat(path, { bigint: true });
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.nlink !== 1n ||
        (process.platform !== "win32" && (metadata.mode & 0o077n) !== 0n)
      ) {
        throw new SecureSecretIngestPortError("SECRET_INGEST_UNAVAILABLE");
      }
      bytes = await readStableRegularFile(path, MAXIMUM_LEDGER_RECORD_BYTES);
      const afterRead = await lstat(path, { bigint: true });
      if (!sameSnapshot(metadata, afterRead)) {
        throw new SecureSecretIngestPortError("SECRET_INGEST_UNAVAILABLE");
      }
      await this.#assertLedgerDirectory();
      return Object.freeze({
        identity: afterRead,
        record: parseRecord(JSON.parse(bytes.toString("utf8"))),
      });
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw error;
      }
      throw new SecureSecretIngestPortError("SECRET_INGEST_UNAVAILABLE");
    } finally {
      bytes?.fill(0);
    }
  }

  async #createRecord(
    operationId: string,
    path: string,
    record: IngestLedgerRecord,
  ): Promise<LedgerRecordSnapshot> {
    const temporaryPath = await this.#writeTemporaryRecord(operationId, "create", record);
    try {
      await this.#assertLedgerDirectory();
      await link(temporaryPath, path);
      await syncDirectory(this.#ledgerDirectory);
      await unlink(temporaryPath);
      await syncDirectory(this.#ledgerDirectory);
      await this.#assertLedgerDirectory();
      return await this.#readRecord(path);
    } catch {
      throw new SecureSecretIngestPortError("SECRET_INGEST_UNAVAILABLE");
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  async #replaceRecord(
    path: string,
    current: LedgerRecordSnapshot,
    record: IngestLedgerRecord,
  ): Promise<void> {
    const operationId = path.slice(this.#ledgerDirectory.length + 1).replace(/\.json$/u, "");
    if (!/^[a-f0-9]{64}$/u.test(operationId)) {
      throw new SecureSecretIngestPortError("SECRET_INGEST_UNAVAILABLE");
    }
    const temporaryPath = await this.#writeTemporaryRecord(operationId, "replace", record);
    try {
      await this.#assertLedgerDirectory();
      const observed = await lstat(path, { bigint: true });
      if (
        observed.isSymbolicLink() ||
        !observed.isFile() ||
        observed.nlink !== 1n ||
        !sameSnapshot(current.identity, observed)
      ) {
        throw new SecureSecretIngestPortError("SECRET_INGEST_UNAVAILABLE");
      }
      await rename(temporaryPath, path);
      await syncDirectory(this.#ledgerDirectory);
      await this.#assertLedgerDirectory();
      const committed = await this.#readRecord(path);
      if (
        committed.record.state !== record.state ||
        committed.record.secretRef !== record.secretRef ||
        committed.record.purpose !== record.purpose
      ) {
        throw new SecureSecretIngestPortError("SECRET_INGEST_UNAVAILABLE");
      }
    } catch {
      throw new SecureSecretIngestPortError("SECRET_INGEST_UNAVAILABLE");
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  async #writeTemporaryRecord(
    operationId: string,
    kind: "create" | "replace",
    record: IngestLedgerRecord,
  ): Promise<string> {
    const nonce = randomUUID().toLowerCase().replaceAll("-", "");
    const path = join(this.#ledgerDirectory, `${operationId}.${nonce}.${kind}.tmp`);
    const noFollow = fileConstants.O_NOFOLLOW ?? 0;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await this.#assertLedgerDirectory();
      handle = await open(
        path,
        fileConstants.O_CREAT | fileConstants.O_EXCL | fileConstants.O_RDWR | noFollow,
        0o600,
      );
      await writeRecord(handle, record);
      const metadata = await handle.stat({ bigint: true });
      const namedMetadata = await lstat(path, { bigint: true });
      if (
        !metadata.isFile() ||
        metadata.nlink !== 1n ||
        namedMetadata.isSymbolicLink() ||
        !namedMetadata.isFile() ||
        !sameSnapshot(metadata, namedMetadata) ||
        (process.platform !== "win32" && (metadata.mode & 0o077n) !== 0n)
      ) {
        throw new Error("unsafe temporary record");
      }
      await handle.close();
      handle = undefined;
      await this.#assertLedgerDirectory();
      return path;
    } catch {
      await handle?.close().catch(() => undefined);
      await unlink(path).catch(() => undefined);
      throw new SecureSecretIngestPortError("SECRET_INGEST_UNAVAILABLE");
    }
  }
}

export async function createDefaultMainManagedSecretStore(input: {
  readonly deviceId: string;
  readonly home: string;
  readonly sourceCheckout: string;
  readonly hostPlatform?: NodeJS.Platform;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): Promise<ManagedSecretStore> {
  const hostPlatform = input.hostPlatform ?? platform();
  switch (hostPlatform) {
    case "win32":
      return createPlatformManagedSecretStore({
        backend: "windows-dpapi",
        deviceId: input.deviceId,
        sourceCheckoutRoot: input.sourceCheckout,
        vaultRoot: join(input.home, "secrets", "main"),
      });
    case "linux": {
      const environment = input.environment ?? process.env;
      if (
        !isNonemptyEnvironmentValue(environment["DBUS_SESSION_BUS_ADDRESS"]) ||
        !isNonemptyEnvironmentValue(environment["XDG_RUNTIME_DIR"])
      ) {
        // Secret Service is a graphical-session backend. Headless Main
        // composition must explicitly inject a systemd credential-backed store.
        throw new SecureSecretIngestPortError("SECRET_INGEST_UNAVAILABLE");
      }
      return createPlatformManagedSecretStore({
        backend: "linux-secret-service",
        deviceId: input.deviceId,
      });
    }
    case "darwin": {
      const helperPath = join(
        input.sourceCheckout,
        "runtime",
        "native",
        "opendelegate-keychain-helper",
      );
      let bytes: Buffer | undefined;
      let expectedHelperSha256 = `sha256:${"0".repeat(64)}`;
      try {
        bytes = await readStableRegularFile(helperPath, 64 * 1024 * 1024);
        expectedHelperSha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      } catch {
        // Development trees may not contain the signed release helper. The
        // resulting store stays fail-closed until a verified helper is present.
      } finally {
        bytes?.fill(0);
      }
      return createPlatformManagedSecretStore({
        backend: "macos-keychain",
        deviceId: input.deviceId,
        helperPath,
        expectedHelperSha256,
      });
    }
    default:
      throw new SecureSecretIngestPortError("SECRET_INGEST_UNAVAILABLE");
  }
}

function copyAndValidateMaterial(value: Uint8Array, purpose: SecureSecretIngestPurposeV1): Buffer {
  if (!(value instanceof Uint8Array)) {
    throw new SecureSecretIngestPortError("SECRET_INGEST_INVALID");
  }
  const material = Buffer.from(value);
  if (material.byteLength === 0 || material.byteLength > PURPOSE_MAXIMUM_BYTES[purpose]) {
    material.fill(0);
    throw new SecureSecretIngestPortError("SECRET_INGEST_INVALID");
  }
  if (purpose === "service-credential") {
    return material;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(material);
  } catch {
    material.fill(0);
    throw new SecureSecretIngestPortError("SECRET_INGEST_INVALID");
  }
  if (text.includes("\0") || text !== text.trim()) {
    material.fill(0);
    throw new SecureSecretIngestPortError("SECRET_INGEST_INVALID");
  }
  if (purpose === "api-token" && (text.length === 0 || /\s/u.test(text) || hasAsciiControl(text))) {
    material.fill(0);
    throw new SecureSecretIngestPortError("SECRET_INGEST_INVALID");
  }
  if (purpose === "discord-bot-token" && !/^[\x21-\x7e]+$/u.test(text)) {
    material.fill(0);
    throw new SecureSecretIngestPortError("SECRET_INGEST_INVALID");
  }
  if (purpose === "private-key" && !PRIVATE_KEY_HEADER.test(text)) {
    material.fill(0);
    throw new SecureSecretIngestPortError("SECRET_INGEST_INVALID");
  }
  if (purpose === "database-uri") {
    let uri: URL;
    try {
      uri = new URL(text);
    } catch {
      material.fill(0);
      throw new SecureSecretIngestPortError("SECRET_INGEST_INVALID");
    }
    if (!DATABASE_SCHEMES.has(uri.protocol) || uri.hostname === "") {
      material.fill(0);
      throw new SecureSecretIngestPortError("SECRET_INGEST_INVALID");
    }
  }
  return material;
}

function parseRecord(value: unknown): IngestLedgerRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new SecureSecretIngestPortError("SECRET_INGEST_UNAVAILABLE");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 4 ||
    !["schemaVersion", "state", "purpose", "secretRef"].every((key) =>
      Object.hasOwn(record, key),
    ) ||
    record["schemaVersion"] !== 1 ||
    (record["state"] !== "pending" && record["state"] !== "completed") ||
    !isPurpose(record["purpose"]) ||
    typeof record["secretRef"] !== "string"
  ) {
    throw new SecureSecretIngestPortError("SECRET_INGEST_UNAVAILABLE");
  }
  aliasFromReference(record["secretRef"]);
  return Object.freeze({
    schemaVersion: 1,
    state: record["state"],
    purpose: record["purpose"],
    secretRef: record["secretRef"],
  });
}

async function writeRecord(
  handle: Awaited<ReturnType<typeof open>>,
  record: IngestLedgerRecord,
): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  try {
    if (bytes.byteLength > MAXIMUM_LEDGER_RECORD_BYTES) {
      throw new Error("record too large");
    }
    await handle.truncate(0);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesWritten <= 0) {
        throw new Error("record write failed");
      }
      offset += result.bytesWritten;
    }
    await handle.sync();
  } finally {
    bytes.fill(0);
  }
}

function aliasFromReference(secretRef: string): string {
  if (!secretRef.startsWith(SECRET_REFERENCE_PREFIX)) {
    throw new SecureSecretIngestPortError("SECRET_INGEST_UNAVAILABLE");
  }
  return requireOpaqueSecretId(secretRef.slice(SECRET_REFERENCE_PREFIX.length));
}

function requirePurpose(value: unknown): SecureSecretIngestPurposeV1 {
  if (!isPurpose(value)) {
    throw new SecureSecretIngestPortError("SECRET_INGEST_INVALID");
  }
  return value;
}

function isPurpose(value: unknown): value is SecureSecretIngestPurposeV1 {
  return typeof value === "string" && Object.hasOwn(PURPOSE_MAXIMUM_BYTES, value);
}

function requireOpaqueSecretId(value: unknown): string {
  if (typeof value !== "string" || !OPAQUE_SECRET_ID.test(value)) {
    throw new SecureSecretIngestPortError("SECRET_INGEST_UNAVAILABLE");
  }
  return value;
}

function requireIdentifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value !== value.trim() ||
    hasAsciiControl(value)
  ) {
    throw new TypeError("A valid Main Device identifier is required.");
  }
  return value;
}

function requireIdempotencyKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 500 ||
    value !== value.trim() ||
    hasAsciiControl(value)
  ) {
    throw new SecureSecretIngestPortError("SECRET_INGEST_INVALID");
  }
  return value;
}

function receipt(secretRef: string): SecureSecretIngestReceiptV1 {
  return Object.freeze({
    schemaVersion: 1,
    secretRef,
    availability: "ready",
  });
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requireMaximumLedgerEntries(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError("The secure-ingest ledger capacity is invalid.");
  }
  return value as number;
}

async function inspectLedgerDirectory(path: string): Promise<BigIntStats> {
  try {
    const metadata = await lstat(path, { bigint: true });
    const canonical = await realpath(path);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      !pathsEqual(canonical, path) ||
      (process.platform !== "win32" && (metadata.mode & 0o077n) !== 0n)
    ) {
      throw new Error("unsafe ledger directory");
    }
    return metadata;
  } catch {
    throw new SecureSecretIngestPortError("SECRET_INGEST_UNAVAILABLE");
  }
}

async function safeLstat(path: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return undefined;
    }
    throw new SecureSecretIngestPortError("SECRET_INGEST_UNAVAILABLE");
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, fileConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (
      process.platform !== "win32" &&
      !isNodeError(error, "EINVAL") &&
      !isNodeError(error, "EISDIR")
    ) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.ino === right.ino &&
    (left.dev === right.dev ||
      (process.platform === "win32" &&
        (left.dev === 0n || right.dev === 0n) &&
        left.birthtimeNs === right.birthtimeNs))
  );
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameFile(left, right) &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function pathsEqual(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isNonemptyEnvironmentValue(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
