import { dirname, isAbsolute, resolve } from "node:path";

import {
  assertPathOutsideRoots,
  assertSha256,
  readPinnedCanonicalJson,
  requireExactKeys,
} from "./release-tooling-io.mjs";

const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,255}$/u;
const CHANNEL_PATTERN = /^[a-z][a-z0-9-]{1,31}$/u;
const MAXIMUM_PLAN_BYTES = 1024 * 1024;
const MAXIMUM_RECORD_BYTES = 1024 * 1024;
const readBackDetails = new WeakMap();

export async function readPinnedReleaseReadBackPlan(input) {
  requireExactKeys(
    input,
    ["path", "sha256", "preparedPromotion", "outputPaths", "repositoryRoot", "candidateRoots"],
    "release read-back-plan input",
  );
  const file = await readPinnedCanonicalJson({
    label: "release read-back plan",
    maximumBytes: MAXIMUM_PLAN_BYTES,
    path: input.path,
    sha256: input.sha256,
  });
  const plan = parseReadBackPlan(file.value, input.preparedPromotion);
  const prohibitedRecordRoots = [
    input.repositoryRoot,
    dirname(input.outputPaths[0]),
    ...input.candidateRoots,
  ];
  assertPathOutsideRoots(file.path, prohibitedRecordRoots, "release read-back plan");
  for (const outputPath of input.outputPaths) {
    assertPathOutsideRoots(
      outputPath,
      [input.repositoryRoot, dirname(file.path), ...input.candidateRoots],
      "supported-channel receipt output",
    );
  }
  const promotionAttestation = await readPinnedCanonicalJson({
    label: "promotion attestation",
    maximumBytes: 4 * 1024 * 1024,
    path: plan.promotion.attestation.path,
    sha256: plan.promotion.attestation.sha256,
    indent: 2,
  });
  const loadedRecords = [];
  const sourceKeys = new Set();
  for (let index = 0; index < plan.readBackRecords.length; index += 1) {
    const reference = plan.readBackRecords[index];
    assertPathOutsideRoots(
      reference.file.path,
      prohibitedRecordRoots,
      "independent remote read-back record",
    );
    if (comparablePath(reference.file.path) === comparablePath(plan.promotion.attestation.path)) {
      throw new Error("The promotion attestation and read-back record paths must be distinct.");
    }
    const fileRecord = await readPinnedCanonicalJson({
      label: "independent remote read-back record",
      maximumBytes: MAXIMUM_RECORD_BYTES,
      path: reference.file.path,
      sha256: reference.file.sha256,
    });
    assertPathOutsideRoots(
      fileRecord.path,
      prohibitedRecordRoots,
      "independent remote read-back record",
    );
    const expectedRelease = input.preparedPromotion.verifiedCandidates[index];
    const record = parseReadBackRecord(fileRecord.value, {
      channel: plan.channel,
      expectedArchive: expectedRelease.archive,
      expectedTarget: expectedRelease.candidate.target,
      issuedAt: input.preparedPromotion.composed.statement.issuedAt,
      observedAt: plan.observedAt,
      releaseId: plan.releaseId,
      tag: plan.tag,
      uploaderId: plan.publication.uploaderId,
    });
    const sourceKey = `${record.source.provider}\0${record.source.immutableObjectId}`;
    if (sourceKeys.has(sourceKey)) {
      throw new Error("Independent remote read-back records contain a duplicated asset source.");
    }
    sourceKeys.add(sourceKey);
    loadedRecords.push(Object.freeze({ file: fileRecord, record }));
  }
  const handle = Object.freeze({
    channel: plan.channel,
    observedAt: plan.observedAt,
    planSha256: file.sha256,
    promotionAttestationPath: promotionAttestation.path,
    promotionAttestationSha256: promotionAttestation.sha256,
    publishedAssetReadBacks: Object.freeze(
      loadedRecords.map(({ record }) =>
        Object.freeze({
          target: record.target,
          readBackSha256: record.readBackSha256,
        }),
      ),
    ),
    receiptId: plan.receiptId,
    releaseId: plan.releaseId,
    tag: plan.tag,
    uploaderId: plan.publication.uploaderId,
    records: Object.freeze(
      loadedRecords.map(({ file: recordFile, record }) =>
        Object.freeze({
          target: record.target,
          provider: record.source.provider,
          readerId: record.source.readerId,
          recordSha256: recordFile.sha256,
          readBackSha256: record.readBackSha256,
        }),
      ),
    ),
  });
  const canonicalInputPaths = [
    file.path,
    promotionAttestation.path,
    ...loadedRecords.map(({ file: recordFile }) => recordFile.path),
  ].map(comparablePath);
  if (new Set(canonicalInputPaths).size !== canonicalInputPaths.length) {
    throw new Error("Release read-back inputs must remain canonically distinct.");
  }
  readBackDetails.set(
    handle,
    Object.freeze({
      file,
      loadedRecords,
      plan,
      prohibitedRecordRoots: Object.freeze([...prohibitedRecordRoots]),
      promotionAttestation,
    }),
  );
  return handle;
}

