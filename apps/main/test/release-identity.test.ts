import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { ReleaseIdentityError, resolveRuntimeIdentity } from "../src/release-identity.ts";

const auditedCommit = "a".repeat(40);
const buildCommit = "b".repeat(40);
const proofPath = "docs/release/evidence/release-proof.txt";
const ledgerPath = "docs/release/acceptance-evidence.json";
const smokeEvidencePath = "smoke-evidence.json";
const timestamp = "2026-07-24T00:00:00Z";

test("source-checkout identity is fixed development data despite caller environment", async (t) => {
  const previousBuildId = process.env["OPENDELEGATE_BUILD_ID"];
  const previousVersion = process.env["OPENDELEGATE_VERSION"];
  t.after(() => {
    restoreEnvironment("OPENDELEGATE_BUILD_ID", previousBuildId);
    restoreEnvironment("OPENDELEGATE_VERSION", previousVersion);
  });
  process.env["OPENDELEGATE_BUILD_ID"] = "release-candidate-forged";
  process.env["OPENDELEGATE_VERSION"] = "999.999.999";

  assert.deepEqual(
    await resolveRuntimeIdentity({
      installationRoot: "unused-for-source-checkout",
      bundled: false,
    }),
    {
      build: {
        version: "0.0.0-development",
        buildId: "development-local",
      },
      releaseChannel: "development",
    },
  );
});

test("valid blocked and complete previews remain internal previews", async (t) => {
  const blocked = await createBundleFixture(t, {
    complete: false,
    supportStatus: "internal-preview-blocked",
  });
  const complete = await createBundleFixture(t, {
    complete: true,
    supportStatus: "internal-preview-complete",
  });

  assert.equal((await resolveBundle(blocked)).releaseChannel, "internal-preview");
  assert.equal((await resolveBundle(complete)).releaseChannel, "internal-preview");
});

test("a complete, clean, internally consistent candidate reports metadata version", async (t) => {
  const root = await createBundleFixture(t, {
    complete: true,
    supportStatus: "release-candidate",
  });
  const previousBuildId = process.env["OPENDELEGATE_BUILD_ID"];
  const previousVersion = process.env["OPENDELEGATE_VERSION"];
  t.after(() => {
    restoreEnvironment("OPENDELEGATE_BUILD_ID", previousBuildId);
    restoreEnvironment("OPENDELEGATE_VERSION", previousVersion);
  });
  process.env["OPENDELEGATE_BUILD_ID"] = "internal-preview-blocked-forged";
  process.env["OPENDELEGATE_VERSION"] = "999.999.999";

  assert.deepEqual(await resolveBundle(root), {
    build: {
      version: "1.2.3-test",
      buildId: `release-candidate-${buildCommit.slice(0, 12)}-${process.platform}-${process.arch}`,
    },
    releaseChannel: "release-candidate",
  });
});

