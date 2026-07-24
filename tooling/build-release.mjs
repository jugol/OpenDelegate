import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { auditReleaseEvidence, summarizeReleaseEvidence } from "./check-release-evidence.mjs";

const currentFile = fileURLToPath(import.meta.url);
const releaseToolRoot = resolve(dirname(currentFile), "..");
const releaseRunnerSourceEnvironment = "OPENDELEGATE_INTERNAL_RELEASE_SOURCE";
const releaseRunnerCommitEnvironment = "OPENDELEGATE_INTERNAL_RELEASE_COMMIT";
const configuredReleaseSource = process.env[releaseRunnerSourceEnvironment];
const expectedReleaseCommit = process.env[releaseRunnerCommitEnvironment];
const repositoryRoot =
  configuredReleaseSource === undefined ? releaseToolRoot : resolve(configuredReleaseSource);
export const REQUIRED_RELEASE_NODE_VERSION = "24.18.0";
export const PINNED_PNPM_VERSION = "11.15.1";
export const PINNED_PNPM_ARCHIVE_INTEGRITY =
  "sha512-gTULB+U8lTigLx8jA7QpD6LXvgTlbiqXDEzEtBfcdh3hlu2r1J1Vx9yVgNuBAHxEFD5OPX5GKzAA0jwlUSLQZQ==";
const pinnedPnpmArchiveUrl = `https://registry.npmjs.org/pnpm/-/pnpm-${PINNED_PNPM_VERSION}.tgz`;
const maximumPnpmArchiveBytes = 25 * 1024 * 1024;
const runningReleaseToolPaths = ["tooling/build-release.mjs", "tooling/check-release-evidence.mjs"];
const nodeDistributionRoot = `https://nodejs.org/dist/v${REQUIRED_RELEASE_NODE_VERSION}`;
const nodeShasumsUrl = `${nodeDistributionRoot}/SHASUMS256.txt`;
const officialRuntimeArchives = new Map([
  [
    "darwin-arm64",
    {
      filename: `node-v${REQUIRED_RELEASE_NODE_VERSION}-darwin-arm64.tar.gz`,
      sha256: "e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1",
    },
  ],
  [
    "darwin-x64",
    {
      filename: `node-v${REQUIRED_RELEASE_NODE_VERSION}-darwin-x64.tar.gz`,
      sha256: "dfd0dbd3e721503434df7b7205e719f61b3a3a31b2bcf9729b8b91fea240f080",
    },
  ],
  [
    "linux-arm64",
    {
      filename: `node-v${REQUIRED_RELEASE_NODE_VERSION}-linux-arm64.tar.gz`,
      sha256: "6b4484c2190274175df9aa8f28e2d758a819cb1c1fe6ab481e2f95b463ab8508",
    },
  ],
  [
    "linux-x64",
    {
      filename: `node-v${REQUIRED_RELEASE_NODE_VERSION}-linux-x64.tar.gz`,
      sha256: "783130984963db7ba9cbd01089eaf2c2efb055c7c1693c943174b967b3050cb8",
    },
  ],
  [
    "win32-arm64",
    {
      filename: `node-v${REQUIRED_RELEASE_NODE_VERSION}-win-arm64.zip`,
      sha256: "f274669adb93b1fd0fbf8f21fd078609e9dcc84333d4f2718d2dde3f9a161a01",
    },
  ],
  [
    "win32-x64",
    {
      filename: `node-v${REQUIRED_RELEASE_NODE_VERSION}-win-x64.zip`,
      sha256: "0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821",
    },
  ],
]);
const supportedPlatforms = new Set(["darwin", "linux", "win32"]);
const supportedArchitectures = new Set(["arm64", "x64"]);
const curatedRuntimeLicenseFiles = new Map([
  [
    "abstract-logging@2.0.1",
    {
      path: "docs/legal/runtime-license-overrides/abstract-logging-2.0.1-LICENSE.txt",
      source: "https://raw.githubusercontent.com/jsumners/abstract-logging/v2.0.1/Readme.md",
    },
  ],
]);
const acceptanceLedgerPath = "docs/release/acceptance-evidence.json";
const attestationEvidencePrefix = "docs/release/evidence/";
const fullGitCommitPattern = /^[0-9a-f]{40}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const regularFileMode = "100644";

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function officialRuntimeArchiveFor(platform, architecture) {
  const input = officialRuntimeArchives.get(`${platform}-${architecture}`);
  if (input === undefined) {
    throw new Error(`No audited Node.js runtime input exists for ${platform}-${architecture}.`);
  }
  return Object.freeze({
    ...input,
    shasumsUrl: nodeShasumsUrl,
    url: `${nodeDistributionRoot}/${input.filename}`,
  });
}

export function parseReleaseArguments(values) {
  let destination;
  let internalPreview = false;

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--internal-preview") {
      internalPreview = true;
      continue;
    }
    if (value === "--destination") {
      const candidate = values[index + 1];
      if (candidate === undefined || candidate.startsWith("--")) {
        throw new Error("--destination requires an absolute path.");
      }
      destination = candidate;
      index += 1;
      continue;
    }
    if (value === "--help" || value === "-h") {
      return { help: true, internalPreview: false };
    }
    throw new Error(`Unknown release-build option: ${String(value)}.`);
  }

  if (destination === undefined) {
    throw new Error("--destination is required.");
  }
  return { destination, help: false, internalPreview };
}

export function renderBundleReadme(
  supportStatus,
  summary,
  platform = process.platform,
  architecture = process.arch,
  productVersion,
) {
  assertProductVersion(productVersion);
  const preview = supportStatus.startsWith("internal-preview");
  const launcher = platform === "win32" ? "opendelegate.cmd" : "./opendelegate";
  const statusLabel = preview ? "unsupported internal preview" : "unpublished release candidate";
  const previewStep = preview
    ? "1. Read `INTERNAL_PREVIEW.md`. This bundle is unsupported and must not be published under a release tag.\n2."
    : "1. This candidate is not a supported release until it is promoted through the documented release channel.\n2.";

  return `# OpenDelegate ${productVersion} ${statusLabel}

This directory is a self-contained, platform-specific OpenDelegate bundle for
${platform}/${architecture}. It includes its audited Node.js runtime; do not install
pnpm or run source-checkout commands here.

## Start with an agent

${previewStep} Ask Codex, Claude, or another capable local agent to follow
   \`skills/opendelegate-init/SKILL.md\`.
3. Keep runtime state, databases, credentials, logs, and generated Artifacts outside
   this bundle.

For deterministic CLI inspection:

\`\`\`text
${launcher} help
${launcher} init
${launcher} status
\`\`\`

The acceptance ledger state recorded during assembly was:

- Implementation: ${formatCounts(summary.implementation)}
- Live proof: ${formatCounts(summary.liveProof)}

Verify \`SHA256SUMS\` against a digest obtained through a trusted publication channel
before relying on the payload. The enclosed manifest proves only internal
consistency, not publisher identity.

See \`docs/release/README.md\` for release semantics, \`SECURITY.md\` for private
vulnerability reporting, and \`THIRD_PARTY_NOTICES.json\` for the complete bundled
dependency legal inventory.
`;
}

export function validateReleaseDestination(sourceRoot, destination) {
  if (!isAbsolute(destination)) {
    throw new Error("The release destination must be an absolute path.");
  }
  const normalizedSource = resolve(sourceRoot);
  const normalizedDestination = resolve(destination);
  const pathFromSource = relative(normalizedSource, normalizedDestination);
  if (
    pathFromSource === "" ||
    (!isAbsolute(pathFromSource) &&
      pathFromSource !== ".." &&
      !pathFromSource.startsWith(`..${sep}`))
  ) {
    throw new Error("Release artifacts must be written outside the source checkout.");
  }
  return normalizedDestination;
}

export function validateReleaseDestinationName(destination, internalPreview) {
  if (internalPreview && !basename(destination).toLowerCase().includes("internal-preview")) {
    throw new Error("An internal-preview destination name must contain 'internal-preview'.");
  }
}

