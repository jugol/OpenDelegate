import assert from "node:assert/strict";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  verify as verifySignature,
} from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import {
  finalizeReleaseCandidate,
  parseReleaseFinalizationArguments,
} from "../finalize-release-candidate.mjs";

test("finalization archives, externally signs, verifies, and publishes an atomic candidate set", async (t) => {
  const fixture = await createFinalizationFixture(t);
  const result = await finalizeReleaseCandidate(fixture.input, {
    integrity: fixture.integrity,
    now: () => new Date("2026-07-25T12:34:56.000Z"),
    readSourceIdentity: fixture.readSourceIdentity,
  });

  assert.equal(result.archive.sha256, await sha256File(result.archive.path));
  assert.equal(
    result.publisherAttestation.sha256,
    await sha256File(result.publisherAttestation.path),
  );
  assert.equal(result.publisherKeyId, fixture.signing.keyId);
  assert.equal(result.candidateDigest, fixture.candidateDigest);
  assert.equal(fixture.integrity.verificationCalls.length, 1);
  assert.equal(
    fixture.integrity.verificationCalls[0].expectedCandidateDigest,
    fixture.candidateDigest,
  );

  const runnerRecord = JSON.parse(await readFile(result.runnerRecord.path, "utf8"));
  assert.equal(runnerRecord.schemaVersion, 1);
  assert.equal(runnerRecord.role, "publisher");
  assert.equal(runnerRecord.candidate.publisherStatementSha256, fixture.candidateDigest);
  assert.equal(runnerRecord.outputs.archive.sha256, result.archive.sha256);
  assert.equal(
    runnerRecord.outputs.publisherAttestation.sha256,
    result.publisherAttestation.sha256,
  );
  assert.equal(JSON.stringify(runnerRecord).includes(fixture.root), false);
  assert.deepEqual(
    (await readdirNames(fixture.destination)).sort(),
    [
      basename(result.archive.path),
      basename(result.publisherAttestation.path),
      basename(result.runnerRecord.path),
    ].sort(),
  );
});

test("finalization refuses existing outputs without publishing a partial set", async (t) => {
  const fixture = await createFinalizationFixture(t);
  const occupied = join(
    fixture.destination,
    `opendelegate-v${fixture.candidate.productVersion}-${fixture.target.platform}-${fixture.target.architecture}.zip.publisher-attestation.json`,
  );
  await writeFile(occupied, "owner data\n", "utf8");

  await assert.rejects(
    finalizeReleaseCandidate(fixture.input, {
      integrity: fixture.integrity,
      readSourceIdentity: fixture.readSourceIdentity,
    }),
    /already exists; nothing was overwritten/u,
  );
  assert.deepEqual(await readdirNames(fixture.destination), [basename(occupied)]);
  assert.equal(await readFile(occupied, "utf8"), "owner data\n");
});

test("finalization detects candidate changes and verifier failure before exposing outputs", async (t) => {
  const changed = await createFinalizationFixture(t);
  changed.integrity.changeCandidateAfterFirstInspection = true;
  await assert.rejects(
    finalizeReleaseCandidate(changed.input, {
      integrity: changed.integrity,
      readSourceIdentity: changed.readSourceIdentity,
    }),
    /candidate changed while its final archive was created/u,
  );
  assert.deepEqual(await readdirNames(changed.destination), []);

  const rejected = await createFinalizationFixture(t);
  rejected.integrity.rejectVerification = true;
  await assert.rejects(
    finalizeReleaseCandidate(rejected.input, {
      integrity: rejected.integrity,
      readSourceIdentity: rejected.readSourceIdentity,
    }),
    /fixture rejected final verification/u,
  );
  assert.deepEqual(await readdirNames(rejected.destination), []);
});

test("finalization rejects a dirty or different release source before signing", async (t) => {
  const dirty = await createFinalizationFixture(t);
  await assert.rejects(
    finalizeReleaseCandidate(dirty.input, {
      integrity: dirty.integrity,
      readSourceIdentity: async () => ({
        commit: dirty.candidate.buildCommit,
        commitEpoch: 1_753_315_324,
        dirty: true,
      }),
    }),
    /clean committed build source/u,
  );
  assert.deepEqual(await readdirNames(dirty.destination), []);

  const different = await createFinalizationFixture(t);
  await assert.rejects(
    finalizeReleaseCandidate(different.input, {
      integrity: different.integrity,
      readSourceIdentity: async () => ({
        commit: "0".repeat(40),
        commitEpoch: 1_753_315_324,
        dirty: false,
      }),
    }),
    /clean committed build source/u,
  );
  assert.deepEqual(await readdirNames(different.destination), []);
});

