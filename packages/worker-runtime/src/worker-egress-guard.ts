import { createHash } from "node:crypto";

const SNAPSHOT_SCHEMA_VERSION = 1;
const FRAGMENT_CHARACTERS = 24;
const STREAM_CARRY_CHARACTERS = 128;
const MAXIMUM_PROTECTED_VALUES = 1_024;
const MAXIMUM_PROTECTED_VALUE_CHARACTERS = 64 * 1024;
const MAXIMUM_FINGERPRINTS = 100_000;
const MAXIMUM_EXACT_LENGTHS = 128;
const MAXIMUM_ARTIFACT_INSPECTION_BYTES = 16 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const ROLLING = /^[a-f0-9]{8}:[a-f0-9]{8}$/u;
const BASE_A = 257;
const BASE_B = 65_599;

type EgressCategory = "device-local-knowledge" | "device-local-secret";

export type WorkerEgressBlockReason =
  | EgressCategory
  | "unscannable-artifact"
  | "unverifiable-knowledge-history"
  | "unverifiable-secret-history";

export type WorkerEgressInspection =
  | {
      readonly safe: true;
    }
  | {
      readonly safe: false;
      readonly reason: WorkerEgressBlockReason;
    };

export interface WorkerKnowledgeEgressInput {
  readonly noteIds: readonly string[];
  readonly titles: readonly string[];
  readonly contents: readonly string[];
}

export interface WorkerEgressFingerprint {
  readonly category: EgressCategory;
  readonly length: number;
  readonly rolling: string;
  readonly sha256: string;
}

export interface WorkerEgressFragmentFingerprint {
  readonly category: EgressCategory;
  readonly rolling: string;
  readonly sha256: string;
}

export interface WorkerEgressGuardSnapshot {
  readonly schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  readonly mode: "opaque" | "scoped";
  readonly exactFingerprints: readonly WorkerEgressFingerprint[];
  readonly fragmentFingerprints: readonly WorkerEgressFragmentFingerprint[];
}

export interface WorkerEgressArtifactInput {
  readonly relativePath: string;
  readonly originalFilename: string;
  readonly mediaType: string;
  readonly bytes?: Uint8Array;
}

export interface WorkerEgressTextScanner {
  push(value: string): WorkerEgressInspection;
  finish(): WorkerEgressInspection;
}

export interface WorkerEgressByteScanner {
  push(value: Uint8Array): WorkerEgressInspection;
  finish(): WorkerEgressInspection;
}

type SnapshotPersistence = (snapshot: WorkerEgressGuardSnapshot) => Promise<void>;

/**
 * Run-local deterministic DLP for values that may be consumed by a native Agent
 * but must not cross the Worker boundary. Only non-reversible fingerprints are
 * persisted with a resumable native session.
 */
export class WorkerEgressGuard {
  #snapshot: WorkerEgressGuardSnapshot;
  #persistence: SnapshotPersistence | undefined;
  #mutation = Promise.resolve();
  readonly #secretByteNeedles = new Map<string, Uint8Array>();
  readonly #restoredSecretProtectionIncomplete: boolean;

  private constructor(
    snapshot: WorkerEgressGuardSnapshot,
    restoredSecretProtectionIncomplete = false,
  ) {
    this.#snapshot = snapshot;
    this.#restoredSecretProtectionIncomplete = restoredSecretProtectionIncomplete;
  }

  public static empty(): WorkerEgressGuard {
    return new WorkerEgressGuard(emptyWorkerEgressGuardSnapshot());
  }

  /**
   * A missing snapshot means an older native session may have consumed Knowledge
   * before deterministic egress protection existed. That history cannot be
   * reconstructed safely, so free-form egress fails closed.
   */
  public static restore(snapshot: WorkerEgressGuardSnapshot | undefined): WorkerEgressGuard {
    if (snapshot === undefined) {
      return new WorkerEgressGuard(opaqueSnapshot());
    }
    const validated = validateWorkerEgressGuardSnapshot(snapshot);
    return new WorkerEgressGuard(validated, hasProtectedCategory(validated, "device-local-secret"));
  }