export function determineSupportStatus(summary, internalPreview) {
  if (summary.releaseStatus === "released") {
    throw new Error(
      "A released ledger requires a separately designed and verified promotion attestation.",
    );
  }
  if (
    (summary.complete && summary.releaseStatus !== "candidate") ||
    (!summary.complete && summary.releaseStatus !== "blocked")
  ) {
    throw new Error("Release evidence completeness and releaseStatus are inconsistent.");
  }
  if (summary.complete) {
    return internalPreview ? "internal-preview-complete" : "release-candidate";
  }
  if (!internalPreview) {
    throw new Error(
      "The first-milestone release gate is blocked. Use --internal-preview only for a clearly marked, unsupported validation bundle.",
    );
  }
  return "internal-preview-blocked";
}

export function collectShaBoundAttestationPaths(ledger) {
  const paths = new Set();
  const addProof = (proof) => {
    if (
      proof === null ||
      typeof proof !== "object" ||
      Array.isArray(proof) ||
      proof.sourceCommit !== ledger.sourceCommit ||
      !Array.isArray(proof.evidence)
    ) {
      return;
    }
    for (const reference of proof.evidence) {
      if (
        reference !== null &&
        typeof reference === "object" &&
        !Array.isArray(reference) &&
        typeof reference.path === "string" &&
        typeof reference.sha256 === "string" &&
        sha256Pattern.test(reference.sha256)
      ) {
        paths.add(reference.path);
      }
    }
  };

  for (const criterion of Array.isArray(ledger.criteria) ? ledger.criteria : []) {
    if (criterion === null || typeof criterion !== "object" || Array.isArray(criterion)) {
      continue;
    }
    const verification =
      criterion.verification !== null &&
      typeof criterion.verification === "object" &&
      !Array.isArray(criterion.verification)
        ? criterion.verification
        : undefined;
    if (criterion.implementationStatus === "verified") {
      addProof(verification?.implementation);
    }
    if (criterion.liveProofStatus === "verified") {
      addProof(verification?.liveProof);
    }
  }
  if (ledger.releaseStatus === "candidate" || ledger.releaseStatus === "released") {
    addProof(ledger.candidateAttestation);
  }
  return [...paths].sort(compareCodeUnits);
}

export function parseRawGitDiff(rawDiff) {
  if (rawDiff === "") {
    return [];
  }
  const fields = rawDiff.split("\0");
  if (fields.at(-1) === "") {
    fields.pop();
  }
  const entries = [];
  for (let index = 0; index < fields.length;) {
    const header = fields[index];
    index += 1;
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z])(\d{0,3})$/.exec(
      header ?? "",
    );
    if (match === null) {
      throw new Error("Git returned an invalid raw attestation diff.");
    }
    const status = match[5];
    const firstPath = fields[index];
    index += 1;
    if (firstPath === undefined || firstPath === "") {
      throw new Error("Git returned an attestation diff entry without a path.");
    }
    if (status === "R" || status === "C") {
      const secondPath = fields[index];
      index += 1;
      if (secondPath === undefined || secondPath === "") {
        throw new Error("Git returned a rename or copy without a destination path.");
      }
      entries.push({
        oldMode: match[1],
        newMode: match[2],
        oldObject: match[3],
        newObject: match[4],
        status,
        score: match[6],
        oldPath: firstPath,
        path: secondPath,
      });
      continue;
    }
    entries.push({
      oldMode: match[1],
      newMode: match[2],
      oldObject: match[3],
      newObject: match[4],
      status,
      score: match[6],
      path: firstPath,
    });
  }
  return entries;
}

export function validateReleaseAttestationDiff(ledger, entries) {
  const shaBoundPaths = new Set(collectShaBoundAttestationPaths(ledger));
  const changedPaths = new Set();
  let ledgerChanged = false;

  for (const entry of entries) {
    const status = entry.status;
    const path = entry.path;
    if (status === "R" || status === "C") {
      throw new Error(
        `Release attestation commits may not contain Git renames or copies: ${String(entry.oldPath)} -> ${String(path)}.`,
      );
    }
    if (status === "D") {
      throw new Error(`Release attestation commits may not delete files: ${String(path)}.`);
    }
    if (status === "T") {
      throw new Error(`Release attestation commits may not change file types: ${String(path)}.`);
    }
    if (status !== "A" && status !== "M") {
      throw new Error(
        `Release attestation commits may not contain Git status ${String(status)}: ${String(path)}.`,
      );
    }
    if (typeof path !== "string" || path === "" || path.includes("\\")) {
      throw new Error("Release attestation commits contain an invalid repository path.");
    }
    if (changedPaths.has(path)) {
      throw new Error(`Release attestation commits contain duplicate diff entries for ${path}.`);
    }
    changedPaths.add(path);

    if (path === acceptanceLedgerPath) {
      if (
        status !== "M" ||
        entry.oldMode !== regularFileMode ||
        entry.newMode !== regularFileMode
      ) {
        throw new Error(
          `${acceptanceLedgerPath} must remain a modified regular mode-${regularFileMode} file.`,
        );
      }
      ledgerChanged = true;
      continue;
    }

    if (!path.startsWith(attestationEvidencePrefix) || path === attestationEvidencePrefix) {
      throw new Error(
        `Release attestation commits may change only ${acceptanceLedgerPath} and SHA-bound files under ${attestationEvidencePrefix}: ${path}.`,
      );
    }
    if (!shaBoundPaths.has(path)) {
      throw new Error(
        `Release attestation file is not SHA-bound by criterion verification or candidateAttestation: ${path}.`,
      );
    }
    const validModes =
      entry.newMode === regularFileMode &&
      ((status === "A" && entry.oldMode === "000000") ||
        (status === "M" && entry.oldMode === regularFileMode));
    if (!validModes) {
      throw new Error(
        `Release attestation evidence must remain a regular mode-${regularFileMode} file: ${path}.`,
      );
    }
  }

  if (!ledgerChanged) {
    throw new Error(
      `The attestation commit must modify ${acceptanceLedgerPath} while preserving audited source commit A.`,
    );
  }
  return [...changedPaths].sort(compareCodeUnits);
}

export async function createChecksumManifest(root, excluded = new Set(["SHA256SUMS"])) {
  const entries = await createFileEntries(root, excluded);
  return `${entries.map((entry) => `${entry.sha256}  ${entry.path}`).join("\n")}\n`;
}

export async function createPayloadManifest(
  root,
  excluded = new Set(["SHA256SUMS", "payload-manifest.json"]),
) {
  const files = await createFileEntries(root, excluded);
  return {
    schemaVersion: 1,
    excludedSelfReferences: [...excluded].sort(compareCodeUnits),
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    files,
  };
}