test("release finalization arguments require exact absolute pinned inputs", () => {
  const root = process.cwd();
  assert.deepEqual(
    parseReleaseFinalizationArguments([
      "--candidate",
      join(root, "candidate"),
      "--destination",
      join(root, "output"),
      "--target",
      targetName(currentTarget()),
      "--expected-manifest-sha256",
      "a".repeat(64),
      "--expected-candidate-digest",
      "b".repeat(64),
      "--signing-policy",
      join(root, "publisher-policy.json"),
      "--signing-policy-sha256",
      "c".repeat(64),
    ]),
    {
      candidateRoot: join(root, "candidate"),
      destinationDirectory: join(root, "output"),
      expectedCandidateDigest: "b".repeat(64),
      expectedManifestSha256: "a".repeat(64),
      help: false,
      signingPolicyPath: join(root, "publisher-policy.json"),
      signingPolicySha256: "c".repeat(64),
      target: currentTarget(),
    },
  );
  assert.throws(
    () =>
      parseReleaseFinalizationArguments([
        "--candidate",
        "relative",
        "--destination",
        join(root, "output"),
        "--target",
        targetName(currentTarget()),
        "--expected-manifest-sha256",
        "a".repeat(64),
        "--expected-candidate-digest",
        "b".repeat(64),
        "--signing-policy",
        join(root, "publisher-policy.json"),
        "--signing-policy-sha256",
        "c".repeat(64),
      ]),
    /absolute/u,
  );
  assert.deepEqual(parseReleaseFinalizationArguments(["--help"]), { help: true });
});