  public snapshot(): WorkerEgressGuardSnapshot {
    return structuredClone(this.#snapshot);
  }

  public requiresInspection(): boolean {
    return (
      this.#snapshot.mode === "opaque" ||
      this.#snapshot.exactFingerprints.length > 0 ||
      this.#snapshot.fragmentFingerprints.length > 0
    );
  }

  public protectKnowledge(input: WorkerKnowledgeEgressInput): Promise<void> {
    if (
      !isStringArray(input.noteIds) ||
      !isStringArray(input.titles) ||
      !isStringArray(input.contents)
    ) {
      return Promise.reject(new TypeError("Device-local Knowledge egress input is invalid."));
    }
    const values = [
      ...input.noteIds,
      ...input.titles,
      ...input.contents.flatMap((content) => knowledgeContentValues(content)),
    ];
    return this.#protect(values, "device-local-knowledge");
  }

  public async protectSecrets(values: readonly string[]): Promise<void> {
    if (!isStringArray(values)) {
      throw new TypeError("Device-local Secret egress input is invalid.");
    }
    await this.#protect(values, "device-local-secret");
    for (const value of values) {
      for (const variant of protectedVariants(value)) {
        const bytes = Buffer.from(variant, "utf8");
        if (bytes.byteLength > 0) {
          this.#secretByteNeedles.set(digestBytes(bytes), bytes);
        }
      }
    }
  }

  /**
   * Binds the guard to the current native-session record. The current snapshot is
   * committed before the binding becomes usable for future Knowledge tool calls.
   */
  public bindPersistence(persistence: SnapshotPersistence): Promise<void> {
    if (typeof persistence !== "function") {
      return Promise.reject(new TypeError("Worker egress persistence is invalid."));
    }
    return this.#queue(async () => {
      await persistence(this.snapshot());
      this.#persistence = persistence;
    });
  }

  public inspectText(value: string): WorkerEgressInspection {
    if (typeof value !== "string") {
      return Object.freeze({ safe: false, reason: "unverifiable-knowledge-history" });
    }
    if (this.#snapshot.mode === "opaque") {
      return Object.freeze({ safe: false, reason: "unverifiable-knowledge-history" });
    }
    if (!this.requiresInspection() || value.length === 0) {
      return Object.freeze({ safe: true });
    }
    return inspectNormalized(normalize(value), this.#snapshot);
  }

  public createTextScanner(): WorkerEgressTextScanner {
    if (this.#snapshot.mode === "opaque") {
      return blockedScanner("unverifiable-knowledge-history");
    }
    let carry = "";
    let blocked: WorkerEgressInspection | undefined;
    return Object.freeze({
      push: (value: string) => {
        if (blocked !== undefined) {
          return blocked;
        }
        if (typeof value !== "string") {
          blocked = Object.freeze({
            safe: false,
            reason: "unverifiable-knowledge-history",
          });
          return blocked;
        }
        const combined = `${carry}${value}`;
        const inspection = this.inspectText(combined);
        if (!inspection.safe) {
          blocked = inspection;
          return inspection;
        }
        carry = combined.slice(-STREAM_CARRY_CHARACTERS);
        return inspection;
      },
      finish: () => blocked ?? Object.freeze({ safe: true }),
    });
  }

  public createByteScanner(): WorkerEgressByteScanner {
    if (this.#snapshot.mode === "opaque") {
      return blockedByteScanner("unverifiable-knowledge-history");
    }
    if (this.#restoredSecretProtectionIncomplete) {
      return blockedByteScanner("unverifiable-secret-history");
    }
    const needles = [...this.#secretByteNeedles.values()].sort(
      (left, right) => right.byteLength - left.byteLength,
    );
    if (needles.length === 0) {
      return Object.freeze({
        push: () => Object.freeze({ safe: true }),
        finish: () => Object.freeze({ safe: true }),
      });
    }
    const maximumCarry = Math.max(...needles.map(({ byteLength }) => byteLength - 1));
    let carry = Buffer.alloc(0);
    let blocked: WorkerEgressInspection | undefined;
    return Object.freeze({
      push: (value: Uint8Array) => {
        if (blocked !== undefined) {
          return blocked;
        }
        if (!(value instanceof Uint8Array)) {
          blocked = Object.freeze({
            safe: false,
            reason: "unverifiable-secret-history",
          });
          return blocked;
        }
        const combined = Buffer.concat([
          carry,
          Buffer.from(value.buffer, value.byteOffset, value.byteLength),
        ]);
        if (needles.some((needle) => combined.indexOf(needle) >= 0)) {
          blocked = Object.freeze({
            safe: false,
            reason: "device-local-secret",
          });
          return blocked;
        }
        carry =
          maximumCarry === 0
            ? Buffer.alloc(0)
            : Buffer.from(combined.subarray(Math.max(0, combined.byteLength - maximumCarry)));
        return Object.freeze({ safe: true });
      },
      finish: () => blocked ?? Object.freeze({ safe: true }),
    });
  }

  public inspectArtifact(input: WorkerEgressArtifactInput): WorkerEgressInspection {
    if (!this.requiresInspection()) {
      return Object.freeze({ safe: true });
    }
    for (const metadata of [input.relativePath, input.originalFilename, input.mediaType]) {
      const metadataInspection = this.inspectText(metadata);
      if (!metadataInspection.safe) {
        return metadataInspection;
      }
    }
    if (input.bytes !== undefined) {
      const byteScanner = this.createByteScanner();
      const byteInspection = byteScanner.push(input.bytes);
      if (!byteInspection.safe) {
        return byteInspection;
      }
      const finished = byteScanner.finish();
      if (!finished.safe) {
        return finished;
      }
    }
    const hasKnowledge = hasProtectedCategory(this.#snapshot, "device-local-knowledge");
    if (!hasKnowledge) {
      return input.bytes === undefined
        ? Object.freeze({ safe: false, reason: "unscannable-artifact" })
        : Object.freeze({ safe: true });
    }
    if (
      input.bytes === undefined ||
      input.bytes.byteLength > MAXIMUM_ARTIFACT_INSPECTION_BYTES ||
      !isScannableTextMediaType(input.mediaType)
    ) {
      return Object.freeze({ safe: false, reason: "unscannable-artifact" });
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
    } catch {
      return Object.freeze({ safe: false, reason: "unscannable-artifact" });
    }
    return this.inspectText(text);
  }

  #protect(values: readonly string[], category: EgressCategory): Promise<void> {
    return this.#queue(async () => {
      if (this.#snapshot.mode === "opaque") {
        return;
      }
      if (
        values.length > MAXIMUM_PROTECTED_VALUES ||
        values.some(
          (value) => value.length > MAXIMUM_PROTECTED_VALUE_CHARACTERS || value.includes("\0"),
        )
      ) {
        await this.#replace(opaqueSnapshot());
        return;
      }
      const exact = new Map(
        this.#snapshot.exactFingerprints.map((entry) => [fingerprintKey(entry), entry]),
      );
      const fragments = new Map(
        this.#snapshot.fragmentFingerprints.map((entry) => [fragmentKey(entry), entry]),
      );
      for (const value of values) {
        if (value.length === 0) {
          continue;
        }
        for (const variant of protectedVariants(value)) {
          addValueFingerprints(variant, category, exact, fragments);
          if (
            exact.size > MAXIMUM_FINGERPRINTS ||
            fragments.size > MAXIMUM_FINGERPRINTS ||
            new Set([...exact.values()].map(({ length }) => length)).size > MAXIMUM_EXACT_LENGTHS
          ) {
            await this.#replace(opaqueSnapshot());
            return;
          }
        }
      }
      await this.#replace(
        Object.freeze({
          schemaVersion: SNAPSHOT_SCHEMA_VERSION,
          mode: "scoped",
          exactFingerprints: Object.freeze([...exact.values()].sort(compareExact)),
          fragmentFingerprints: Object.freeze([...fragments.values()].sort(compareFragment)),
        }),
      );
    });
  }

  #queue(operation: () => Promise<void>): Promise<void> {
    const next = this.#mutation.then(operation, operation);
    this.#mutation = next.catch(() => undefined);
    return next;
  }

  async #replace(next: WorkerEgressGuardSnapshot): Promise<void> {
    const validated = validateWorkerEgressGuardSnapshot(next);
    await this.#persistence?.(structuredClone(validated));
    this.#snapshot = validated;
  }
}