export async function writeIntegrityManifests(root) {
  await writeFile(
    join(root, "payload-manifest.json"),
    `${JSON.stringify(await createPayloadManifest(root), null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(root, "SHA256SUMS"), await createChecksumManifest(root), "utf8");
}

export async function inspectReleaseCandidateProvenance(sourceRoot, ledger, source) {
  if (typeof ledger.sourceCommit !== "string" || !fullGitCommitPattern.test(ledger.sourceCommit)) {
    throw new Error("The audited source commit must be an exact 40-character lowercase Git SHA.");
  }
  if (typeof source.commit !== "string" || !fullGitCommitPattern.test(source.commit)) {
    throw new Error("The build commit must be an exact 40-character lowercase Git SHA.");
  }
  if (source.dirty) {
    throw new Error("A supported release candidate must be built from a clean Git checkout.");
  }
  if (ledger.sourceCommit === source.commit) {
    throw new Error(
      "A release candidate must be built from a distinct attestation commit B after audited source commit A.",
    );
  }

  await assertGitCommitExists(sourceRoot, ledger.sourceCommit, "audited source commit A");
  await assertGitCommitExists(sourceRoot, source.commit, "build commit B");
  try {
    await runProvenanceGit(
      ["merge-base", "--is-ancestor", ledger.sourceCommit, source.commit],
      sourceRoot,
      { capture: true },
    );
  } catch (error) {
    throw new Error(
      "The audited source commit A must be an ancestor of release attestation commit B.",
      { cause: error },
    );
  }

  const rawDiff = (
    await runProvenanceGit(
      [
        "diff",
        "--raw",
        "--no-abbrev",
        "--no-ext-diff",
        "--find-renames",
        "--find-copies",
        "--find-copies-harder",
        "-z",
        ledger.sourceCommit,
        source.commit,
        "--",
      ],
      sourceRoot,
      { capture: true },
    )
  ).stdout;
  return {
    auditedSourceCommit: ledger.sourceCommit,
    buildCommit: source.commit,
    changedAttestationPaths: validateReleaseAttestationDiff(ledger, parseRawGitDiff(rawDiff)),
  };
}

export async function createCommittedSourceSnapshot(sourceRoot, commit, parent) {
  if (!fullGitCommitPattern.test(commit)) {
    throw new Error(
      "A committed source snapshot requires an exact 40-character lowercase Git SHA.",
    );
  }
  const snapshot = await mkdtemp(join(parent, ".od-committed-source-"));
  const archivePath = join(parent, `.od-source-${process.pid}-${randomUUID().slice(0, 8)}.tar`);
  try {
    await runProvenanceGit(["archive", "--format=tar", "-o", archivePath, commit], sourceRoot, {
      capture: true,
    });
    await runCommand("tar", ["-xf", archivePath, "-C", snapshot], sourceRoot, {
      capture: true,
    });
    return snapshot;
  } catch (error) {
    await rm(snapshot, { force: true, recursive: true });
    throw error;
  } finally {
    await rm(archivePath, { force: true });
  }
}

export async function withCommittedSourceSnapshot(sourceRoot, commit, parent, operation) {
  const snapshot = await createCommittedSourceSnapshot(sourceRoot, commit, parent);
  try {
    return await operation(snapshot);
  } finally {
    await rm(snapshot, { force: true, recursive: true });
  }
}

export async function verifyRunningReleaseToolFiles(
  sourceRoot,
  commit,
  paths = runningReleaseToolPaths,
  runningRoot = sourceRoot,
) {
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error("A running release-tool verification requires a full Git commit ID.");
  }
  for (const path of paths) {
    const segments = path.split("/");
    if (
      !/^[A-Za-z0-9._/-]+$/u.test(path) ||
      segments.some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      throw new Error("A running release-tool path is not a safe repository-relative path.");
    }
    const [runningBytes, committed] = await Promise.all([
      readFile(join(runningRoot, ...segments), "utf8"),
      runProvenanceGit(["show", `${commit}:${path}`], sourceRoot, { capture: true }),
    ]);
    if (runningBytes !== committed.stdout) {
      throw new Error(
        `The running release tool does not match captured build commit ${commit}: ${path}.`,
      );
    }
  }
}

export function verifyPinnedPnpmArchive(archive) {
  if (!(archive instanceof Uint8Array) || archive.byteLength > maximumPnpmArchiveBytes) {
    throw new Error("The pinned pnpm archive is missing or exceeds its byte limit.");
  }
  const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
  if (integrity !== PINNED_PNPM_ARCHIVE_INTEGRITY) {
    throw new Error("The pnpm archive hash did not match the audited official input.");
  }
}

export async function readBoundedResponseBody(response, maximumBytes) {
  if (
    response?.body === null ||
    response?.body === undefined ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes <= 0
  ) {
    throw new Error("The package-manager response has no bounded readable body.");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        return Buffer.concat(chunks, length);
      }
      const chunk = Buffer.from(result.value);
      length += chunk.byteLength;
      if (length > maximumBytes) {
        await reader.cancel("OpenDelegate package-manager archive limit exceeded.");
        throw new Error("The pnpm archive exceeds its byte limit.");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
}

export async function withPinnedPnpm(parent, operation) {
  const directory = await mkdtemp(join(parent, ".od-pnpm-bootstrap-"));
  const archivePath = join(directory, `pnpm-${PINNED_PNPM_VERSION}.tgz`);
  try {
    const response = await fetch(pinnedPnpmArchiveUrl, {
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) {
      throw new Error(`Could not retrieve the pinned pnpm archive (${response.status}).`);
    }
    const declaredLengthHeader = response.headers.get("content-length");
    if (declaredLengthHeader !== null) {
      const declaredLength = Number(declaredLengthHeader);
      if (
        !Number.isSafeInteger(declaredLength) ||
        declaredLength < 0 ||
        declaredLength > maximumPnpmArchiveBytes
      ) {
        throw new Error("The pinned pnpm archive has an invalid or excessive content length.");
      }
    }
    const archive = await readBoundedResponseBody(response, maximumPnpmArchiveBytes);
    verifyPinnedPnpmArchive(archive);
    await writeFile(archivePath, archive);
    await runCommand("tar", ["-xf", archivePath, "-C", directory], parent, { capture: true });

    const packageRoot = join(directory, "package");
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    if (manifest.name !== "pnpm" || manifest.version !== PINNED_PNPM_VERSION) {
      throw new Error("The verified pnpm archive contains unexpected package metadata.");
    }
    await assertPortableTree(packageRoot);
    const cli = join(packageRoot, "bin", "pnpm.cjs");
    const cliMetadata = await lstat(cli);
    if (!cliMetadata.isFile() || cliMetadata.isSymbolicLink()) {
      throw new Error("The verified pnpm archive has no regular CLI entrypoint.");
    }
    return await operation(cli);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function readProductManifest(sourceRoot) {
  const manifest = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
  assertProductVersion(manifest.version);
  if (
    manifest.packageManager !== `pnpm@${PINNED_PNPM_VERSION}` ||
    manifest.devDependencies?.pnpm !== PINNED_PNPM_VERSION ||
    typeof manifest.devDependencies?.esbuild !== "string"
  ) {
    throw new Error("The committed product manifest does not match the pinned release toolchain.");
  }
  return manifest;
}

function assertProductVersion(productVersion) {
  if (
    typeof productVersion !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(productVersion)
  ) {
    throw new Error("The root package has no valid semantic product version.");
  }
}

async function createFileEntries(root, excluded) {
  const files = await listFiles(root);
  const entries = [];
  for (const path of files) {
    const pathFromRoot = relative(root, path).split(sep).join("/");
    if (excluded.has(pathFromRoot)) {
      continue;
    }
    const bytes = await readFile(path);
    entries.push({
      path: pathFromRoot,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return entries;
}

export async function buildRelease(options) {
  assertReleaseHost();
  const source = await readSourceIdentity();
  assertCleanBundleSource(source);
  await assertCommittedReleaseRunner(source);

  const lexicalDestination = validateReleaseDestination(repositoryRoot, options.destination);
  validateReleaseDestinationName(lexicalDestination, options.internalPreview);
  const destination = await validateProspectiveDestination(repositoryRoot, lexicalDestination);
  await assertPathAbsent(destination);

  const ledgerPath = join(repositoryRoot, "docs", "release", "acceptance-evidence.json");
  const ledgerText = await readFile(ledgerPath, "utf8");
  const ledger = JSON.parse(ledgerText);
  const ledgerErrors = await auditReleaseEvidence(repositoryRoot, ledger);
  if (ledgerErrors.length > 0) {
    throw new Error(`Release evidence is invalid:\n${ledgerErrors.join("\n")}`);
  }
  const summary = summarizeReleaseEvidence(ledger);
  const supportStatus = determineSupportStatus(summary, options.internalPreview);
  const provenance =
    supportStatus === "release-candidate"
      ? await inspectReleaseCandidateProvenance(repositoryRoot, ledger, source)
      : {
          auditedSourceCommit: ledger.sourceCommit,
          buildCommit: source.commit,
          changedAttestationPaths: null,
        };

  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  const staging = join(parent, `.od-${process.pid}-${randomUUID().slice(0, 8)}`);
  await mkdir(staging);

  try {
    await withPinnedPnpm(parent, async (bootstrapPnpmCli) => {
      await withCommittedSourceSnapshot(
        repositoryRoot,
        source.commit,
        parent,
        async (assemblySourceRoot) => {
          const snapshotLedger = await readFile(
            join(assemblySourceRoot, "docs", "release", "acceptance-evidence.json"),
            "utf8",
          );
          const snapshotLedgerObject = JSON.parse(snapshotLedger);
          if (JSON.stringify(snapshotLedgerObject) !== JSON.stringify(ledger)) {
            throw new Error(
              "The committed build snapshot does not contain the validated release ledger.",
            );
          }
          const snapshotLedgerErrors = await auditReleaseEvidence(
            assemblySourceRoot,
            snapshotLedgerObject,
          );
          if (snapshotLedgerErrors.length > 0) {
            throw new Error(
              `Committed build snapshot evidence is invalid:\n${snapshotLedgerErrors.join("\n")}`,
            );
          }
          const productManifest = await readProductManifest(assemblySourceRoot);
          await runCommand("pnpm", ["install", "--frozen-lockfile"], assemblySourceRoot, {
            pnpmCli: bootstrapPnpmCli,
          });
          await assembleRelease({
            assemblySourceRoot,
            ledger,
            ledgerDigest: createHash("sha256").update(snapshotLedger).digest("hex"),
            productManifest,
            productVersion: productManifest.version,
            provenance,
            source,
            staging,
            summary,
            supportStatus,
          });
        },
      );
    });

    const finalSource = await readSourceIdentity();
    if (finalSource.dirty || finalSource.commit !== source.commit) {
      throw new Error("The source checkout changed while the bundle was assembled.");
    }
    if (supportStatus === "release-candidate") {
      const finalProvenance = await inspectReleaseCandidateProvenance(
        repositoryRoot,
        ledger,
        finalSource,
      );
      if (JSON.stringify(finalProvenance) !== JSON.stringify(provenance)) {
        throw new Error(
          "Release provenance changed while the supported release candidate was assembled.",
        );
      }
    }
    await rename(staging, destination);
  } catch (error) {
    await rm(staging, { force: true, recursive: true });
    throw error;
  }

  return {
    destination,
    supportStatus,
    source,
    provenance,
    summary,
  };
}

async function assertCommittedReleaseRunner(source) {
  if (
    configuredReleaseSource === undefined ||
    !isAbsolute(configuredReleaseSource) ||
    expectedReleaseCommit === undefined ||
    !/^[0-9a-f]{40}$/u.test(expectedReleaseCommit)
  ) {
    throw new Error(
      "Release assembly must execute through the committed-source CLI runner snapshot.",
    );
  }
  if (source.commit !== expectedReleaseCommit) {
    throw new Error("The source checkout changed before the committed release runner started.");
  }
  const [canonicalSource, canonicalToolRoot] = await Promise.all([
    realpath(repositoryRoot),
    realpath(releaseToolRoot),
  ]);
  validateReleaseDestination(canonicalSource, canonicalToolRoot);
  await verifyRunningReleaseToolFiles(
    canonicalSource,
    source.commit,
    runningReleaseToolPaths,
    canonicalToolRoot,
  );
}

export function assertCleanBundleSource(source) {
  if (source.dirty) {
    throw new Error(
      "Release bundles require a clean committed checkout so assembly can run in an isolated snapshot.",
    );
  }
}

async function validateProspectiveDestination(sourceRoot, destination) {
  const [canonicalSource, canonicalDestination] = await Promise.all([
    realpath(sourceRoot),
    canonicalizeProspectivePath(destination),
  ]);
  return validateReleaseDestination(canonicalSource, canonicalDestination);
}

async function canonicalizeProspectivePath(path) {
  const missingSegments = [];
  let cursor = path;
  for (;;) {
    try {
      const existing = await realpath(cursor);
      return resolve(existing, ...missingSegments);
    } catch (error) {
      if (error === null || typeof error !== "object" || error.code !== "ENOENT") {
        throw error;
      }
      const parent = dirname(cursor);
      if (parent === cursor) {
        throw new Error("The release destination has no resolvable parent.", {
          cause: error,
        });
      }
      missingSegments.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

async function assembleRelease({
  assemblySourceRoot,
  ledger,
  ledgerDigest,
  productManifest,
  productVersion,
  provenance,
  source,
  staging,
  summary,
  supportStatus,
}) {
  const assemblyRequire = createRequire(join(assemblySourceRoot, "package.json"));
  const assemblyPnpmCli = join(dirname(assemblyRequire.resolve("pnpm")), "bin", "pnpm.cjs");
  const { build: bundle } = assemblyRequire("esbuild");
  await runCommand("pnpm", ["--filter", "@opendelegate/admin-web", "build"], assemblySourceRoot, {
    pnpmCli: assemblyPnpmCli,
  });

  const mainDirectory = join(staging, "apps", "main");
  await mkdir(mainDirectory, { recursive: true });
  await runCommand("pnpm", createMainDeployArguments(mainDirectory), assemblySourceRoot, {
    pnpmCli: assemblyPnpmCli,
  });
  await removePackageManagerBinDirectories(join(mainDirectory, "node_modules"));

  await bundle({
    absWorkingDir: assemblySourceRoot,
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    bundle: true,
    entryPoints: ["apps/main/src/cli.ts"],
    external: ["@node-rs/argon2", "@node-rs/argon2-*", "better-sqlite3", "pg"],
    format: "esm",
    logLevel: "info",
    outfile: join(mainDirectory, "opendelegate.mjs"),
    platform: "node",
    target: "node24.18",
  });

  const adminTarget = join(staging, "apps", "admin-web", "dist");
  await mkdir(dirname(adminTarget), { recursive: true });
  await cp(join(assemblySourceRoot, "apps", "admin-web", "dist"), adminTarget, {
    recursive: true,
  });

  await copyReleaseMaterials(staging, assemblySourceRoot);
  const runtimeProvenance = await copyRuntime(staging, assemblySourceRoot);
  await writeThirdPartyNotices(staging, mainDirectory, assemblySourceRoot);
  await writeFile(
    join(staging, "README.md"),
    renderBundleReadme(supportStatus, summary, process.platform, process.arch, productVersion),
    "utf8",
  );

  const buildId = createBuildId(source, supportStatus);
  await writeLaunchers(staging);
  await assertPortableTree(staging);

  const metadata = {
    schemaVersion: 2,
    product: "OpenDelegate",
    productVersion,
    protocolVersion: "v1",
    buildId,
    createdAt: buildTimestamp(source, supportStatus),
    timestampPolicy:
      process.env["SOURCE_DATE_EPOCH"] !== undefined
        ? "source-date-epoch"
        : supportStatus === "release-candidate"
          ? "source-commit"
          : "wall-clock",
    platform: process.platform,
    architecture: process.arch,
    bundledNodeVersion: process.versions.node,
    bundledRuntime: runtimeProvenance,
    toolchain: {
      packageManager: productManifest.packageManager,
      bundler: `esbuild@${String(productManifest.devDependencies?.esbuild)}`,
    },
    dependencyLockSha256: await sha256File(join(assemblySourceRoot, "pnpm-lock.yaml")),
    sourcePackageManifestSha256: await sha256File(join(assemblySourceRoot, "package.json")),
    runtimeExternals: await readRuntimeExternalVersions(assemblySourceRoot),
    buildCommit: provenance.buildCommit,
    auditedSourceCommit: provenance.auditedSourceCommit,
    changedAttestationPaths: provenance.changedAttestationPaths,
    buildSourceDirty: source.dirty,
    supportStatus,
    buildMode: supportStatus.startsWith("internal-preview")
      ? "internal-preview"
      : "release-candidate",
    releaseEvidence: {
      auditedAt: ledger.auditedAt,
      releaseStatus: ledger.releaseStatus,
      sha256: ledgerDigest,
      implementation: summary.implementation,
      liveProof: summary.liveProof,
      complete: summary.complete,
    },
    entrypoints:
      process.platform === "win32" ? ["opendelegate.cmd"] : ["opendelegate", "opendelegate.cmd"],
    fileManifest: "payload-manifest.json",
    checksumManifest: "SHA256SUMS",
  };
  await writeFile(
    join(staging, "release-metadata.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );

  if (supportStatus.startsWith("internal-preview")) {
    await writeFile(
      join(staging, "INTERNAL_PREVIEW.md"),
      `# Unsupported OpenDelegate internal preview

This bundle is for installation and integration testing only. It is **not** a
supported OpenDelegate release and must not be published under a release tag.

The canonical acceptance ledger state when this bundle was built was:

- Implementation: ${formatCounts(summary.implementation)}
- Live proof: ${formatCounts(summary.liveProof)}

Run \`opendelegate help\` for the deterministic CLI surface. Review
\`docs/release/README.md\` and \`docs/release/PLATFORM_LAB.md\` before testing.
`,
      "utf8",
    );
  }

  await writeIntegrityManifests(staging);
  const smokeEvidence = await smokeBundle(staging, buildId, productVersion);
  await writeFile(
    join(staging, "smoke-evidence.json"),
    `${JSON.stringify(smokeEvidence, null, 2)}\n`,
    "utf8",
  );
  await writeIntegrityManifests(staging);
}

