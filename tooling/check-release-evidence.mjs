import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const IMPLEMENTATION_STATUSES = new Set(["missing", "partial", "verified"]);
const LIVE_PROOF_STATUSES = new Set(["not-run", "blocked-external", "verified"]);
const RELEASE_STATUSES = new Set(["blocked", "candidate", "released"]);
const CRITERION_COUNT = 36;
const TOP_LEVEL_KEYS = new Set([
  "$schema",
  "schemaVersion",
  "product",
  "milestone",
  "auditedAt",
  "sourceCommit",
  "releaseStatus",
  "criteria",
  "candidateAttestation",
]);
const CRITERION_KEYS = new Set([
  "id",
  "title",
  "implementationStatus",
  "liveProofStatus",
  "evidence",
  "nextGate",
  "verification",
]);
const VERIFICATION_KEYS = new Set(["implementation", "liveProof"]);
const PROOF_KEYS = new Set(["sourceCommit", "attestationId", "evidence"]);
const EVIDENCE_REFERENCE_KEYS = new Set(["path", "sha256"]);
const CANDIDATE_ATTESTATION_KEYS = new Set(["sourceCommit", "attestationId", "evidence"]);
const FULL_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ATTESTATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{7,255}$/;
const RFC3339_PATTERN =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

export async function auditReleaseEvidence(repositoryRoot, ledger) {
  const errors = [];

  if (ledger === null || typeof ledger !== "object" || Array.isArray(ledger)) {
    return ["Release evidence must be a JSON object."];
  }

  auditExactKeys(ledger, TOP_LEVEL_KEYS, "Release evidence", errors);
  if (ledger.schemaVersion !== 1) {
    errors.push("Release evidence schemaVersion must be 1.");
  }
  if (ledger.product !== "OpenDelegate") {
    errors.push("Release evidence product must be OpenDelegate.");
  }
  if (ledger.milestone !== "first") {
    errors.push("Release evidence milestone must be first.");
  }
  if (!isRfc3339Instant(ledger.auditedAt)) {
    errors.push("Release evidence auditedAt must be a valid RFC3339 instant.");
  }
  if (typeof ledger.sourceCommit !== "string" || !COMMIT_PATTERN.test(ledger.sourceCommit)) {
    errors.push("Release evidence sourceCommit must be a full 40-character lowercase Git commit.");
  }
  if (!RELEASE_STATUSES.has(ledger.releaseStatus)) {
    errors.push("Release evidence has an unsupported releaseStatus.");
  }
  if (!Array.isArray(ledger.criteria) || ledger.criteria.length !== CRITERION_COUNT) {
    errors.push(`Release evidence must contain exactly ${CRITERION_COUNT} criteria.`);
    return errors;
  }

  let canonicalRepositoryRoot;
  try {
    canonicalRepositoryRoot = await realpath(repositoryRoot);
  } catch {
    errors.push("Release evidence repository root is not resolvable.");
    return errors.sort((left, right) => left.localeCompare(right));
  }

  const ids = new Set();
  for (const criterion of ledger.criteria) {
    if (criterion === null || typeof criterion !== "object" || Array.isArray(criterion)) {
      errors.push("Every release criterion must be an object.");
      continue;
    }

    const id = criterion.id;
    auditExactKeys(criterion, CRITERION_KEYS, `Release criterion ${String(id)}`, errors);
    if (!Number.isSafeInteger(id) || id < 1 || id > CRITERION_COUNT) {
      errors.push(`Release criterion ID ${String(id)} is outside 1-${CRITERION_COUNT}.`);
      continue;
    }
    if (ids.has(id)) {
      errors.push(`Release criterion ${id} appears more than once.`);
    }
    ids.add(id);

    if (typeof criterion.title !== "string" || criterion.title.trim() === "") {
      errors.push(`Release criterion ${id} has no title.`);
    }
    if (!IMPLEMENTATION_STATUSES.has(criterion.implementationStatus)) {
      errors.push(`Release criterion ${id} has an invalid implementationStatus.`);
    }
    if (!LIVE_PROOF_STATUSES.has(criterion.liveProofStatus)) {
      errors.push(`Release criterion ${id} has an invalid liveProofStatus.`);
    }
    if (typeof criterion.nextGate !== "string" || criterion.nextGate.trim() === "") {
      errors.push(`Release criterion ${id} has no nextGate.`);
    }
    if (!Array.isArray(criterion.evidence)) {
      errors.push(`Release criterion ${id} evidence must be an array.`);
      continue;
    }
    if (new Set(criterion.evidence).size !== criterion.evidence.length) {
      errors.push(`Release criterion ${id} evidence paths must be unique.`);
    }
    if (
      (criterion.implementationStatus === "verified" || criterion.liveProofStatus === "verified") &&
      criterion.evidence.length === 0
    ) {
      errors.push(`Verified release criterion ${id} must reference durable evidence.`);
    }

    const evidenceHashes = new Map();
    for (const evidencePath of criterion.evidence) {
      const result = await auditEvidencePath(
        canonicalRepositoryRoot,
        evidencePath,
        `Release criterion ${id}`,
        errors,
      );
      if (result !== undefined) {
        evidenceHashes.set(evidencePath, result.sha256);
      }
    }

    auditCriterionVerification(criterion, ledger.sourceCommit, evidenceHashes, errors);
  }

  for (let id = 1; id <= CRITERION_COUNT; id += 1) {
    if (!ids.has(id)) {
      errors.push(`Release criterion ${id} is missing.`);
    }
  }

  const complete = ledger.criteria.every(
    (criterion) =>
      criterion.implementationStatus === "verified" && criterion.liveProofStatus === "verified",
  );
  if (complete && ledger.releaseStatus === "blocked") {
    errors.push("A complete evidence ledger cannot remain blocked.");
  }
  if (!complete && ledger.releaseStatus !== "blocked") {
    errors.push("A candidate or released ledger requires all 36 criteria to be verified.");
  }
  await auditCandidateAttestation(canonicalRepositoryRoot, ledger, complete, errors);

  return errors.sort((left, right) => left.localeCompare(right));
}