export function emptyWorkerEgressGuardSnapshot(): WorkerEgressGuardSnapshot {
  return Object.freeze({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    mode: "scoped",
    exactFingerprints: Object.freeze([]),
    fragmentFingerprints: Object.freeze([]),
  });
}

export function validateWorkerEgressGuardSnapshot(
  input: WorkerEgressGuardSnapshot,
): WorkerEgressGuardSnapshot {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    input.schemaVersion !== SNAPSHOT_SCHEMA_VERSION ||
    (input.mode !== "opaque" && input.mode !== "scoped") ||
    !Array.isArray(input.exactFingerprints) ||
    !Array.isArray(input.fragmentFingerprints) ||
    input.exactFingerprints.length > MAXIMUM_FINGERPRINTS ||
    input.fragmentFingerprints.length > MAXIMUM_FINGERPRINTS
  ) {
    throw invalidSnapshot();
  }
  if (
    input.mode === "opaque" &&
    (input.exactFingerprints.length > 0 || input.fragmentFingerprints.length > 0)
  ) {
    throw invalidSnapshot();
  }
  const exact = input.exactFingerprints.map(validateExactFingerprint);
  const fragments = input.fragmentFingerprints.map(validateFragmentFingerprint);
  if (
    new Set(exact.map(fingerprintKey)).size !== exact.length ||
    new Set(fragments.map(fragmentKey)).size !== fragments.length ||
    new Set(exact.map(({ length }) => length)).size > MAXIMUM_EXACT_LENGTHS
  ) {
    throw invalidSnapshot();
  }
  return Object.freeze({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    mode: input.mode,
    exactFingerprints: Object.freeze(exact.sort(compareExact)),
    fragmentFingerprints: Object.freeze(fragments.sort(compareFragment)),
  });
}