export function createMainDeployArguments(mainDirectory) {
  return [
    "--config.node-linker=hoisted",
    "--filter",
    "@opendelegate/main",
    "deploy",
    "--legacy",
    "--prod",
    mainDirectory,
  ];
}

export async function removePackageManagerBinDirectories(root) {
  await removePackageManagerBinsFromTree(root, basename(root) === "node_modules");
}

async function removePackageManagerBinsFromTree(root, rootIsNodeModules) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (rootIsNodeModules && entry.name === ".bin") {
      await rm(path, { force: true, recursive: true });
      continue;
    }
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await removePackageManagerBinsFromTree(path, entry.name === "node_modules");
    }
  }
}

async function readRuntimeExternalVersions(sourceRoot) {
  const manifest = JSON.parse(
    await readFile(join(sourceRoot, "apps", "main", "package.json"), "utf8"),
  );
  const dependencies = manifest.dependencies ?? {};
  return ["@node-rs/argon2", "better-sqlite3", "pg"].map((name) => ({
    name,
    version: String(dependencies[name]),
  }));
}

export async function assertPortableTree(root) {
  const entries = await listTreeEntries(root);
  for (const path of entries) {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new Error(
        `The release payload contains an unsupported symbolic link or junction: ${relative(root, path)}.`,
      );
    }
    if (!metadata.isDirectory() && !metadata.isFile()) {
      throw new Error(
        `The release payload contains an unsupported special file: ${relative(root, path)}.`,
      );
    }
  }
}

