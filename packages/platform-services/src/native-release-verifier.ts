import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { posix, win32 } from "node:path";

import type { NativeFileSystemBoundary } from "./native-service-boundaries.ts";
import { ServiceCommandExecutionError } from "./service-command.ts";
import {
  createPlatformServiceDefinition,
  parsePlatformServiceConfiguration,
} from "./configuration.ts";
import type { PlatformFamily, PlatformServiceConfiguration } from "./types.ts";

const MAXIMUM_ATTESTATION_BYTES = 64 * 1024;
const MAXIMUM_KEY_BYTES = 64 * 1024;
const MAXIMUM_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAXIMUM_METADATA_BYTES = 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const QUALIFIED_SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]{80,96}$/u;
const SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;

interface PayloadEntry {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

interface NativeComponent {
  readonly kind: string;
  readonly path: string;
  readonly sha256: string;
}

interface NativeComponentsManifest {
  readonly schemaVersion: 1;
  readonly platform: "darwin" | "linux" | "win32";
  readonly architecture: string;
  readonly components: readonly NativeComponent[];
}

export interface NativeReleaseVerification {
  readonly manifestSha256: string;
  readonly publisherKeyId: string;
  readonly productVersion: string;
  readonly supportStatus:
    "internal-preview-blocked" | "internal-preview-complete" | "release-candidate";
}

export interface NativeReleaseVerifier {
  preflight(configuration: PlatformServiceConfiguration): Promise<NativeReleaseVerification>;
  verifyStaged(
    configuration: PlatformServiceConfiguration,
    stagingDirectory: string,
    expectedManifestSha256: string,
  ): Promise<void>;
}

export function createNativeReleaseVerifier(
  fileSystem: NativeFileSystemBoundary,
  options: {
    readonly architecture?: string;
  } = {},
): NativeReleaseVerifier {
  const architecture = options.architecture ?? process.arch;
  return {
    async preflight(configuration) {
      const validated = parsePlatformServiceConfiguration(configuration);
      const rootMetadata = await fileSystem.inspect(validated.bundle.sourceDirectory);
      if (rootMetadata.kind !== "directory") {
        failPreflight(
          "The release source must be a regular directory, not a link or special file.",
        );
      }
      const checksumBytes = await readRequiredRegularFile(
        fileSystem,
        pathJoin(validated.platform, validated.bundle.sourceDirectory, "SHA256SUMS"),
        MAXIMUM_MANIFEST_BYTES,
        "checksum manifest",
      );
      const manifestSha256 = sha256(checksumBytes);
      if (validated.bundle.checksum !== `sha256:${manifestSha256}`) {
        failPreflight(
          "The configured release checksum does not match the bundle checksum manifest.",
        );
      }
      const trustRoot = pathJoin(
        validated.platform,
        validated.paths.stateRoot,
        "trust",
        "publisher-ed25519.pem",
      );
      const attestationPath = `${validated.bundle.sourceDirectory}.publisher-attestation.json`;
      const [keyBytes, attestationBytes] = await Promise.all([
        readRequiredRegularFile(fileSystem, trustRoot, MAXIMUM_KEY_BYTES, "publisher trust root"),
        readRequiredRegularFile(
          fileSystem,
          attestationPath,
          MAXIMUM_ATTESTATION_BYTES,
          "detached publisher attestation",
        ),
      ]);
      const key = parsePublisherKey(keyBytes);
      const keyDer = key.export({ format: "der", type: "spki" });
      const keyId = `sha256:${sha256(Buffer.from(keyDer))}`;
      const attestation = parseAttestation(attestationBytes);
      if (
        attestation.manifestSha256 !== manifestSha256 ||
        attestation.keyId !== keyId ||
        !verifySignature(
          null,
          signatureInput(manifestSha256),
          key,
          Buffer.from(attestation.signature, "base64url"),
        )
      ) {
        failPreflight("The detached release publisher attestation is invalid.");
      }
      const payload = await verifyPayload(
        fileSystem,
        validated,
        validated.bundle.sourceDirectory,
        architecture,
      );
      if (sha256(payload.checksumBytes) !== manifestSha256) {
        failPreflight("The release checksum manifest changed after publisher verification.");
      }
      return {
        manifestSha256,
        publisherKeyId: keyId,
        productVersion: payload.productVersion,
        supportStatus: payload.supportStatus,
      };
    },

    async verifyStaged(configuration, stagingDirectory, expectedManifestSha256) {
      const payload = await verifyPayload(
        fileSystem,
        configuration,
        stagingDirectory,
        architecture,
      );
      if (sha256(payload.checksumBytes) !== expectedManifestSha256) {
        throw uncertain("The staged release no longer matches its trusted publisher attestation.");
      }
    },
  };
}

async function verifyPayload(
  fileSystem: NativeFileSystemBoundary,
  configuration: PlatformServiceConfiguration,
  root: string,
  expectedArchitecture: string,
): Promise<{
  readonly checksumBytes: Buffer;
  readonly productVersion: string;
  readonly supportStatus: NativeReleaseVerification["supportStatus"];
}> {
  const rootMetadata = await fileSystem.inspect(root);
  if (rootMetadata.kind !== "directory") {
    failPreflight("The release source must be a regular directory, not a link or special file.");
  }
  const rootRealPath = await fileSystem.realPath(root);
  const [checksumBytes, manifestBytes, metadataBytes, nativeComponentsBytes] = await Promise.all([
    readRequiredRegularFile(
      fileSystem,
      pathJoin(configuration.platform, root, "SHA256SUMS"),
      MAXIMUM_MANIFEST_BYTES,
      "checksum manifest",
    ),
    readRequiredRegularFile(
      fileSystem,
      pathJoin(configuration.platform, root, "payload-manifest.json"),
      MAXIMUM_MANIFEST_BYTES,
      "payload manifest",
    ),
    readRequiredRegularFile(
      fileSystem,
      pathJoin(configuration.platform, root, "release-metadata.json"),
      MAXIMUM_METADATA_BYTES,
      "release metadata",
    ),
    readRequiredRegularFile(
      fileSystem,
      pathJoin(configuration.platform, root, "native-components.json"),
      MAXIMUM_METADATA_BYTES,
      "native component manifest",
    ),
  ]);
  const checksums = parseChecksumManifest(checksumBytes);
  const payload = parsePayloadManifest(manifestBytes);
  if (checksums.get("payload-manifest.json") !== sha256(manifestBytes)) {
    failPreflight("SHA256SUMS does not bind payload-manifest.json.");
  }
  if (checksums.size !== payload.size + 1) {
    failPreflight("The checksum and payload manifests cover different file sets.");
  }
  for (const entry of payload.values()) {
    if (checksums.get(entry.path) !== entry.sha256) {
      failPreflight(`The release manifests disagree for ${entry.path}.`);
    }
  }

  const discovered = await listPayloadFiles(fileSystem, configuration.platform, root, rootRealPath);
  const expected = new Set([...payload.keys(), "SHA256SUMS", "payload-manifest.json"]);
  if (discovered.length !== expected.size || discovered.some((path) => !expected.has(path))) {
    failPreflight("The release contains an unlisted, missing, linked, or special payload path.");
  }
  const verifiedPayload = new Map<string, PayloadEntry>();
  for (const path of discovered) {
    if (path === "SHA256SUMS") {
      continue;
    }
    const bytes =
      path === "payload-manifest.json"
        ? manifestBytes
        : path === "release-metadata.json"
          ? metadataBytes
          : path === "native-components.json"
            ? nativeComponentsBytes
            : await readRequiredRegularFile(
                fileSystem,
                pathJoin(configuration.platform, root, ...path.split("/")),
                payload.get(path)?.size ?? 0,
                `payload file ${path}`,
              );
    if (path === "payload-manifest.json") {
      if (checksums.get(path) !== sha256(bytes)) {
        failPreflight("The checksum manifest does not bind payload-manifest.json.");
      }
      continue;
    }
    const entry = payload.get(path);
    const digest = sha256(bytes);
    if (
      entry === undefined ||
      bytes.length !== entry.size ||
      digest !== entry.sha256 ||
      checksums.get(path) !== digest
    ) {
      failPreflight(`The release payload digest is invalid for ${path}.`);
    }
    verifiedPayload.set(path, { path, size: bytes.length, sha256: digest });
  }

  createPlatformServiceDefinition(configuration);
  const executableSuffix = configuration.platform === "windows" ? ".exe" : "";
  const requiredExecutables = [
    `bin/opendelegate-service-host${executableSuffix}`,
    `bin/opendelegate-session-helper${executableSuffix}`,
  ];
  for (const path of requiredExecutables) {
    const entry = payload.get(path);
    if (entry === undefined || entry.size <= 0) {
      failPreflight(`The release payload is missing required service executable ${path}.`);
    }
  }

  const metadata = parseJsonRecord(metadataBytes, "release metadata");
  assertExactKeys(
    metadata,
    [
      "schemaVersion",
      "product",
      "productVersion",
      "protocolVersion",
      "buildId",
      "createdAt",
      "timestampPolicy",
      "platform",
      "architecture",
      "bundledNodeVersion",
      "bundledRuntime",
      "toolchain",
      "dependencyLockSha256",
      "sourcePackageManifestSha256",
      "runtimeExternals",
      "nativeComponents",
      "buildCommit",
      "auditedSourceCommit",
      "changedAttestationPaths",
      "buildSourceDirty",
      "supportStatus",
      "buildMode",
      "releaseEvidence",
      "entrypoints",
      "fileManifest",
      "checksumManifest",
    ],
    "release metadata",
  );
  const expectedPlatform =
    configuration.platform === "windows"
      ? "win32"
      : configuration.platform === "macos"
        ? "darwin"
        : "linux";
  const nativeComponents = parseNativeComponents(
    parseJsonRecord(nativeComponentsBytes, "native component manifest"),
    expectedPlatform,
    expectedArchitecture,
    "native component manifest",
  );
  const metadataNativeComponents = parseNativeComponents(
    metadata["nativeComponents"],
    expectedPlatform,
    expectedArchitecture,
    "release metadata nativeComponents",
  );
  if (JSON.stringify(metadataNativeComponents) !== JSON.stringify(nativeComponents)) {
    failPreflight("The release metadata nativeComponents does not match native-components.json.");
  }
  validateNativeComponentPayloadBindings(nativeComponents, payload, verifiedPayload);

  const productVersion = requireString(metadata["productVersion"], "product version");
  const supportStatus = metadata["supportStatus"];
  if (
    metadata["schemaVersion"] !== 2 ||
    metadata["product"] !== "OpenDelegate" ||
    metadata["protocolVersion"] !== "v1" ||
    metadata["platform"] !== expectedPlatform ||
    metadata["architecture"] !== expectedArchitecture ||
    metadata["bundledNodeVersion"] !== "24.18.0" ||
    metadata["fileManifest"] !== "payload-manifest.json" ||
    metadata["checksumManifest"] !== "SHA256SUMS" ||
    productVersion !== configuration.bundle.version ||
    !SEMVER_PATTERN.test(productVersion) ||
    (supportStatus !== "internal-preview-blocked" &&
      supportStatus !== "internal-preview-complete" &&
      supportStatus !== "release-candidate")
  ) {
    failPreflight("The release metadata does not match this Device service configuration.");
  }
  const expectedEntrypoints =
    configuration.platform === "windows"
      ? ["opendelegate.cmd", "opendelegate-worker.cmd"]
      : ["opendelegate", "opendelegate-worker", "opendelegate.cmd", "opendelegate-worker.cmd"];
  if (
    !Array.isArray(metadata["entrypoints"]) ||
    metadata["entrypoints"].length !== expectedEntrypoints.length ||
    metadata["entrypoints"].some((value, index) => value !== expectedEntrypoints[index])
  ) {
    failPreflight("The release metadata entrypoints do not match this platform.");
  }
  for (const path of expectedEntrypoints) {
    const entry = payload.get(path);
    const actual = verifiedPayload.get(path);
    if (
      entry === undefined ||
      entry.size <= 0 ||
      actual === undefined ||
      actual.size <= 0 ||
      entry.size !== actual.size ||
      entry.sha256 !== actual.sha256
    ) {
      failPreflight(`The release payload is missing required launcher ${path}.`);
    }
  }
  return {
    checksumBytes,
    productVersion,
    supportStatus,
  };
}

function parseNativeComponents(
  value: unknown,
  expectedPlatform: NativeComponentsManifest["platform"],
  expectedArchitecture: string,
  label: string,
): NativeComponentsManifest {
  const manifest = requireRecord(value, label);
  assertExactKeys(manifest, ["schemaVersion", "platform", "architecture", "components"], label);
  if (
    manifest["schemaVersion"] !== 1 ||
    manifest["platform"] !== expectedPlatform ||
    manifest["architecture"] !== expectedArchitecture ||
    !Array.isArray(manifest["components"])
  ) {
    failPreflight(`The ${label} does not match this Device platform.`);
  }
  const expectedComponents = expectedNativeComponents(expectedPlatform);
  if (manifest["components"].length !== expectedComponents.length) {
    failPreflight(`The ${label} does not contain the exact required native components.`);
  }
  const components = manifest["components"].map((value, index) => {
    const component = requireRecord(value, `${label} component`);
    assertExactKeys(component, ["kind", "path", "sha256"], `${label} component`);
    const expected = expectedComponents[index]!;
    if (
      component["kind"] !== expected.kind ||
      component["path"] !== expected.path ||
      typeof component["sha256"] !== "string" ||
      !QUALIFIED_SHA256_PATTERN.test(component["sha256"])
    ) {
      failPreflight(`The ${label} component order, path, or digest is invalid.`);
    }
    return {
      kind: expected.kind,
      path: expected.path,
      sha256: component["sha256"],
    };
  });
  return {
    schemaVersion: 1,
    platform: expectedPlatform,
    architecture: expectedArchitecture,
    components,
  };
}

function validateNativeComponentPayloadBindings(
  manifest: NativeComponentsManifest,
  payload: ReadonlyMap<string, PayloadEntry>,
  verifiedPayload: ReadonlyMap<string, PayloadEntry>,
): void {
  for (const component of manifest.components) {
    const entry = payload.get(component.path);
    const actual = verifiedPayload.get(component.path);
    if (
      entry === undefined ||
      actual === undefined ||
      component.sha256 !== `sha256:${entry.sha256}` ||
      component.sha256 !== `sha256:${actual.sha256}` ||
      entry.size !== actual.size
    ) {
      failPreflight(`The native component digest does not match the payload: ${component.path}.`);
    }
  }
}

function expectedNativeComponents(
  platform: NativeComponentsManifest["platform"],
): readonly { readonly kind: string; readonly path: string }[] {
  if (platform === "win32") {
    return [
      { kind: "core-service-host", path: "bin/opendelegate-service-host.exe" },
      { kind: "session-helper-host", path: "bin/opendelegate-session-helper.exe" },
      {
        kind: "computer-use-helper",
        path: "libexec/opendelegate-windows-computer-use-helper.exe",
      },
      {
        kind: "computer-use-fixture",
        path: "libexec/opendelegate-windows-computer-use-fixture.exe",
      },
    ];
  }
  if (platform === "darwin") {
    return [
      { kind: "core-service-host", path: "bin/opendelegate-service-host" },
      { kind: "session-helper-host", path: "bin/opendelegate-session-helper" },
      { kind: "computer-use-helper", path: "libexec/opendelegate-macos-computer-use" },
      {
        kind: "computer-use-fixture",
        path: "libexec/opendelegate-macos-computer-use-fixture",
      },
      {
        kind: "secret-store-helper",
        path: "runtime/native/opendelegate-keychain-helper",
      },
    ];
  }
  return [
    { kind: "core-service-host", path: "bin/opendelegate-service-host" },
    { kind: "session-helper-host", path: "bin/opendelegate-session-helper" },
    { kind: "computer-use-helper", path: "libexec/opendelegate-linux-computer-use" },
    {
      kind: "computer-use-fixture",
      path: "libexec/opendelegate-linux-computer-use-fixture",
    },
  ];
}

function parseChecksumManifest(bytes: Buffer): ReadonlyMap<string, string> {
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n")) {
    failPreflight("SHA256SUMS must end with a newline.");
  }
  const lines = text.slice(0, -1).split("\n");
  const entries = new Map<string, string>();
  let previous: string | undefined;
  for (const line of lines) {
    const match = /^([a-f0-9]{64}) {2}(.+)$/u.exec(line);
    if (match === null) {
      failPreflight("SHA256SUMS contains a malformed entry.");
    }
    const path = match[2]!;
    assertPortablePath(path);
    if (
      path === "SHA256SUMS" ||
      entries.has(path) ||
      (previous !== undefined && compareCodeUnits(previous, path) >= 0)
    ) {
      failPreflight("SHA256SUMS entries are duplicated or not canonically ordered.");
    }
    entries.set(path, match[1]!);
    previous = path;
  }
  if (entries.size === 0) {
    failPreflight("SHA256SUMS must not be empty.");
  }
  return entries;
}