export function isScannableTextMediaType(mediaType: string): boolean {
  if (mediaType.startsWith("text/")) {
    return true;
  }
  return new Set([
    "application/json",
    "application/ld+json",
    "application/javascript",
    "application/sql",
    "application/xml",
    "application/xhtml+xml",
    "application/yaml",
  ]).has(mediaType);
}

function inspectNormalized(
  normalized: string,
  snapshot: WorkerEgressGuardSnapshot,
): WorkerEgressInspection {
  if (normalized.length === 0) {
    return Object.freeze({ safe: true });
  }
  const exactByLength = new Map<number, Map<string, readonly WorkerEgressFingerprint[]>>();
  for (const fingerprint of snapshot.exactFingerprints) {
    const byRolling = exactByLength.get(fingerprint.length) ?? new Map();
    const matches = byRolling.get(fingerprint.rolling) ?? [];
    byRolling.set(fingerprint.rolling, [...matches, fingerprint]);
    exactByLength.set(fingerprint.length, byRolling);
  }
  for (const [length, byRolling] of exactByLength) {
    const match = findFingerprintMatch(normalized, length, byRolling);
    if (match !== undefined) {
      return Object.freeze({ safe: false, reason: match.category });
    }
  }
  if (normalized.length >= FRAGMENT_CHARACTERS) {
    const fragmentByRolling = new Map<string, readonly WorkerEgressFragmentFingerprint[]>();
    for (const fingerprint of snapshot.fragmentFingerprints) {
      const matches = fragmentByRolling.get(fingerprint.rolling) ?? [];
      fragmentByRolling.set(fingerprint.rolling, [...matches, fingerprint]);
    }
    const match = findFragmentMatch(normalized, fragmentByRolling);
    if (match !== undefined) {
      return Object.freeze({ safe: false, reason: match.category });
    }
  }
  return Object.freeze({ safe: true });
}

function findFingerprintMatch(
  value: string,
  length: number,
  expected: ReadonlyMap<string, readonly WorkerEgressFingerprint[]>,
): WorkerEgressFingerprint | undefined {
  if (length > value.length) {
    return undefined;
  }
  for (const window of rollingWindows(value, length)) {
    const candidates = expected.get(window.rolling);
    if (candidates === undefined) {
      continue;
    }
    const sha256 = digest(value.slice(window.start, window.start + length));
    const match = candidates.find((candidate) => candidate.sha256 === sha256);
    if (match !== undefined) {
      return match;
    }
  }
  return undefined;
}