async function copyReleaseMaterials(staging, sourceRoot) {
  for (const file of ["AGENTS.md", "CHANGELOG.md", "CONTEXT.md", "LICENSE", "SECURITY.md"]) {
    await copyFile(join(sourceRoot, file), join(staging, file));
  }
  await cp(join(sourceRoot, "docs"), join(staging, "docs"), { recursive: true });
  await cp(
    join(sourceRoot, "skills", "opendelegate-init"),
    join(staging, "skills", "opendelegate-init"),
    { recursive: true },
  );
}

async function copyRuntime(staging, sourceRoot) {
  const input = officialRuntimeArchiveFor(process.platform, process.arch);
  const runtimeDirectory = join(staging, "runtime");
  await mkdir(runtimeDirectory, { recursive: true });
  const extractionRoot = await mkdtemp(join(staging, ".node-runtime-"));
  const archivePath = join(extractionRoot, input.filename);
  try {
    const response = await fetch(input.url, {
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) {
      throw new Error(`Could not retrieve the pinned Node.js archive (${response.status}).`);
    }
    const archive = Buffer.from(await response.arrayBuffer());
    const archiveSha256 = createHash("sha256").update(archive).digest("hex");
    if (archiveSha256 !== input.sha256) {
      throw new Error("The Node.js archive hash did not match the audited official input.");
    }
    await writeFile(archivePath, archive);
    await runCommand("tar", ["-xf", archivePath, "-C", extractionRoot], sourceRoot, {
      capture: true,
    });

    const extractedRoot = join(extractionRoot, input.filename.replace(/\.(?:tar\.gz|zip)$/, ""));
    const extractedExecutable =
      process.platform === "win32"
        ? join(extractedRoot, "node.exe")
        : join(extractedRoot, "bin", "node");
    const extractedLicense = join(extractedRoot, "LICENSE");
    const executableName = process.platform === "win32" ? "node.exe" : "node";
    const destination = join(runtimeDirectory, executableName);
    const [executableSha256, actualLicenseHash] = await Promise.all([
      sha256File(extractedExecutable),
      sha256File(extractedLicense),
    ]);
    await Promise.all([
      copyFile(extractedExecutable, destination),
      copyFile(extractedLicense, join(runtimeDirectory, "LICENSE")),
    ]);
    if (process.platform !== "win32") {
      await chmod(destination, 0o755);
    }
    await writeFile(
      join(runtimeDirectory, "NOTICE.md"),
      `# Bundled runtime

This platform bundle contains Node.js ${process.versions.node}. Node.js is distributed
under its own license and includes third-party software. The complete license and
notices for this exact runtime are stored next to this file as \`LICENSE\`. The
archive was downloaded from the official Node.js distribution endpoint and verified
against an audited SHA-256 value published in:

${input.shasumsUrl}
`,
      "utf8",
    );
    return {
      source: "official-nodejs-distribution",
      archive: input.filename,
      archiveUrl: input.url,
      archiveSha256,
      shasumsUrl: input.shasumsUrl,
      executableSha256,
      licenseSha256: actualLicenseHash,
    };
  } finally {
    await rm(extractionRoot, { force: true, recursive: true });
  }
}

export async function writeThirdPartyNotices(staging, mainDirectory, sourceRoot = repositoryRoot) {
  const packages = [];
  const nodeModules = join(mainDirectory, "node_modules");
  for (const packageDirectory of await listRuntimePackageDirectories(nodeModules)) {
    await addPackageNotice(packages, packageDirectory, staging);
  }
  const adminManifestPath = join(sourceRoot, "apps", "admin-web", "package.json");
  for (const packageDirectory of await listProductionPackageDirectories(adminManifestPath)) {
    await addPackageNotice(packages, packageDirectory, staging, {
      bundledForm: "compiled-admin-asset",
      copiedLegalFilesRoot: join(staging, "licenses", "admin-web"),
      packagePath: "apps/admin-web/dist",
    });
  }
  resolvePackageLegalFiles(packages);
  packages.sort(
    (left, right) =>
      compareCodeUnits(left.name, right.name) ||
      compareCodeUnits(left.version, right.version) ||
      compareCodeUnits(left.packagePath, right.packagePath),
  );
  await writeFile(
    join(staging, "THIRD_PARTY_NOTICES.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        bundledRuntime: {
          name: "Node.js",
          version: process.versions.node,
          licenseFile: "runtime/LICENSE",
        },
        packages,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

export async function listProductionPackageDirectories(manifestPath) {
  const packageDirectories = [];
  const visitedPackageDirectories = new Set();

  const visitManifest = async (currentManifestPath) => {
    const manifest = JSON.parse(await readFile(currentManifestPath, "utf8"));
    const requiredDependencies = readDependencyNames(
      manifest.dependencies,
      "dependencies",
      currentManifestPath,
    );
    const optionalDependencies = new Set(
      readDependencyNames(
        manifest.optionalDependencies,
        "optionalDependencies",
        currentManifestPath,
      ),
    );
    const dependencyNames = [...new Set([...requiredDependencies, ...optionalDependencies])].sort(
      compareCodeUnits,
    );

    for (const dependencyName of dependencyNames) {
      const dependencyManifestPath = await resolveDependencyManifest(
        currentManifestPath,
        dependencyName,
        optionalDependencies.has(dependencyName),
      );
      if (dependencyManifestPath === undefined) {
        continue;
      }
      const packageDirectory = await realpath(dirname(dependencyManifestPath));
      if (visitedPackageDirectories.has(packageDirectory)) {
        continue;
      }
      visitedPackageDirectories.add(packageDirectory);
      packageDirectories.push(packageDirectory);
      await visitManifest(join(packageDirectory, "package.json"));
    }
  };

  await visitManifest(resolve(manifestPath));
  return packageDirectories;
}

function readDependencyNames(value, field, manifestPath) {
  if (value === undefined) {
    return [];
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} in ${manifestPath} must be an object.`);
  }
  return Object.keys(value);
}

async function resolveDependencyManifest(importerManifestPath, dependencyName, optional) {
  assertPackageDependencyName(dependencyName, importerManifestPath);
  const packageRequire = createRequire(importerManifestPath);
  try {
    return packageRequire.resolve(`${dependencyName}/package.json`);
  } catch {
    const discoveredManifest = await findDependencyManifest(importerManifestPath, dependencyName);
    if (discoveredManifest !== undefined) {
      return discoveredManifest;
    }
    try {
      const entryPath = packageRequire.resolve(dependencyName);
      const owningManifest = await findOwningPackageManifest(entryPath, dependencyName);
      if (owningManifest !== undefined) {
        return owningManifest;
      }
    } catch {
      // The explicit optional-dependency behavior below owns missing-package handling.
    }
  }
  if (optional) {
    return undefined;
  }
  throw new Error(
    `Production dependency ${dependencyName} declared by ${importerManifestPath} is not installed.`,
  );
}

function assertPackageDependencyName(dependencyName, importerManifestPath) {
  const segments = dependencyName.split("/");
  const validShape =
    !dependencyName.includes("\\") &&
    ((segments.length === 1 && !dependencyName.startsWith("@")) ||
      (segments.length === 2 && segments[0]?.startsWith("@")));
  if (
    !validShape ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(
      `Invalid production dependency name ${dependencyName} in ${importerManifestPath}.`,
    );
  }
}

async function findDependencyManifest(importerManifestPath, dependencyName) {
  const dependencySegments = dependencyName.split("/");
  let cursor = dirname(importerManifestPath);
  while (true) {
    const candidate = join(cursor, "node_modules", ...dependencySegments, "package.json");
    if (await isRegularFile(candidate)) {
      return candidate;
    }
    const parent = dirname(cursor);
    if (parent === cursor) {
      return undefined;
    }
    cursor = parent;
  }
}

async function findOwningPackageManifest(entryPath, dependencyName) {
  let cursor = dirname(entryPath);
  while (true) {
    const candidate = join(cursor, "package.json");
    if (await isRegularFile(candidate)) {
      const manifest = JSON.parse(await readFile(candidate, "utf8"));
      if (manifest.name === dependencyName) {
        return candidate;
      }
    }
    const parent = dirname(cursor);
    if (parent === cursor) {
      return undefined;
    }
    cursor = parent;
  }
}

async function isRegularFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return false;
    }
    throw error;
  }
}

export function resolvePackageLegalFiles(packages) {
  const unresolved = [];
  for (const packageEntry of packages) {
    if (packageEntry.legalFiles.length > 0) {
      continue;
    }
    const source = packages.find(
      (candidate) =>
        candidate !== packageEntry &&
        candidate.legalFiles.length > 0 &&
        candidate.license === packageEntry.license &&
        candidate.repositoryUrl !== undefined &&
        candidate.repositoryUrl === packageEntry.repositoryUrl,
    );
    if (source === undefined) {
      unresolved.push(`${packageEntry.name}@${packageEntry.version}`);
      continue;
    }
    packageEntry.legalFiles = source.legalFiles.map((entry) => ({ ...entry }));
    packageEntry.legalFilesSource = {
      name: source.name,
      version: source.version,
      packagePath: source.packagePath,
    };
  }
  if (unresolved.length > 0) {
    throw new Error(
      `Bundled packages have no retained license or notice file and no same-project license source: ${unresolved.join(", ")}.`,
    );
  }
}

async function listRuntimePackageDirectories(nodeModules) {
  const packages = [];
  const visitNodeModules = async (directory) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error !== null && typeof error === "object" && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".bin" || entry.name === ".pnpm") {
        continue;
      }
      if (entry.name.startsWith("@")) {
        const scopeDirectory = join(directory, entry.name);
        for (const scopedEntry of await readdir(scopeDirectory, { withFileTypes: true })) {
          if (scopedEntry.isDirectory()) {
            const packageDirectory = join(scopeDirectory, scopedEntry.name);
            packages.push(packageDirectory);
            await visitNodeModules(join(packageDirectory, "node_modules"));
          }
        }
        continue;
      }
      const packageDirectory = join(directory, entry.name);
      packages.push(packageDirectory);
      await visitNodeModules(join(packageDirectory, "node_modules"));
    }
  };
  await visitNodeModules(nodeModules);
  return packages;
}

async function addPackageNotice(packages, packageDirectory, staging, options = {}) {
  const manifestPath = join(packageDirectory, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    typeof manifest.name !== "string" ||
    manifest.name.startsWith("@opendelegate/") ||
    typeof manifest.version !== "string"
  ) {
    return;
  }
  const legalFiles = [];
  for (const entry of await readdir(packageDirectory, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    const path = join(packageDirectory, entry.name);
    const isNamedLegalFile = /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/iu.test(entry.name);
    const isReadmeWithLicense =
      /^readme(?:[._-].*)?$/iu.test(entry.name) && (await containsCompleteLicenseText(path));
    if (isNamedLegalFile || isReadmeWithLicense) {
      const retainedPath =
        options.copiedLegalFilesRoot === undefined
          ? path
          : join(
              options.copiedLegalFilesRoot,
              legalDirectoryName(manifest.name, manifest.version),
              entry.name,
            );
      if (options.copiedLegalFilesRoot !== undefined) {
        await mkdir(dirname(retainedPath), { recursive: true });
        if (await isRegularFile(retainedPath)) {
          if ((await sha256File(path)) !== (await sha256File(retainedPath))) {
            throw new Error(
              `Conflicting retained legal files exist for ${manifest.name}@${manifest.version}: ${entry.name}.`,
            );
          }
        } else {
          await copyFile(path, retainedPath);
        }
      }
      legalFiles.push({
        path: relative(staging, retainedPath).split(sep).join("/"),
        sha256: await sha256File(retainedPath),
      });
    }
  }
  const curatedLicense = curatedRuntimeLicenseFiles.get(`${manifest.name}@${manifest.version}`);
  if (legalFiles.length === 0 && curatedLicense !== undefined) {
    const curatedPath = join(staging, ...curatedLicense.path.split("/"));
    legalFiles.push({
      path: curatedLicense.path,
      sha256: await sha256File(curatedPath),
    });
  }
  legalFiles.sort((left, right) => compareCodeUnits(left.path, right.path));
  const repositoryUrl = packageRepositoryUrl(manifest.repository);
  packages.push({
    name: manifest.name,
    version: manifest.version,
    packagePath: options.packagePath ?? relative(staging, packageDirectory).split(sep).join("/"),
    ...(options.bundledForm === undefined ? {} : { bundledForm: options.bundledForm }),
    license:
      typeof manifest.license === "string" && manifest.license.trim() !== ""
        ? manifest.license
        : "SEE_PACKAGE_FILES",
    ...(repositoryUrl === undefined ? {} : { repositoryUrl }),
    ...(curatedLicense === undefined
      ? {}
      : {
          legalFilesSource: {
            type: "curated-versioned-upstream-copy",
            source: curatedLicense.source,
          },
        }),
    legalFiles,
  });
}

function legalDirectoryName(name, version) {
  return `${name.replaceAll("/", "__")}@${version}`.replaceAll(/[^0-9A-Za-z@._-]/g, "_");
}

async function containsCompleteLicenseText(path) {
  const content = await readFile(path, "utf8");
  return (
    /^#{1,6}\s+licen[cs]e\s*$/imu.test(content) &&
    /permission is hereby granted/iu.test(content) &&
    /the software is provided ["“]as is["”]/iu.test(content)
  );
}

function packageRepositoryUrl(repository) {
  const value =
    typeof repository === "string"
      ? repository
      : repository !== null && typeof repository === "object" && typeof repository.url === "string"
        ? repository.url
        : undefined;
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  return value
    .trim()
    .replace(/^git\+/, "")
    .replace(/\.git$/, "");
}

async function sha256File(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

export function renderWindowsLauncher() {
  return `@echo off\r
set "OPENDELEGATE_BUILD_ID="\r
set "OPENDELEGATE_VERSION="\r
"%~dp0runtime\\node.exe" "%~dp0apps\\main\\opendelegate.mjs" %*\r
`;
}

export function renderUnixLauncher() {
  return `#!/bin/sh
unset OPENDELEGATE_BUILD_ID OPENDELEGATE_VERSION
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$ROOT_DIR/runtime/node" "$ROOT_DIR/apps/main/opendelegate.mjs" "$@"
`;
}

async function writeLaunchers(staging) {
  await writeFile(join(staging, "opendelegate.cmd"), renderWindowsLauncher(), "utf8");

  if (process.platform !== "win32") {
    const path = join(staging, "opendelegate");
    await writeFile(path, renderUnixLauncher(), "utf8");
    await chmod(path, 0o755);
  }
}

export function evaluateSmokeShutdown(input) {
  const markerObserved = input.stdout.includes('"event":"main.stopped"');
  const naturalExit =
    !input.shutdownTimedOut &&
    !input.forcedTermination &&
    input.exitCode === 0 &&
    input.signalCode === null;
  return {
    accepted: markerObserved && naturalExit,
    markerObserved,
    naturalExit,
    exitCode: input.exitCode,
    signal: input.signalCode,
    shutdownTimedOut: input.shutdownTimedOut,
    forcedTermination: input.forcedTermination,
  };
}

async function smokeBundle(staging, buildId, productVersion) {
  assertProductVersion(productVersion);
  const runtime = join(staging, "runtime", process.platform === "win32" ? "node.exe" : "node");
  const entrypoint = join(staging, "apps", "main", "opendelegate.mjs");
  const releaseEnvironment = {
    ...process.env,
    OPENDELEGATE_BUILD_ID: "caller-controlled-release-candidate",
    OPENDELEGATE_TEST_EXIT_ON_STDIN_END: "1",
    OPENDELEGATE_VERSION: "999.999.999",
  };
  const result = await runCommand(runtime, [entrypoint, "help"], staging, {
    capture: true,
    environment: releaseEnvironment,
  });
  if (!result.stdout.includes("Runtime state and credentials are never written")) {
    throw new Error("The packaged CLI help smoke test returned an unexpected result.");
  }
  const version = await runCommand(runtime, [entrypoint, "version"], staging, {
    capture: true,
    environment: releaseEnvironment,
  });
  if (version.stdout.trim() !== `OpenDelegate ${productVersion}`) {
    throw new Error("The packaged CLI version smoke returned an unexpected result.");
  }

  const smokeHome = await mkdtemp(join(dirname(staging), ".od-home-"));
  const child = spawn(runtime, [entrypoint, "init", "--home", smokeHome], {
    cwd: staging,
    env: releaseEnvironment,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  let recoveryCodeCount;
  let shutdownTimedOut = false;
  let forcedTermination = false;
  let shutdownEvaluation;
  try {
    await waitUntil(
      () => stdout.includes('"event":"owner.claim.ready"') || hasChildExited(child),
      20_000,
    );
    if (hasChildExited(child) || !stdout.includes('"event":"owner.claim.ready"')) {
      throw new Error(
        `The packaged init smoke test exited before readiness.${stderr === "" ? "" : `\n${stderr}`}`,
      );
    }

    const [health, admin, claim] = await Promise.all([
      fetch("http://127.0.0.1:4380/health/live", {
        signal: AbortSignal.timeout(5_000),
      }),
      fetch("http://127.0.0.1:4380/", {
        signal: AbortSignal.timeout(5_000),
      }),
      fetch("http://127.0.0.1:4381/", {
        signal: AbortSignal.timeout(5_000),
      }),
    ]);
    const healthBody = await health.json();
    const adminBody = await admin.text();
    const claimBody = await claim.text();
    if (
      !health.ok ||
      healthBody?.status !== "ok" ||
      healthBody?.version !== productVersion ||
      healthBody?.buildId !== buildId ||
      !admin.ok ||
      !adminBody.includes('id="root"') ||
      !claim.ok ||
      !claimBody.includes("Claim this OpenDelegate Main")
    ) {
      throw new Error("The packaged Main, Admin, and local-claim smoke surfaces did not agree.");
    }

    const claimToken = claimBody.match(/data-claim="([^"]+)"/)?.[1];
    if (claimToken === undefined) {
      throw new Error("The packaged local-claim page did not contain its one-time credential.");
    }
    const smokePassphrase = "release-smoke-correct-horse-2026";
    const claimed = await fetch("http://127.0.0.1:4381/api/v1/auth/claim", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:4381",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ claimToken, passphrase: smokePassphrase }),
      signal: AbortSignal.timeout(10_000),
    });
    const claimedBody = await claimed.json();
    recoveryCodeCount = Array.isArray(claimedBody?.recoveryCodes)
      ? claimedBody.recoveryCodes.length
      : 0;
    if (!claimed.ok || recoveryCodeCount !== 10) {
      throw new Error("The packaged loopback owner claim did not produce recovery credentials.");
    }

    const login = await fetch("http://127.0.0.1:4380/api/v1/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:4380",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ passphrase: smokePassphrase }),
      signal: AbortSignal.timeout(10_000),
    });
    const loginBody = await login.json();
    const sessionCookie = login.headers.get("set-cookie");
    if (
      !login.ok ||
      typeof loginBody?.csrfToken !== "string" ||
      typeof loginBody?.session?.ownerId !== "string" ||
      sessionCookie === null ||
      !sessionCookie.startsWith("__Host-opendelegate_session=") ||
      !/;\s*Path=\//iu.test(sessionCookie) ||
      !/;\s*HttpOnly/iu.test(sessionCookie) ||
      !/;\s*Secure/iu.test(sessionCookie) ||
      !/;\s*SameSite=Lax/iu.test(sessionCookie) ||
      /;\s*Domain=/iu.test(sessionCookie)
    ) {
      throw new Error("The packaged owner could not authenticate after local claim.");
    }
    const cookiePair = sessionCookie.split(";", 1)[0];
    const session = await fetch("http://127.0.0.1:4380/api/v1/auth/session", {
      headers: {
        cookie: cookiePair,
      },
      signal: AbortSignal.timeout(10_000),
    });
    const sessionBody = await session.json();
    if (
      !session.ok ||
      sessionBody?.session?.ownerId !== loginBody.session.ownerId ||
      typeof sessionBody?.csrfToken !== "string"
    ) {
      throw new Error("The packaged owner session cookie did not round-trip through Main.");
    }

    await Promise.all([
      stat(join(smokeHome, "config", "main.json")),
      stat(join(smokeHome, "state", "main.sqlite3")),
    ]);
  } finally {
    if (!hasChildExited(child)) {
      child.stdin.end();
    }
    await waitUntil(() => hasChildExited(child), 5_000).catch(async () => {
      shutdownTimedOut = true;
      if (!hasChildExited(child)) {
        forcedTermination = true;
        child.kill("SIGKILL");
      }
      await waitUntil(() => hasChildExited(child), 5_000);
    });
    shutdownEvaluation = evaluateSmokeShutdown({
      stdout,
      exitCode: child.exitCode,
      signalCode: child.signalCode,
      shutdownTimedOut,
      forcedTermination,
    });
    await rm(smokeHome, { force: true, recursive: true });
  }
  if (!shutdownEvaluation.accepted) {
    throw new Error(
      "The packaged Main did not complete a natural, zero-exit shutdown with a main.stopped marker.",
    );
  }
  return {
    schemaVersion: 1,
    platform: process.platform,
    architecture: process.arch,
    bundledNodeVersion: process.versions.node,
    buildId,
    productVersion,
    checks: {
      cliHelp: "passed",
      cleanHomeInitialization: "passed",
      mainHealth: "passed",
      adminStaticApp: "passed",
      loopbackOwnerClaim: "passed",
      ownerLogin: "passed",
      ownerSessionCookieContract: "passed",
      ownerSessionRoundTrip: "passed",
      recoveryCredentialsIssued: recoveryCodeCount,
      cleanShutdown: {
        status: "passed",
        markerObserved: shutdownEvaluation.markerObserved,
        naturalExit: shutdownEvaluation.naturalExit,
        exitCode: shutdownEvaluation.exitCode,
        signal: shutdownEvaluation.signal,
        shutdownTimedOut: shutdownEvaluation.shutdownTimedOut,
        forcedTermination: shutdownEvaluation.forcedTermination,
      },
    },
  };
}

function hasChildExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitUntil(predicate, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${String(timeoutMilliseconds)}ms.`);
    }
    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, 50);
    });
  }
}