function parsePayloadManifest(bytes: Buffer): ReadonlyMap<string, PayloadEntry> {
  const manifest = parseJsonRecord(bytes, "payload manifest");
  assertExactKeys(
    manifest,
    ["schemaVersion", "excludedSelfReferences", "fileCount", "totalBytes", "files"],
    "payload manifest",
  );
  if (
    manifest["schemaVersion"] !== 1 ||
    !Array.isArray(manifest["excludedSelfReferences"]) ||
    manifest["excludedSelfReferences"].length !== 2 ||
    manifest["excludedSelfReferences"][0] !== "SHA256SUMS" ||
    manifest["excludedSelfReferences"][1] !== "payload-manifest.json" ||
    !Array.isArray(manifest["files"])
  ) {
    failPreflight("The payload manifest header is invalid.");
  }
  const entries = new Map<string, PayloadEntry>();
  const caseFolded = new Map<string, string>();
  let totalBytes = 0;
  let previous: string | undefined;
  for (const value of manifest["files"]) {
    const entry = requireRecord(value, "payload entry");
    assertExactKeys(entry, ["path", "size", "sha256"], "payload entry");
    const path = requireString(entry["path"], "payload path");
    const size = entry["size"];
    const digest = entry["sha256"];
    assertPortablePath(path);
    const folded = path.normalize("NFC").toLowerCase();
    if (
      path === "SHA256SUMS" ||
      path === "payload-manifest.json" ||
      entries.has(path) ||
      caseFolded.has(folded) ||
      (previous !== undefined && compareCodeUnits(previous, path) >= 0) ||
      !Number.isSafeInteger(size) ||
      (size as number) < 0 ||
      typeof digest !== "string" ||
      !SHA256_PATTERN.test(digest)
    ) {
      failPreflight(`The payload manifest contains an invalid entry for ${path}.`);
    }
    entries.set(path, { path, size: size as number, sha256: digest });
    caseFolded.set(folded, path);
    totalBytes += size as number;
    if (!Number.isSafeInteger(totalBytes)) {
      failPreflight("The payload manifest total byte count is unsafe.");
    }
    previous = path;
  }
  if (manifest["fileCount"] !== entries.size || manifest["totalBytes"] !== totalBytes) {
    failPreflight("The payload manifest aggregate counts are invalid.");
  }
  return entries;
}