function findFragmentMatch(
  value: string,
  expected: ReadonlyMap<string, readonly WorkerEgressFragmentFingerprint[]>,
): WorkerEgressFragmentFingerprint | undefined {
  for (const window of rollingWindows(value, FRAGMENT_CHARACTERS)) {
    const candidates = expected.get(window.rolling);
    if (candidates === undefined) {
      continue;
    }
    const sha256 = digest(value.slice(window.start, window.start + FRAGMENT_CHARACTERS));
    const match = candidates.find((candidate) => candidate.sha256 === sha256);
    if (match !== undefined) {
      return match;
    }
  }
  return undefined;
}

function addValueFingerprints(
  value: string,
  category: EgressCategory,
  exact: Map<string, WorkerEgressFingerprint>,
  fragments: Map<string, WorkerEgressFragmentFingerprint>,
): void {
  const normalized = normalize(value);
  if (normalized.length === 0) {
    return;
  }
  if (normalized.length < FRAGMENT_CHARACTERS) {
    const rolling = rollingFingerprint(normalized);
    const entry = Object.freeze({
      category,
      length: normalized.length,
      rolling,
      sha256: digest(normalized),
    });
    exact.set(fingerprintKey(entry), entry);
    return;
  }
  for (const window of rollingWindows(normalized, FRAGMENT_CHARACTERS)) {
    const fragment = normalized.slice(window.start, window.start + FRAGMENT_CHARACTERS);
    const entry = Object.freeze({
      category,
      rolling: window.rolling,
      sha256: digest(fragment),
    });
    fragments.set(fragmentKey(entry), entry);
  }
}

function* rollingWindows(
  value: string,
  length: number,
): Generator<{ readonly start: number; readonly rolling: string }> {
  if (length < 1 || length > value.length) {
    return;
  }
  const powerA = rollingPower(BASE_A, length);
  const powerB = rollingPower(BASE_B, length);
  let hashA = 0;
  let hashB = 0;
  for (let index = 0; index < length; index += 1) {
    const code = value.charCodeAt(index) + 1;
    hashA = (Math.imul(hashA, BASE_A) + code) >>> 0;
    hashB = (Math.imul(hashB, BASE_B) + code) >>> 0;
  }
  yield { start: 0, rolling: rollingString(hashA, hashB) };
  for (let start = 1; start + length <= value.length; start += 1) {
    const previous = value.charCodeAt(start - 1) + 1;
    const next = value.charCodeAt(start + length - 1) + 1;
    hashA = (Math.imul((hashA - Math.imul(previous, powerA)) >>> 0, BASE_A) + next) >>> 0;
    hashB = (Math.imul((hashB - Math.imul(previous, powerB)) >>> 0, BASE_B) + next) >>> 0;
    yield { start, rolling: rollingString(hashA, hashB) };
  }
}

function rollingFingerprint(value: string): string {
  const first = rollingWindows(value, value.length).next().value as
    { readonly rolling: string } | undefined;
  if (first === undefined) {
    throw new TypeError("Cannot fingerprint empty Worker egress text.");
  }
  return first.rolling;
}

function rollingPower(base: number, length: number): number {
  let power = 1;
  for (let index = 1; index < length; index += 1) {
    power = Math.imul(power, base) >>> 0;
  }
  return power;
}