function assertReleaseHost() {
  if (process.versions.node !== REQUIRED_RELEASE_NODE_VERSION) {
    throw new Error(
      `Release bundles require the pinned Node.js ${REQUIRED_RELEASE_NODE_VERSION} runtime; received ${process.versions.node}.`,
    );
  }
  if (!supportedPlatforms.has(process.platform)) {
    throw new Error(`Unsupported release platform: ${process.platform}.`);
  }
  if (!supportedArchitectures.has(process.arch)) {
    throw new Error(`Unsupported release architecture: ${process.arch}.`);
  }
}

async function assertPathAbsent(path) {
  try {
    await stat(path);
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error("The release destination already exists; refusing to overwrite it.");
}

async function assertGitCommitExists(sourceRoot, commit, label) {
  try {
    await runProvenanceGit(["cat-file", "-e", `${commit}^{commit}`], sourceRoot, {
      capture: true,
    });
  } catch (error) {
    throw new Error(`The ${label} does not exist as a Git commit in this repository.`, {
      cause: error,
    });
  }
}

export async function readSourceIdentity(sourceRoot = repositoryRoot) {
  const commit = (
    await runProvenanceGit(["rev-parse", "HEAD"], sourceRoot, { capture: true })
  ).stdout.trim();
  const status = (
    await runProvenanceGit(
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"],
      sourceRoot,
      { capture: true },
    )
  ).stdout;
  const commitEpoch = Number(
    (
      await runProvenanceGit(["show", "-s", "--format=%ct", commit], sourceRoot, {
        capture: true,
      })
    ).stdout.trim(),
  );
  if (!Number.isSafeInteger(commitEpoch) || commitEpoch < 0) {
    throw new Error("Git returned an invalid source commit timestamp.");
  }
  return { commit, commitEpoch, dirty: status !== "" };
}

function createBuildId(source, supportStatus) {
  const dirtySuffix = source.dirty ? "-dirty" : "";
  return `${supportStatus}-${source.commit.slice(0, 12)}${dirtySuffix}-${process.platform}-${process.arch}`;
}

function buildTimestamp(source, supportStatus) {
  const epoch = process.env["SOURCE_DATE_EPOCH"];
  if (epoch === undefined) {
    return supportStatus === "release-candidate"
      ? new Date(source.commitEpoch * 1000).toISOString()
      : new Date().toISOString();
  }
  const seconds = Number(epoch);
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new Error("SOURCE_DATE_EPOCH must be a non-negative integer.");
  }
  return new Date(seconds * 1000).toISOString();
}