export function summarizeReleaseEvidence(ledger) {
  const implementation = countBy(ledger.criteria, "implementationStatus");
  const liveProof = countBy(ledger.criteria, "liveProofStatus");
  return {
    releaseStatus: ledger.releaseStatus,
    implementation,
    liveProof,
    complete: implementation.verified === CRITERION_COUNT && liveProof.verified === CRITERION_COUNT,
  };
}

function countBy(criteria, key) {
  const counts = {};
  for (const criterion of criteria) {
    const value = criterion[key];
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function auditCriterionVerification(criterion, ledgerCommit, evidenceHashes, errors) {
  const id = criterion.id;
  const verification = criterion.verification;
  if (verification !== undefined) {
    if (!isRecord(verification)) {
      errors.push(`Release criterion ${id} verification must be an object.`);
      return;
    }
    auditExactKeys(verification, VERIFICATION_KEYS, `Release criterion ${id} verification`, errors);
  }

  auditProof({
    expected: criterion.implementationStatus === "verified",
    label: `Release criterion ${id} implementation verification`,
    proof: isRecord(verification) ? verification.implementation : undefined,
    ledgerCommit,
    evidenceHashes,
    errors,
  });
  auditProof({
    expected: criterion.liveProofStatus === "verified",
    label: `Release criterion ${id} live-proof verification`,
    proof: isRecord(verification) ? verification.liveProof : undefined,
    ledgerCommit,
    evidenceHashes,
    errors,
  });
}

function auditProof({ expected, label, proof, ledgerCommit, evidenceHashes, errors }) {
  if (!expected) {
    if (proof !== undefined) {
      errors.push(`${label} must be absent until its status is verified.`);
    }
    return;
  }
  if (!isRecord(proof)) {
    errors.push(`${label} is required for verified status.`);
    return;
  }
  auditExactKeys(proof, PROOF_KEYS, label, errors);
  if (!FULL_COMMIT_PATTERN.test(proof.sourceCommit ?? "") || proof.sourceCommit !== ledgerCommit) {
    errors.push(`${label} sourceCommit must equal the ledger's full 40-character commit.`);
  }
  if (typeof proof.attestationId !== "string" || !ATTESTATION_PATTERN.test(proof.attestationId)) {
    errors.push(`${label} has an invalid attestationId.`);
  }
  auditHashedEvidence(proof.evidence, evidenceHashes, label, errors);
}

async function auditCandidateAttestation(repositoryRoot, ledger, complete, errors) {
  const attestation = ledger.candidateAttestation;
  if (!complete) {
    if (attestation !== undefined) {
      errors.push("candidateAttestation must be absent while release evidence is incomplete.");
    }
    return;
  }
  if (!isRecord(attestation)) {
    errors.push("Complete release evidence requires a candidateAttestation.");
    return;
  }
  auditExactKeys(attestation, CANDIDATE_ATTESTATION_KEYS, "candidateAttestation", errors);
  if (
    !FULL_COMMIT_PATTERN.test(attestation.sourceCommit ?? "") ||
    attestation.sourceCommit !== ledger.sourceCommit
  ) {
    errors.push(
      "candidateAttestation sourceCommit must equal the ledger's full 40-character commit.",
    );
  }
  if (
    typeof attestation.attestationId !== "string" ||
    !ATTESTATION_PATTERN.test(attestation.attestationId)
  ) {
    errors.push("candidateAttestation has an invalid attestationId.");
  }
  if (!Array.isArray(attestation.evidence) || attestation.evidence.length === 0) {
    errors.push("candidateAttestation evidence must be a non-empty array.");
    return;
  }
  const hashes = new Map();
  for (const reference of attestation.evidence) {
    if (!isRecord(reference) || typeof reference.path !== "string") {
      continue;
    }
    const result = await auditEvidencePath(
      repositoryRoot,
      reference.path,
      "candidateAttestation",
      errors,
    );
    if (result !== undefined) {
      hashes.set(reference.path, result.sha256);
    }
  }
  auditHashedEvidence(attestation.evidence, hashes, "candidateAttestation", errors);
}

function auditHashedEvidence(references, evidenceHashes, label, errors) {
  if (!Array.isArray(references) || references.length === 0) {
    errors.push(`${label} evidence must be a non-empty array.`);
    return;
  }
  const paths = new Set();
  for (const reference of references) {
    if (!isRecord(reference)) {
      errors.push(`${label} evidence entries must be objects.`);
      continue;
    }
    auditExactKeys(reference, EVIDENCE_REFERENCE_KEYS, `${label} evidence`, errors);
    if (typeof reference.path !== "string" || !evidenceHashes.has(reference.path)) {
      errors.push(`${label} references an unaudited evidence path.`);
      continue;
    }
    if (paths.has(reference.path)) {
      errors.push(`${label} evidence paths must be unique.`);
    }
    paths.add(reference.path);
    if (
      typeof reference.sha256 !== "string" ||
      !SHA256_PATTERN.test(reference.sha256) ||
      reference.sha256 !== evidenceHashes.get(reference.path)
    ) {
      errors.push(`${label} has an invalid evidence SHA-256 for ${reference.path}.`);
    }
  }
}

async function auditEvidencePath(repositoryRoot, evidencePath, label, errors) {
  if (
    typeof evidencePath !== "string" ||
    evidencePath.trim() === "" ||
    isAbsolute(evidencePath) ||
    evidencePath.includes("\\")
  ) {
    errors.push(`${label} has an invalid relative evidence path.`);
    return undefined;
  }
  const resolved = resolve(repositoryRoot, evidencePath);
  if (!isWithin(repositoryRoot, resolved)) {
    errors.push(`${label} evidence escapes the repository.`);
    return undefined;
  }
  try {
    const metadata = await lstat(resolved);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      errors.push(`${label} evidence must be a regular, non-symlink file: ${evidencePath}.`);
      return undefined;
    }
    const canonical = await realpath(resolved);
    if (!isWithin(repositoryRoot, canonical)) {
      errors.push(`${label} evidence escapes the canonical repository.`);
      return undefined;
    }
    const bytes = await readFile(canonical);
    return {
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch {
    errors.push(`${label} references missing evidence ${evidencePath}.`);
    return undefined;
  }
}

function auditExactKeys(value, allowed, label, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      errors.push(`${label} has unsupported field ${key}.`);
    }
  }
}

function isRfc3339Instant(value) {
  if (typeof value !== "string" || !RFC3339_PATTERN.test(value)) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

function isWithin(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent !== "" &&
    pathFromParent !== ".." &&
    !pathFromParent.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromParent)
  );
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readLedger(repositoryRoot) {
  const path = join(repositoryRoot, "docs", "release", "acceptance-evidence.json");
  return JSON.parse(await readFile(path, "utf8"));
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);

if (invokedFile === resolve(currentFile)) {
  const repositoryRoot = resolve(dirname(currentFile), "..");
  const ledger = await readLedger(repositoryRoot);
  const errors = await auditReleaseEvidence(repositoryRoot, ledger);

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
  } else {
    const summary = summarizeReleaseEvidence(ledger);
    console.log(JSON.stringify(summary, null, 2));
    if (process.argv.includes("--require-complete") && !summary.complete) {
      console.error("OpenDelegate is not release-complete.");
      process.exitCode = 1;
    }
  }
}