test("metadata, ledger, payload-manifest, and checksum tampering fail closed", async (t) => {
  const metadataRoot = await createBundleFixture(t, {
    complete: false,
    supportStatus: "internal-preview-blocked",
  });
  await writeFile(join(metadataRoot, "release-metadata.json"), "{}\n");
  await assertInvalid(resolveBundle(metadataRoot), /release-metadata\.json/u);

  const ledgerRoot = await createBundleFixture(t, {
    complete: false,
    supportStatus: "internal-preview-blocked",
  });
  await writeFile(join(ledgerRoot, ...ledgerPath.split("/")), "{}\n");
  await assertInvalid(resolveBundle(ledgerRoot), /acceptance-evidence\.json/u);

  const manifestRoot = await createBundleFixture(t, {
    complete: false,
    supportStatus: "internal-preview-blocked",
  });
  const manifest = JSON.parse(
    await readFile(join(manifestRoot, "payload-manifest.json"), "utf8"),
  ) as { fileCount: number };
  manifest.fileCount += 1;
  await writeFile(
    join(manifestRoot, "payload-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await assertInvalid(resolveBundle(manifestRoot), /[Pp]ayload manifest/u);

  const checksumRoot = await createBundleFixture(t, {
    complete: false,
    supportStatus: "internal-preview-blocked",
  });
  const checksum = await readFile(join(checksumRoot, "SHA256SUMS"), "utf8");
  await writeFile(join(checksumRoot, "SHA256SUMS"), checksum.replace(/^[0-9a-f]/u, "f"));
  await assertInvalid(resolveBundle(checksumRoot), /[Pp]ayload manifest/u);
});

test("cryptographically self-consistent status and ledger contradictions fail closed", async (t) => {
  const root = await createBundleFixture(t, {
    complete: false,
    supportStatus: "internal-preview-blocked",
  });
  const metadataPath = join(root, "release-metadata.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
    supportStatus: string;
    buildMode: string;
    buildId: string;
  };
  metadata.supportStatus = "release-candidate";
  metadata.buildMode = "release-candidate";
  metadata.buildId = `release-candidate-${buildCommit.slice(0, 12)}-${process.platform}-${process.arch}`;
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  await writeIntegrityFiles(root);

  await assertInvalid(resolveBundle(root), /Release-candidate metadata/u);
});

test("candidate changed paths must be canonical SHA-bound ledger evidence", async (t) => {
  for (const forgedPath of ["src/backdoor.ts", "docs/release/evidence/unreferenced-proof.txt"]) {
    const root = await createBundleFixture(t, {
      complete: true,
      supportStatus: "release-candidate",
    });
    const forgedFile = join(root, ...forgedPath.split("/"));
    await mkdir(dirname(forgedFile), { recursive: true });
    await writeFile(forgedFile, "forged but integrity-consistent\n");

    const metadataPath = join(root, "release-metadata.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
      changedAttestationPaths: string[];
    };
    metadata.changedAttestationPaths = [ledgerPath, proofPath, forgedPath].sort(compareCodeUnits);
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    await writeIntegrityFiles(root, [forgedPath]);

    await assertInvalid(resolveBundle(root), /canonical SHA-bound release evidence/u);
  }
});

test("identity rejects tampered, extra, missing, or linked payload paths", async (t) => {
  const tampered = await createBundleFixture(t, {
    complete: false,
    supportStatus: "internal-preview-blocked",
  });
  await writeFile(join(tampered, smokeEvidencePath), '{"checks":"tampered"}\n');
  await assertInvalid(resolveBundle(tampered), /smoke-evidence\.json/u);

  const extra = await createBundleFixture(t, {
    complete: false,
    supportStatus: "internal-preview-blocked",
  });
  await writeFile(join(extra, "unlisted-extra.txt"), "unlisted\n");
  await assertInvalid(resolveBundle(extra), /unlisted payload path/u);

  const missing = await createBundleFixture(t, {
    complete: false,
    supportStatus: "internal-preview-blocked",
  });
  await rm(join(missing, smokeEvidencePath));
  await assertInvalid(resolveBundle(missing), /missing payload path/u);

  const linked = await createBundleFixture(t, {
    complete: false,
    supportStatus: "internal-preview-blocked",
  });
  const linkTarget = join(linked, "link-target");
  await mkdir(linkTarget);
  await symlink(
    linkTarget,
    join(linked, "linked-directory"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assertInvalid(resolveBundle(linked), /symbolic link or junction/u);
});

test("released identity is rejected until promotion attestation has a verified design", async (t) => {
  const root = await createBundleFixture(t, {
    complete: true,
    supportStatus: "release-candidate",
  });
  const bundledLedgerPath = join(root, ...ledgerPath.split("/"));
  const ledger = JSON.parse(await readFile(bundledLedgerPath, "utf8")) as {
    releaseStatus: string;
  };
  ledger.releaseStatus = "released";
  const ledgerBytes = Buffer.from(`${JSON.stringify(ledger, null, 2)}\n`);
  await writeFile(bundledLedgerPath, ledgerBytes);

  const metadataPath = join(root, "release-metadata.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
    releaseEvidence: { releaseStatus: string; sha256: string };
  };
  metadata.releaseEvidence.releaseStatus = "released";
  metadata.releaseEvidence.sha256 = sha256(ledgerBytes);
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  await writeIntegrityFiles(root);

  await assertInvalid(resolveBundle(root), /promotion attestation/u);
});

async function createBundleFixture(
  t: test.TestContext,
  input: {
    readonly complete: boolean;
    readonly supportStatus:
      "internal-preview-blocked" | "internal-preview-complete" | "release-candidate";
  },
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-release-identity-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(join(root, "docs", "release", "evidence"), { recursive: true });
  const proofBytes = Buffer.from("durable release proof\n");
  await writeFile(join(root, ...proofPath.split("/")), proofBytes);
  await writeFile(
    join(root, smokeEvidencePath),
    '{"schemaVersion":1,"checks":{"cleanShutdown":{"status":"passed"}}}\n',
  );

  const reference = { path: proofPath, sha256: sha256(proofBytes) };
  const criteria = Array.from({ length: 36 }, (_, index) => ({
    id: index + 1,
    title: `Criterion ${String(index + 1)}`,
    implementationStatus: input.complete ? "verified" : "partial",
    liveProofStatus: input.complete ? "verified" : "not-run",
    evidence: input.complete ? [proofPath] : [],
    nextGate: input.complete ? "Complete." : "Run the live platform lab.",
    ...(input.complete
      ? {
          verification: {
            implementation: {
              sourceCommit: auditedCommit,
              attestationId: `implementation-proof-${String(index + 1)}`,
              evidence: [reference],
            },
            liveProof: {
              sourceCommit: auditedCommit,
              attestationId: `live-proof-${String(index + 1)}`,
              evidence: [reference],
            },
          },
        }
      : {}),
  }));
  const ledger = {
    schemaVersion: 1,
    product: "OpenDelegate",
    milestone: "first",
    auditedAt: timestamp,
    sourceCommit: auditedCommit,
    releaseStatus: input.complete ? "candidate" : "blocked",
    criteria,
    ...(input.complete
      ? {
          candidateAttestation: {
            sourceCommit: auditedCommit,
            attestationId: "candidate-proof-2026",
            evidence: [reference],
          },
        }
      : {}),
  };
  const ledgerBytes = Buffer.from(`${JSON.stringify(ledger, null, 2)}\n`);
  await writeFile(join(root, ...ledgerPath.split("/")), ledgerBytes);

  const implementation = input.complete ? { verified: 36 } : { partial: 36 };
  const liveProof = input.complete ? { verified: 36 } : { "not-run": 36 };
  const metadata = {
    schemaVersion: 2,
    product: "OpenDelegate",
    productVersion: "1.2.3-test",
    protocolVersion: "v1",
    buildId: `${input.supportStatus}-${buildCommit.slice(0, 12)}-${process.platform}-${process.arch}`,
    createdAt: timestamp,
    timestampPolicy: input.supportStatus === "release-candidate" ? "source-commit" : "wall-clock",
    platform: process.platform,
    architecture: process.arch,
    bundledNodeVersion: process.versions.node,
    bundledRuntime: {
      source: "official-nodejs-distribution",
      archive: "node.tar.gz",
      archiveUrl: "https://nodejs.example.test/node.tar.gz",
      archiveSha256: "1".repeat(64),
      shasumsUrl: "https://nodejs.example.test/SHASUMS256.txt",
      executableSha256: "2".repeat(64),
      licenseSha256: "3".repeat(64),
    },
    toolchain: {
      packageManager: "pnpm@11.15.1",
      bundler: "esbuild@0.28.1",
    },
    dependencyLockSha256: "4".repeat(64),
    sourcePackageManifestSha256: "5".repeat(64),
    runtimeExternals: [{ name: "better-sqlite3", version: "13.0.1" }],
    buildCommit,
    auditedSourceCommit: auditedCommit,
    changedAttestationPaths:
      input.supportStatus === "release-candidate" ? [ledgerPath, proofPath] : null,
    buildSourceDirty: false,
    supportStatus: input.supportStatus,
    buildMode:
      input.supportStatus === "release-candidate" ? "release-candidate" : "internal-preview",
    releaseEvidence: {
      auditedAt: timestamp,
      releaseStatus: input.complete ? "candidate" : "blocked",
      sha256: sha256(ledgerBytes),
      implementation,
      liveProof,
      complete: input.complete,
    },
    entrypoints:
      process.platform === "win32" ? ["opendelegate.cmd"] : ["opendelegate", "opendelegate.cmd"],
    fileManifest: "payload-manifest.json",
    checksumManifest: "SHA256SUMS",
  };
  await writeFile(join(root, "release-metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  await writeIntegrityFiles(root);
  return root;
}

async function writeIntegrityFiles(
  root: string,
  additionalPaths: readonly string[] = [],
): Promise<void> {
  const paths = [
    ledgerPath,
    proofPath,
    "release-metadata.json",
    smokeEvidencePath,
    ...additionalPaths,
  ].sort(compareCodeUnits);
  const files = await Promise.all(
    paths.map(async (path) => {
      const bytes = await readFile(join(root, ...path.split("/")));
      return { path, size: bytes.length, sha256: sha256(bytes) };
    }),
  );
  const manifestBytes = Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        excludedSelfReferences: ["SHA256SUMS", "payload-manifest.json"],
        fileCount: files.length,
        totalBytes: files.reduce((total, file) => total + file.size, 0),
        files,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(root, "payload-manifest.json"), manifestBytes);
  const checksums = [
    ...files.map((file) => ({ path: file.path, sha256: file.sha256 })),
    { path: "payload-manifest.json", sha256: sha256(manifestBytes) },
  ].sort((left, right) => compareCodeUnits(left.path, right.path));
  await writeFile(
    join(root, "SHA256SUMS"),
    `${checksums.map((entry) => `${entry.sha256}  ${entry.path}`).join("\n")}\n`,
  );
}

async function resolveBundle(root: string) {
  return resolveRuntimeIdentity({ installationRoot: root, bundled: true });
}

async function assertInvalid(promise: Promise<unknown>, message: RegExp): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) =>
      error instanceof ReleaseIdentityError &&
      error.code === "RELEASE_IDENTITY_INVALID" &&
      message.test(error.message),
  );
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