function formatCounts(counts) {
  return Object.entries(counts)
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([status, count]) => `${status}=${count}`)
    .join(", ");
}

async function runProvenanceGit(arguments_, cwd, options = {}) {
  return runCommand("git", arguments_, cwd, {
    ...options,
    environment: {
      ...process.env,
      ...options.environment,
      GIT_NO_REPLACE_OBJECTS: "1",
    },
  });
}

export async function resolveExternalPnpmCli(sourceRoot, candidate) {
  if (typeof candidate !== "string" || !isAbsolute(candidate)) {
    throw new Error("A pnpm command requires an explicit absolute verified CLI path.");
  }
  const [canonicalSource, canonicalCandidate] = await Promise.all([
    realpath(sourceRoot),
    realpath(candidate),
  ]);
  validateReleaseDestination(canonicalSource, canonicalCandidate);
  const metadata = await lstat(canonicalCandidate);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("The pnpm CLI must resolve to a regular file outside the source checkout.");
  }
  return canonicalCandidate;
}

async function runCommand(command, arguments_, cwd, options = {}) {
  const externalPnpmCli =
    command === "pnpm" ? await resolveExternalPnpmCli(repositoryRoot, options.pnpmCli) : undefined;
  const executable = externalPnpmCli === undefined ? command : process.execPath;
  const executableArguments =
    externalPnpmCli === undefined ? arguments_ : [externalPnpmCli, ...arguments_];
  const child = spawn(executable, executableArguments, {
    cwd,
    env: options.environment ?? process.env,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  if (options.capture) {
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
  }
  const exitCode = await new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolvePromise(code));
  });
  if (exitCode !== 0) {
    throw new Error(
      `${command} ${arguments_.join(" ")} failed with exit code ${String(exitCode)}${stderr === "" ? "" : `:\n${stderr}`}`,
    );
  }
  return { stderr, stdout };
}