async function createFinalizationFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-finalization-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const candidateRoot = join(root, "candidate");
  const destination = join(root, "output");
  await Promise.all([mkdir(candidateRoot), mkdir(destination)]);
  await writeFile(
    join(candidateRoot, "release-metadata.json"),
    `${JSON.stringify(
      {
        createdAt: "2026-07-24T01:02:04.000Z",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(join(candidateRoot, "payload.txt"), "immutable candidate\n", "utf8");

  const signing = await createSigningPolicy(root);
  const target = currentTarget();
  const candidateDigest = "a".repeat(64);
  const manifestSha256 = "b".repeat(64);
  const candidate = Object.freeze({
    acceptanceLedgerSha256: "c".repeat(64),
    auditedSourceCommit: "d".repeat(40),
    buildCommit: "e".repeat(40),
    buildId: `release-candidate-${"e".repeat(12)}-${target.platform}-${target.architecture}`,
    candidateAttestationId: "release-candidate-fixture",
    checksumManifestSha256: manifestSha256,
    declaredChannel: "release-candidate",
    nativeComponentsSha256: "f".repeat(64),
    payloadManifestSha256: "1".repeat(64),
    platformAuthenticitySha256: "2".repeat(64),
    platformCertificateIdentities: Object.freeze([]),
    platformProductCertificateIdentity: null,
    productVersion: "0.1.0-alpha.1",
    publisherStatement: Object.freeze({
      canonicalBytes: Buffer.from("candidate\n", "utf8"),
      domain: "opendelegate.release.publisher-candidate.v2",
      sha256: candidateDigest,
    }),
    releaseMetadataSha256: "3".repeat(64),
    target,
  });
  const integrity = createFakeIntegrity(candidate, signing.publicKeyPem);
  return {
    candidate,
    candidateDigest,
    destination,
    input: {
      candidateRoot,
      destinationDirectory: destination,
      expectedCandidateDigest: candidateDigest,
      expectedManifestSha256: manifestSha256,
      signingPolicyPath: signing.policyPath,
      signingPolicySha256: await sha256File(signing.policyPath),
      target,
    },
    integrity,
    readSourceIdentity: async () => ({
      commit: candidate.buildCommit,
      commitEpoch: 1_753_315_324,
      dirty: false,
    }),
    root,
    signing,
    target,
  };
}

function createFakeIntegrity(candidate, expectedPublicKey) {
  let inspections = 0;
  const verificationCalls = [];
  return {
    changeCandidateAfterFirstInspection: false,
    rejectVerification: false,
    verificationCalls,
    nodeReleaseFileReader: {
      async read(path, maximumBytes) {
        const bytes = await readFile(path);
        if (bytes.byteLength > maximumBytes) {
          throw new Error("fixture read is oversized");
        }
        return bytes;
      },
    },
    async inspectCandidate(input) {
      inspections += 1;
      assert.deepEqual(input.expectedTarget, candidate.target);
      assert.equal(input.expectedManifestSha256, candidate.checksumManifestSha256);
      if (this.changeCandidateAfterFirstInspection && inspections > 1) {
        return {
          ...candidate,
          publisherStatement: {
            ...candidate.publisherStatement,
            sha256: "9".repeat(64),
          },
        };
      }
      return candidate;
    },
    composePublisherAttestationStatement({ archive, candidate: inspected }) {
      assert.equal(inspected.publisherStatement.sha256, candidate.publisherStatement.sha256);
      const statement = {
        schemaVersion: 2,
        product: "OpenDelegate",
        domain: "opendelegate.release.publisher-attestation.v2",
        candidateDigest: inspected.publisherStatement.sha256,
        archive,
      };
      const canonicalBytes = Buffer.from(`${JSON.stringify(statement, null, 2)}\n`, "utf8");
      return {
        canonicalBytes,
        signingBytes: Buffer.concat([
          Buffer.from("OpenDelegate publisher attestation v2\n", "utf8"),
          canonicalBytes,
        ]),
        statement,
      };
    },
    composeSignedReleaseEnvelope({ composed, keyId, signature }) {
      const envelope = {
        schemaVersion: 2,
        product: "OpenDelegate",
        role: "publisher",
        algorithm: "ed25519",
        keyId,
        statement: composed.statement,
        signature,
      };
      const canonicalBytes = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, "utf8");
      return {
        canonicalBytes,
        envelope,
        sha256: sha256(canonicalBytes),
      };
    },
    async verifyRelease(input) {
      verificationCalls.push(input);
      if (this.rejectVerification) {
        throw new Error("fixture rejected final verification");
      }
      assert.deepEqual(Buffer.from(input.publisherTrust.publicKeyPem), expectedPublicKey);
      const envelope = JSON.parse(await readFile(input.candidatePublisherEvidence.attestationPath));
      const statementBytes = Buffer.from(
        `${JSON.stringify(envelope.statement, null, 2)}\n`,
        "utf8",
      );
      const signingBytes = Buffer.concat([
        Buffer.from("OpenDelegate publisher attestation v2\n", "utf8"),
        statementBytes,
      ]);
      assert.equal(
        verifySignature(
          null,
          signingBytes,
          createPublicKey(input.publisherTrust.publicKeyPem),
          Buffer.from(envelope.signature, "base64url"),
        ),
        true,
      );
      const archiveBytes = await readFile(input.candidatePublisherEvidence.archivePath);
      assert.equal(sha256(archiveBytes), envelope.statement.archive.sha256);
      return {
        archive: envelope.statement.archive,
        candidate,
        effectiveChannel: "release-candidate",
        publisherAttestationSha256: sha256(
          await readFile(input.candidatePublisherEvidence.attestationPath),
        ),
        publisherKeyId: envelope.keyId,
      };
    },
  };
}

async function createSigningPolicy(root) {
  const signingRoot = join(root, "external-signing");
  await mkdir(signingRoot);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPath = join(signingRoot, "private.pem");
  const publicKeyPath = join(signingRoot, "public.pem");
  const helperPath = join(signingRoot, "helper.mjs");
  const policyPath = join(signingRoot, "publisher-policy.json");
  const publicKeyPem = Buffer.from(publicKey.export({ format: "pem", type: "spki" }));
  await writeFile(privateKeyPath, privateKey.export({ format: "pem", type: "pkcs8" }), {
    mode: 0o600,
  });
  await writeFile(publicKeyPath, publicKeyPem, { mode: 0o644 });
  await writeFile(
    helperPath,
    `import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const chunks = [];
let total = 0;
for await (const chunk of process.stdin) {
  total += chunk.byteLength;
  chunks.push(chunk);
}
const key = createPrivateKey(
  await readFile(join(dirname(fileURLToPath(import.meta.url)), "private.pem")),
);
const publicKey = createPublicKey(key);
process.stdout.write(\`\${JSON.stringify({
  schemaVersion: 1,
  algorithm: "ed25519",
  keyId: \`sha256:\${createHash("sha256")
    .update(publicKey.export({ format: "der", type: "spki" }))
    .digest("hex")}\`,
  signature: sign(null, Buffer.concat(chunks, total), key).toString("base64url"),
})}\\n\`);
`,
    { mode: 0o700 },
  );
  if (process.platform !== "win32") {
    await Promise.all([
      chmod(privateKeyPath, 0o600),
      chmod(publicKeyPath, 0o644),
      chmod(helperPath, 0o700),
    ]);
  }
  const policy = {
    schemaVersion: 1,
    product: "OpenDelegate",
    role: "publisher",
    publicKey: {
      path: publicKeyPath,
      sha256: await sha256File(publicKeyPath),
    },
    signer: {
      executable: {
        path: process.execPath,
        sha256: await sha256File(process.execPath),
      },
      invocationArtifacts: [
        {
          path: helperPath,
          sha256: await sha256File(helperPath),
        },
      ],
      timeoutMs: 30_000,
    },
  };
  await writeFile(policyPath, `${JSON.stringify(policy)}\n`, "utf8");
  return {
    keyId: `sha256:${sha256(publicKey.export({ format: "der", type: "spki" }))}`,
    policyPath,
    publicKeyPem,
  };
}

async function readdirNames(path) {
  const { readdir } = await import("node:fs/promises");
  return readdir(path);
}

function currentTarget() {
  return {
    platform: process.platform,
    architecture: process.arch,
  };
}

function targetName(target) {
  return `${target.platform}-${target.architecture}`;
}

async function sha256File(path) {
  return sha256(await readFile(path));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
