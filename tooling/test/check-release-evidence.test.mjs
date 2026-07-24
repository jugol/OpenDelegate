import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { auditReleaseEvidence, summarizeReleaseEvidence } from "../check-release-evidence.mjs";

function criterion(id, overrides = {}) {
  return {
    id,
    title: `Criterion ${id}`,
    implementationStatus: "missing",
    liveProofStatus: "not-run",
    evidence: [],
    nextGate: "Implement and prove it.",
    ...overrides,
  };
}

function ledger(criteria, releaseStatus = "blocked") {
  return {
    $schema: "./acceptance-evidence.schema.json",
    schemaVersion: 1,
    product: "OpenDelegate",
    milestone: "first",
    auditedAt: "2026-07-24T00:00:00.000Z",
    sourceCommit: "a".repeat(40),
    releaseStatus,
    criteria,
  };
}

test("a structurally complete 36-item blocked ledger is valid and summarized honestly", async () => {
  const criteria = Array.from({ length: 36 }, (_, index) => criterion(index + 1));
  const evidence = ledger(criteria);

  assert.deepEqual(await auditReleaseEvidence(process.cwd(), evidence), []);
  assert.deepEqual(summarizeReleaseEvidence(evidence), {
    releaseStatus: "blocked",
    implementation: { missing: 36 },
    liveProof: { "not-run": 36 },
    complete: false,
  });
});

test("candidate status fails unless implementation and live proof are all verified", async () => {
  const criteria = Array.from({ length: 36 }, (_, index) => criterion(index + 1));

  assert.deepEqual(await auditReleaseEvidence(process.cwd(), ledger(criteria, "candidate")), [
    "A candidate or released ledger requires all 36 criteria to be verified.",
  ]);
});

test("verified evidence must exist inside the repository", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-release-evidence-"));
  t.after(async () => {
    await rm(root, { force: true, recursive: true });
  });
  await writeFile(join(root, "proof.txt"), "proof", "utf8");
  const proofHash = await sha256(join(root, "proof.txt"));
  const proof = {
    sourceCommit: "a".repeat(40),
    attestationId: "ci:run/12345678",
    evidence: [{ path: "proof.txt", sha256: proofHash }],
  };
  const criteria = Array.from({ length: 36 }, (_, index) =>
    criterion(index + 1, {
      implementationStatus: "verified",
      liveProofStatus: "verified",
      evidence: ["proof.txt"],
      verification: {
        implementation: proof,
        liveProof: proof,
      },
    }),
  );
  const completeLedger = {
    ...ledger(criteria, "candidate"),
    candidateAttestation: proof,
  };

  assert.deepEqual(await auditReleaseEvidence(root, completeLedger), []);
  completeLedger.criteria[0].verification.implementation.evidence[0].sha256 = "b".repeat(64);
  assert.match(
    (await auditReleaseEvidence(root, completeLedger)).join("\n"),
    /invalid evidence SHA-256/,
  );
});

test("duplicate and missing IDs cannot silently satisfy the fixed release gate", async () => {
  const criteria = Array.from({ length: 36 }, (_, index) =>
    criterion(index === 35 ? 35 : index + 1),
  );

  assert.deepEqual(await auditReleaseEvidence(process.cwd(), ledger(criteria)), [
    "Release criterion 35 appears more than once.",
    "Release criterion 36 is missing.",
  ]);
});

test("the canonical schema fields and additional-property boundaries are enforced", async () => {
  const criteria = Array.from({ length: 36 }, (_, index) => criterion(index + 1));
  const evidence = {
    ...ledger(criteria),
    product: "AnotherProduct",
    extra: true,
  };
  evidence.criteria[0].extra = true;

  assert.deepEqual(await auditReleaseEvidence(process.cwd(), evidence), [
    "Release criterion 1 has unsupported field extra.",
    "Release evidence has unsupported field extra.",
    "Release evidence product must be OpenDelegate.",
  ]);
});

test("the top-level source commit must be a full immutable commit ID", async () => {
  const criteria = Array.from({ length: 36 }, (_, index) => criterion(index + 1));
  const evidence = {
    ...ledger(criteria),
    sourceCommit: "abcdef0",
  };

  assert.deepEqual(await auditReleaseEvidence(process.cwd(), evidence), [
    "Release evidence sourceCommit must be a full 40-character lowercase Git commit.",
  ]);
});

test("evidence must be a relative regular non-symlink file inside the canonical repository", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-release-containment-"));
  t.after(async () => {
    await rm(root, { force: true, recursive: true });
  });
  await mkdir(join(root, "directory"));
  const criteria = Array.from({ length: 36 }, (_, index) =>
    criterion(index + 1, {
      evidence: index === 0 ? ["directory"] : [],
    }),
  );
  const errors = await auditReleaseEvidence(root, ledger(criteria));
  assert.deepEqual(errors, [
    "Release criterion 1 evidence must be a regular, non-symlink file: directory.",
  ]);

  criteria[0].evidence = [join(root, "outside.txt")];
  assert.match(
    (await auditReleaseEvidence(root, ledger(criteria))).join("\n"),
    /invalid relative evidence path/,
  );
});

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