async function listFiles(directory) {
  const paths = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await listFiles(path)));
    } else if (entry.isFile()) {
      paths.push(path);
    }
  }
  return paths.sort(compareCodeUnits);
}

async function listTreeEntries(directory) {
  const paths = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    paths.push(path);
    if (entry.isDirectory()) {
      paths.push(...(await listTreeEntries(path)));
    }
  }
  return paths.sort(compareCodeUnits);
}

function printHelp() {
  process.stdout.write(`Build an OpenDelegate platform bundle.

Usage:
  node tooling/build-release.mjs --destination ABSOLUTE_PATH
  node tooling/build-release.mjs --destination ABSOLUTE_PATH --internal-preview

An incomplete first-milestone ledger can only produce a clearly marked unsupported
internal preview. Existing destinations and paths inside the source checkout are
always rejected.
`);
}

async function runCommittedReleaseCli(rawArguments) {
  const source = await readSourceIdentity(releaseToolRoot);
  assertCleanBundleSource(source);
  const runnerParent = await mkdtemp(join(tmpdir(), "opendelegate-release-runner-"));
  try {
    const runnerRoot = await createCommittedSourceSnapshot(
      releaseToolRoot,
      source.commit,
      runnerParent,
    );
    const runnerFile = join(runnerRoot, "tooling", "build-release.mjs");
    const child = spawn(process.execPath, [runnerFile, ...rawArguments], {
      cwd: releaseToolRoot,
      env: {
        ...process.env,
        [releaseRunnerSourceEnvironment]: releaseToolRoot,
        [releaseRunnerCommitEnvironment]: source.commit,
      },
      stdio: "inherit",
      windowsHide: true,
    });
    const exitCode = await new Promise((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolvePromise(code));
    });
    if (exitCode !== 0) {
      throw new Error(
        `The committed release runner exited without producing a bundle (exit ${String(exitCode)}).`,
      );
    }
  } finally {
    await rm(runnerParent, { force: true, recursive: true });
  }
}

const invokedFile = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedFile === resolve(currentFile)) {
  try {
    const arguments_ = parseReleaseArguments(process.argv.slice(2));
    if (arguments_.help) {
      printHelp();
    } else if (expectedReleaseCommit === undefined && configuredReleaseSource === undefined) {
      await runCommittedReleaseCli(process.argv.slice(2));
    } else {
      const result = await buildRelease(arguments_);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Release build failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