function rollingString(first: number, second: number): string {
  return `${first.toString(16).padStart(8, "0")}:${second.toString(16).padStart(8, "0")}`;
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function protectedVariants(value: string): readonly string[] {
  const base64 = Buffer.from(value, "utf8").toString("base64");
  const variants = new Set<string>([
    value,
    JSON.stringify(value).slice(1, -1),
    base64,
    base64.replace(/=+$/u, ""),
    Buffer.from(value, "utf8").toString("base64url"),
    Buffer.from(value, "utf8").toString("hex"),
  ]);
  try {
    const encoded = encodeURIComponent(value);
    variants.add(encoded);
    variants.add(encoded.replace(/%[A-F0-9]{2}/gu, (match) => match.toLocaleLowerCase("en-US")));
  } catch {
    // The literal and byte encodings remain protected.
  }
  return [...variants];
}

function knowledgeContentValues(content: string): readonly string[] {
  const values = new Set<string>([content]);
  for (const segment of content.split(/[\n\r.!?;]+/u)) {
    const trimmed = segment.trim();
    if (trimmed.length > 0) {
      values.add(trimmed);
    }
  }
  return [...values];
}

function validateExactFingerprint(input: unknown): WorkerEgressFingerprint {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    !isCategory((input as WorkerEgressFingerprint).category) ||
    !Number.isSafeInteger((input as WorkerEgressFingerprint).length) ||
    (input as WorkerEgressFingerprint).length < 1 ||
    (input as WorkerEgressFingerprint).length >= FRAGMENT_CHARACTERS ||
    !ROLLING.test((input as WorkerEgressFingerprint).rolling) ||
    !SHA256.test((input as WorkerEgressFingerprint).sha256) ||
    Object.keys(input).some((key) => !["category", "length", "rolling", "sha256"].includes(key))
  ) {
    throw invalidSnapshot();
  }
  return Object.freeze({ ...(input as WorkerEgressFingerprint) });
}

function validateFragmentFingerprint(input: unknown): WorkerEgressFragmentFingerprint {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    !isCategory((input as WorkerEgressFragmentFingerprint).category) ||
    !ROLLING.test((input as WorkerEgressFragmentFingerprint).rolling) ||
    !SHA256.test((input as WorkerEgressFragmentFingerprint).sha256) ||
    Object.keys(input).some((key) => !["category", "rolling", "sha256"].includes(key))
  ) {
    throw invalidSnapshot();
  }
  return Object.freeze({ ...(input as WorkerEgressFragmentFingerprint) });
}

function isCategory(value: unknown): value is EgressCategory {
  return value === "device-local-knowledge" || value === "device-local-secret";
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAXIMUM_PROTECTED_VALUES &&
    value.every((entry) => typeof entry === "string")
  );
}

function fingerprintKey(input: WorkerEgressFingerprint): string {
  return `${input.category}:${input.length}:${input.rolling}:${input.sha256}`;
}

function fragmentKey(input: WorkerEgressFragmentFingerprint): string {
  return `${input.category}:${input.rolling}:${input.sha256}`;
}

function compareExact(left: WorkerEgressFingerprint, right: WorkerEgressFingerprint): number {
  return fingerprintKey(left).localeCompare(fingerprintKey(right), "en");
}

function compareFragment(
  left: WorkerEgressFragmentFingerprint,
  right: WorkerEgressFragmentFingerprint,
): number {
  return fragmentKey(left).localeCompare(fragmentKey(right), "en");
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function opaqueSnapshot(): WorkerEgressGuardSnapshot {
  return Object.freeze({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    mode: "opaque",
    exactFingerprints: Object.freeze([]),
    fragmentFingerprints: Object.freeze([]),
  });
}

function blockedScanner(reason: WorkerEgressBlockReason): WorkerEgressTextScanner {
  const blocked = Object.freeze({ safe: false as const, reason });
  return Object.freeze({
    push: () => blocked,
    finish: () => blocked,
  });
}

function blockedByteScanner(reason: WorkerEgressBlockReason): WorkerEgressByteScanner {
  const blocked = Object.freeze({ safe: false as const, reason });
  return Object.freeze({
    push: () => blocked,
    finish: () => blocked,
  });
}

function hasProtectedCategory(
  snapshot: WorkerEgressGuardSnapshot,
  category: EgressCategory,
): boolean {
  return (
    snapshot.mode === "opaque" ||
    snapshot.exactFingerprints.some((entry) => entry.category === category) ||
    snapshot.fragmentFingerprints.some((entry) => entry.category === category)
  );
}

function digestBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function invalidSnapshot(): TypeError {
  return new TypeError("Worker Knowledge egress snapshot is invalid.");
}