async function listPayloadFiles(
  fileSystem: NativeFileSystemBoundary,
  platform: PlatformFamily,
  root: string,
  rootRealPath: string,
): Promise<readonly string[]> {
  const files: string[] = [];
  const caseFolded = new Map<string, string>();
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    const realDirectory = await fileSystem.realPath(directory);
    if (
      !samePlatformPath(platform, realDirectory, rootRealPath) &&
      !isPlatformDescendant(platform, rootRealPath, realDirectory)
    ) {
      failPreflight("The release payload escaped its verified root through a path alias.");
    }
    for (const entry of await fileSystem.list(directory)) {
      const relative = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      assertPortablePath(relative);
      const folded = relative.normalize("NFC").toLowerCase();
      if (caseFolded.has(folded)) {
        failPreflight("The release payload contains case-colliding paths.");
      }
      caseFolded.set(folded, relative);
      if (entry.kind === "symbolic-link" || entry.kind === "special") {
        failPreflight("Release payloads may contain only regular files and directories.");
      }
      const absolute = pathJoin(platform, directory, entry.name);
      if (entry.kind === "directory") {
        await visit(absolute, relative);
      } else {
        const realFile = await fileSystem.realPath(absolute);
        if (!isPlatformDescendant(platform, rootRealPath, realFile)) {
          failPreflight("A release payload file escaped its verified root.");
        }
        files.push(relative);
      }
    }
  };
  await visit(root, "");
  return files.sort(compareCodeUnits);
}