export async function revalidatePinnedReleaseReadBackPlan(handle) {
  const details = readBackDetails.get(handle);
  if (details === undefined) {
    throw new Error("An opaque pinned release read-back plan is required.");
  }
  const [currentPlan, currentPromotionAttestation, currentRecords] = await Promise.all([
    readPinnedCanonicalJson({
      label: "release read-back plan",
      maximumBytes: MAXIMUM_PLAN_BYTES,
      path: details.file.path,
      sha256: details.file.sha256,
    }),
    readPinnedCanonicalJson({
      label: "promotion attestation",
      maximumBytes: 4 * 1024 * 1024,
      path: details.promotionAttestation.path,
      sha256: details.promotionAttestation.sha256,
      indent: 2,
    }),
    Promise.all(
      details.plan.readBackRecords.map(({ file }) =>
        readPinnedCanonicalJson({
          label: "independent remote read-back record",
          maximumBytes: MAXIMUM_RECORD_BYTES,
          path: file.path,
          sha256: file.sha256,
        }),
      ),
    ),
  ]);
  assertSamePinnedFile(currentPlan, details.file, "release read-back plan");
  assertSamePinnedFile(
    currentPromotionAttestation,
    details.promotionAttestation,
    "promotion attestation",
  );
  for (let index = 0; index < currentRecords.length; index += 1) {
    assertSamePinnedFile(
      currentRecords[index],
      details.loadedRecords[index].file,
      "independent remote read-back record",
    );
    assertPathOutsideRoots(
      currentRecords[index].path,
      details.prohibitedRecordRoots,
      "independent remote read-back record",
    );
  }
}

function assertSamePinnedFile(current, original, label) {
  if (
    comparablePath(current.path) !== comparablePath(original.path) ||
    current.sha256 !== original.sha256 ||
    current.size !== original.size
  ) {
    throw new Error(`The pinned ${label} identity changed during release authorization.`);
  }
}

function parseReadBackPlan(value, prepared) {
  requireExactKeys(
    value,
    [
      "schemaVersion",
      "product",
      "releaseId",
      "channel",
      "tag",
      "receiptId",
      "observedAt",
      "publication",
      "promotion",
      "readBackRecords",
    ],
    "release read-back plan",
  );
  if (
    value.schemaVersion !== 1 ||
    value.product !== "OpenDelegate" ||
    value.releaseId !== prepared.releaseId ||
    value.channel !== prepared.channel ||
    !CHANNEL_PATTERN.test(value.channel) ||
    value.tag !== `v${prepared.composed.statement.productVersion}` ||
    !EXTERNAL_ID_PATTERN.test(value.receiptId) ||
    !isRfc3339Instant(value.observedAt)
  ) {
    throw new Error("The release read-back plan identity, channel, or tag is invalid.");
  }
  requireExactKeys(value.publication, ["uploaderId", "immutable"], "publication description");
  if (
    !EXTERNAL_ID_PATTERN.test(value.publication.uploaderId) ||
    value.publication.immutable !== true
  ) {
    throw new Error("The publication must identify an external immutable uploader.");
  }
  requireExactKeys(value.promotion, ["planSha256", "attestation"], "read-back promotion binding");
  assertSha256(value.promotion.planSha256, "promotion plan digest");
  if (value.promotion.planSha256 !== prepared.planSha256) {
    throw new Error("The read-back plan does not bind the exact promotion plan.");
  }
  const promotionAttestation = parsePinnedFile(
    value.promotion.attestation,
    "promotion attestation",
  );
  if (
    !Array.isArray(value.readBackRecords) ||
    value.readBackRecords.length !== prepared.verifiedCandidates.length
  ) {
    throw new Error("The read-back plan requires the exact promoted asset set.");
  }
  const paths = new Set();
  const readBackRecords = value.readBackRecords.map((reference, index) => {
    requireExactKeys(reference, ["target", "file"], "remote read-back reference");
    const expectedTarget = prepared.verifiedCandidates[index].candidate.target;
    const target = parseTarget(reference.target, "remote read-back reference target");
    if (
      target.platform !== expectedTarget.platform ||
      target.architecture !== expectedTarget.architecture
    ) {
      throw new Error("The read-back plan target order does not match the exact promotion.");
    }
    const file = parsePinnedFile(reference.file, "remote read-back record");
    const comparable = comparablePath(file.path);
    if (paths.has(comparable)) {
      throw new Error("The read-back plan contains a duplicated record path.");
    }
    paths.add(comparable);
    return Object.freeze({ target, file });
  });
  if (paths.has(comparablePath(promotionAttestation.path))) {
    throw new Error("The promotion attestation and read-back record paths must be distinct.");
  }
  return Object.freeze({
    schemaVersion: 1,
    product: "OpenDelegate",
    releaseId: value.releaseId,
    channel: value.channel,
    tag: value.tag,
    receiptId: value.receiptId,
    observedAt: value.observedAt,
    publication: Object.freeze({
      uploaderId: value.publication.uploaderId,
      immutable: true,
    }),
    promotion: Object.freeze({
      planSha256: value.promotion.planSha256,
      attestation: promotionAttestation,
    }),
    readBackRecords: Object.freeze(readBackRecords),
  });
}