function parseAttestation(bytes: Buffer): {
  readonly keyId: string;
  readonly manifestSha256: string;
  readonly signature: string;
} {
  const value = parseJsonRecord(bytes, "publisher attestation");
  assertExactKeys(
    value,
    ["schemaVersion", "product", "algorithm", "keyId", "manifestSha256", "signature"],
    "publisher attestation",
  );
  const keyId = requireString(value["keyId"], "publisher key ID");
  const manifestSha256 = requireString(value["manifestSha256"], "publisher manifest digest");
  const signature = requireString(value["signature"], "publisher signature");
  if (
    value["schemaVersion"] !== 1 ||
    value["product"] !== "OpenDelegate" ||
    value["algorithm"] !== "ed25519" ||
    !/^sha256:[a-f0-9]{64}$/u.test(keyId) ||
    !SHA256_PATTERN.test(manifestSha256) ||
    !BASE64_URL_PATTERN.test(signature)
  ) {
    failPreflight("The detached publisher attestation has invalid fields.");
  }
  return { keyId, manifestSha256, signature };
}

function parsePublisherKey(bytes: Buffer) {
  try {
    const key = createPublicKey(bytes);
    if (key.asymmetricKeyType !== "ed25519") {
      failPreflight("The publisher trust root must be an Ed25519 public key.");
    }
    return key;
  } catch (error) {
    if (error instanceof ServiceCommandExecutionError) {
      throw error;
    }
    throw new ServiceCommandExecutionError(
      "SERVICE_COMMAND_PREFLIGHT_FAILED",
      "The publisher trust root is unreadable or invalid.",
      false,
      { cause: error },
    );
  }
}

async function readRequiredRegularFile(
  fileSystem: NativeFileSystemBoundary,
  path: string,
  maximumBytes: number,
  label: string,
): Promise<Buffer> {
  try {
    return await fileSystem.read(path, maximumBytes);
  } catch (error) {
    throw new ServiceCommandExecutionError(
      "SERVICE_COMMAND_PREFLIGHT_FAILED",
      `The ${label} is missing, linked, oversized, or unstable.`,
      false,
      { cause: error },
    );
  }
}

function signatureInput(manifestSha256: string): Buffer {
  return Buffer.from(`OpenDelegate release manifest v1\n${manifestSha256}\n`, "utf8");
}

function parseJsonRecord(bytes: Buffer, label: string): Record<string, unknown> {
  try {
    return requireRecord(JSON.parse(bytes.toString("utf8")) as unknown, label);
  } catch (error) {
    if (error instanceof ServiceCommandExecutionError) {
      throw error;
    }
    throw new ServiceCommandExecutionError(
      "SERVICE_COMMAND_PREFLIGHT_FAILED",
      `The ${label} is not valid JSON.`,
      false,
      { cause: error },
    );
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    failPreflight(`The ${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    failPreflight(`The ${label} must be a non-empty string.`);
  }
  return value;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value);
  if (
    actual.length !== expected.length ||
    actual.some((key) => !expected.includes(key)) ||
    expected.some((key) => !Object.hasOwn(value, key))
  ) {
    failPreflight(`The ${label} fields do not match their strict schema.`);
  }
}

function assertPortablePath(path: string): void {
  const segments = path.split("/");
  if (
    path === "" ||
    path.startsWith("/") ||
    path.includes("\\") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    failPreflight("A release manifest contains an unsafe relative path.");
  }
}

function pathJoin(platform: PlatformFamily, ...parts: string[]): string {
  return platform === "windows" ? win32.join(...parts) : posix.join(...parts);
}

function samePlatformPath(platform: PlatformFamily, left: string, right: string): boolean {
  const path = platform === "windows" ? win32 : posix;
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return platform === "windows"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isPlatformDescendant(
  platform: PlatformFamily,
  parent: string,
  candidate: string,
): boolean {
  const path = platform === "windows" ? win32 : posix;
  const relative = path.relative(parent, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function failPreflight(message: string): never {
  throw new ServiceCommandExecutionError("SERVICE_COMMAND_PREFLIGHT_FAILED", message, false);
}

function uncertain(message: string): ServiceCommandExecutionError {
  return new ServiceCommandExecutionError("SERVICE_COMMAND_OUTCOME_UNCERTAIN", message, true);
}