function parseReadBackRecord(value, expected) {
  requireExactKeys(
    value,
    [
      "schemaVersion",
      "product",
      "type",
      "releaseId",
      "channel",
      "tag",
      "target",
      "asset",
      "source",
      "readBackSha256",
      "observedAt",
    ],
    "independent remote read-back record",
  );
  const target = parseTarget(value.target, "independent remote read-back target");
  const asset = parseAsset(value.asset);
  requireExactKeys(value.source, ["provider", "immutableObjectId", "readerId"], "read-back source");
  if (
    value.schemaVersion !== 1 ||
    value.product !== "OpenDelegate" ||
    value.type !== "independent-remote-read-back" ||
    value.releaseId !== expected.releaseId ||
    value.channel !== expected.channel ||
    value.tag !== expected.tag ||
    target.platform !== expected.expectedTarget.platform ||
    target.architecture !== expected.expectedTarget.architecture ||
    JSON.stringify(asset) !== JSON.stringify(expected.expectedArchive) ||
    typeof value.source.provider !== "string" ||
    value.source.provider.length < 1 ||
    value.source.provider.length > 128 ||
    typeof value.source.immutableObjectId !== "string" ||
    value.source.immutableObjectId.length < 1 ||
    value.source.immutableObjectId.length > 1024 ||
    !EXTERNAL_ID_PATTERN.test(value.source.readerId) ||
    value.source.readerId === expected.uploaderId ||
    value.readBackSha256 !== asset.sha256 ||
    !isRfc3339Instant(value.observedAt) ||
    Date.parse(value.observedAt) < Date.parse(expected.issuedAt) ||
    Date.parse(value.observedAt) > Date.parse(expected.observedAt)
  ) {
    throw new Error(
      "The independent remote read-back does not match the immutable promoted asset.",
    );
  }
  return Object.freeze({
    target,
    asset,
    source: Object.freeze({
      provider: value.source.provider,
      immutableObjectId: value.source.immutableObjectId,
      readerId: value.source.readerId,
    }),
    readBackSha256: value.readBackSha256,
    observedAt: value.observedAt,
  });
}

function parseAsset(value) {
  requireExactKeys(value, ["path", "size", "sha256"], "remote published asset");
  if (
    typeof value.path !== "string" ||
    value.path.length < 1 ||
    value.path.includes("/") ||
    value.path.includes("\\") ||
    !Number.isSafeInteger(value.size) ||
    value.size < 1
  ) {
    throw new Error("The remote published asset identity is invalid.");
  }
  assertSha256(value.sha256, "remote published asset digest");
  return Object.freeze({ path: value.path, size: value.size, sha256: value.sha256 });
}

function parsePinnedFile(value, label) {
  requireExactKeys(value, ["path", "sha256"], label);
  if (typeof value.path !== "string" || !isAbsolute(value.path) || value.path.includes("\0")) {
    throw new Error(`The ${label} path must be absolute.`);
  }
  assertSha256(value.sha256, `${label} pin`);
  return Object.freeze({ path: resolve(value.path), sha256: value.sha256 });
}

function parseTarget(value, label) {
  requireExactKeys(value, ["platform", "architecture"], label);
  if (!(
    (value.platform === "darwin" && value.architecture === "arm64") ||
    (value.platform === "linux" && value.architecture === "x64") ||
    (value.platform === "win32" && value.architecture === "x64")
  )) {
    throw new Error(`The ${label} is not a first-milestone target.`);
  }
  return Object.freeze({ platform: value.platform, architecture: value.architecture });
}

function comparablePath(path) {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isRfc3339Instant(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
