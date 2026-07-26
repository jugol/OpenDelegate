import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { releaseSignerBrokerProtocol } from "./external-release-signer.mjs";
import { publishNewDirectoryTree, requireExactKeys } from "./release-tooling-io.mjs";

const currentFile = fileURLToPath(import.meta.url);
const PLACEHOLDER_SHA256 = "0".repeat(64);
const PLACEHOLDER_KEY_ID = `sha256:${PLACEHOLDER_SHA256}`;
const PLACEHOLDER_COMMIT = "0".repeat(40);
const PLACEHOLDER_ISSUED_AT = "2099-01-01T00:00:00.000Z";
const PLACEHOLDER_OBSERVED_AT = "2099-01-01T00:05:00.000Z";
const PLACEHOLDER_PRODUCT_VERSION = "0.1.0-alpha.1";
const maximumExampleFileBytes = 4 * 1024 * 1024;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const keyIdPattern = /^sha256:[0-9a-f]{64}$/u;
const commitPattern = /^[0-9a-f]{40}$/u;
const externalIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:+/-]{7,255}$/u;
const portablePathPattern = /^[A-Za-z0-9._/-]+$/u;
const channelPattern = /^[a-z][a-z0-9-]{1,31}$/u;
const privateKeyPattern = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u;
const prohibitedJsonKeyPattern = /credential|password|private.?key|secret|token/iu;

const FIRST_MILESTONE_TARGETS = Object.freeze([
  Object.freeze({ platform: "darwin", architecture: "arm64" }),
  Object.freeze({ platform: "linux", architecture: "x64" }),
  Object.freeze({ platform: "win32", architecture: "x64" }),
]);

export const RELEASE_EXAMPLE_PATHS = Object.freeze([
  "README.md",
  "plans/configuration-publisher-only-plan.json",
  "plans/configuration-released-plan.json",
  "plans/promotion-plan.json",
  "plans/read-back-plan.json",
  "signing/promotion-policy.json",
  "signing/publisher-policy.json",
]);

export function parseReleaseExamplesArguments(values) {
  const arguments_ = values[0] === "--" ? values.slice(1) : values;
  if (arguments_.includes("--help") || arguments_.includes("-h")) {
    return { help: true };
  }
  const parsed = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (
      name !== "--destination" ||
      value === undefined ||
      value.startsWith("--") ||
      parsed.has(name)
    ) {
      throw new Error(`Invalid or duplicate release-example option: ${String(name)}.`);
    }
    parsed.set(name, value);
  }
  if (!parsed.has("--destination")) {
    throw new Error("--destination is required.");
  }
  const destination = parsed.get("--destination");
  if (!isAbsolute(destination) || destination.includes("\0")) {
    throw new Error("--destination must be an absolute path.");
  }
  return { destination: resolve(destination) };
}

export async function createReleaseExamples(input, dependencies = {}) {
  requireExactKeys(input, ["destination"], "release-example input");
  if (
    typeof input.destination !== "string" ||
    !isAbsolute(input.destination) ||
    input.destination.includes("\0")
  ) {
    throw new Error("The release-example destination must be an absolute new path.");
  }
  const destination = resolve(input.destination);
  const entries = createReleaseExampleEntries(destination);
  const publish = dependencies.publishDirectory ?? publishNewDirectoryTree;
  const published = await publish(destination, entries, {
    async verifyPublished(root) {
      await validateReleaseExampleSet({ expectedDestination: destination, root });
      await dependencies.verifyPublished?.(root);
    },
    async verifyStaged(root) {
      await validateReleaseExampleSet({ expectedDestination: destination, root });
      await dependencies.verifyStaged?.(root);
    },
  });
  const promotionEntry = entries.find(({ path }) => path === "plans/promotion-plan.json");
  return Object.freeze({
    ...published,
    promotionPlanSha256: digestBytes(promotionEntry.bytes),
  });
}

export async function validateReleaseExampleSet(input, dependencies = {}) {
  requireExactKeys(input, ["expectedDestination", "root"], "release-example validation input");
  for (const [value, label] of [
    [input.expectedDestination, "expected release-example destination"],
    [input.root, "release-example validation root"],
  ]) {
    if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
      throw new Error(`The ${label} must be an absolute path.`);
    }
  }
  const expectedDestination = resolve(input.expectedDestination);
  const root = resolve(input.root);
  const paths = await listRegularExampleFiles(root);
  if (JSON.stringify(paths) !== JSON.stringify(RELEASE_EXAMPLE_PATHS)) {
    throw new Error("The release-example file inventory does not match the strict schema.");
  }
  const readme = await readBoundedText(join(root, "README.md"), dependencies);
  if (
    readme !== renderReleaseExampleReadme() ||
    !readme.includes("NOT-A-RELEASE") ||
    !readme.includes("PLACEHOLDER")
  ) {
    throw new Error("The release-example safety README is invalid.");
  }

  const documents = Object.fromEntries(
    await Promise.all(
      RELEASE_EXAMPLE_PATHS.filter((path) => path.endsWith(".json")).map(async (path) => [
        path,
        await readCanonicalExampleJson(join(root, ...path.split("/")), dependencies),
      ]),
    ),
  );
  const files = Object.fromEntries(
    Object.entries(documents).map(([path, document]) => [path, document.value]),
  );
  const promotion = validatePromotionPlan(files["plans/promotion-plan.json"]);
  const promotionBytes = Buffer.from(documents["plans/promotion-plan.json"].text, "utf8");
  const readBack = validateReadBackPlan(
    files["plans/read-back-plan.json"],
    promotion,
    digestBytes(promotionBytes),
  );
  validateConfigurationPlan(
    files["plans/configuration-publisher-only-plan.json"],
    "publisher-only",
    promotion,
    readBack,
  );
  validateConfigurationPlan(
    files["plans/configuration-released-plan.json"],
    "released",
    promotion,
    readBack,
  );
  const promotionPolicy = validateSigningPolicy(
    files["signing/promotion-policy.json"],
    "promotion",
  );
  const publisherPolicy = validateSigningPolicy(
    files["signing/publisher-policy.json"],
    "publisher",
  );
  assertDistinct(
    [
      promotionPolicy.publicKey.path,
      promotionPolicy.broker.transportPublicKey.path,
      publisherPolicy.publicKey.path,
      publisherPolicy.broker.transportPublicKey.path,
      promotionPolicy.broker.endpoint,
      publisherPolicy.broker.endpoint,
    ],
    "release-example signing authority paths and endpoints",
  );

  for (const [path, value] of Object.entries(files)) {
    assertCredentialFreeJson(value, path);
    const { text } = documents[path];
    if (!text.includes("PLACEHOLDER") || privateKeyPattern.test(text)) {
      throw new Error(`The ${path} PLACEHOLDER credential-free safeguard is missing.`);
    }
  }
  if (privateKeyPattern.test(readme)) {
    throw new Error("Release examples must never contain private key material.");
  }
  assertExamplePathsUseDestination(promotion, readBack, expectedDestination);
  return Object.freeze({
    files: Object.freeze([...paths]),
    promotionPlanSha256: digestBytes(promotionBytes),
  });
}

export function renderReleaseExamplesHelp() {
  return `Create credential-free OpenDelegate release input skeletons.

Usage:
  pnpm release:examples -- --destination ABSOLUTE_NEW_DIRECTORY

The destination must not exist. The command publishes one rollback-safe directory,
strictly validates every canonical JSON skeleton, and never writes credentials or
private keys. Every result is marked PLACEHOLDER and NOT-A-RELEASE; replace and
re-pin all documented fields before using any production release command.
`;
}

function createReleaseExampleEntries(destination) {
  const externalRoot = join(dirname(destination), "PLACEHOLDER-release-inputs");
  const promotion = createPromotionPlan(externalRoot);
  const promotionBytes = canonicalJsonBytes(promotion);
  const readBack = createReadBackPlan(externalRoot, promotion, digestBytes(promotionBytes));
  const publisherOnly = createConfigurationPlan(
    "publisher-only",
    externalRoot,
    promotion,
    readBack,
  );
  const released = createConfigurationPlan("released", externalRoot, promotion, readBack);
  const publisherPolicy = createSigningPolicy(externalRoot, "publisher");
  const promotionPolicy = createSigningPolicy(externalRoot, "promotion");
  const bytesByPath = new Map([
    ["README.md", Buffer.from(renderReleaseExampleReadme(), "utf8")],
    ["plans/configuration-publisher-only-plan.json", canonicalJsonBytes(publisherOnly)],
    ["plans/configuration-released-plan.json", canonicalJsonBytes(released)],
    ["plans/promotion-plan.json", promotionBytes],
    ["plans/read-back-plan.json", canonicalJsonBytes(readBack)],
    ["signing/promotion-policy.json", canonicalJsonBytes(promotionPolicy)],
    ["signing/publisher-policy.json", canonicalJsonBytes(publisherPolicy)],
  ]);
  return RELEASE_EXAMPLE_PATHS.map((path) =>
    Object.freeze({
      path,
      bytes: bytesByPath.get(path),
      mode: 0o600,
    }),
  );
}

function createPromotionPlan(externalRoot) {
  const candidates = FIRST_MILESTONE_TARGETS.map((target) => {
    const name = targetName(target);
    const identities =
      target.platform === "darwin"
        ? ["PLACEHOLDER-apple-team-ABCDEFGHIJ"]
        : target.platform === "win32"
          ? [`PLACEHOLDER-authenticode-sha1-${"A".repeat(40)}`]
          : [];
    return {
      target,
      root: join(externalRoot, "candidates", name),
      expectedManifestSha256: PLACEHOLDER_SHA256,
      expectedCandidateDigest: PLACEHOLDER_SHA256,
      archive: placeholderPinnedFile(externalRoot, `archives/opendelegate-${name}.zip`),
      publisherAttestation: placeholderPinnedFile(
        externalRoot,
        `publisher/${name}.publisher-attestation.json`,
      ),
      publisherTrustRoot: placeholderPinnedFile(
        externalRoot,
        `publisher/${name}.publisher-public.pem`,
      ),
      platformAuthenticity: {
        recordSha256: PLACEHOLDER_SHA256,
        certificateIdentities: identities,
        productCertificateIdentity: identities[0] ?? null,
        verificationEvidence: [
          {
            statementPath: `docs/release/evidence/platform-${name}.json`,
            file: placeholderPinnedFile(externalRoot, `platform-evidence/platform-${name}.json`),
          },
        ],
      },
    };
  });
  return {
    schemaVersion: 1,
    product: "OpenDelegate",
    releaseId: "PLACEHOLDER-release-0001",
    channel: "stable",
    issuedAt: PLACEHOLDER_ISSUED_AT,
    statementId: "PLACEHOLDER-promotion-statement-0001",
    source: {
      buildCommit: PLACEHOLDER_COMMIT,
    },
    candidates,
    supportMatrix: {
      statementPath: "docs/release/SUPPORT_MATRIX.md",
      file: placeholderPinnedFile(externalRoot, "evidence/SUPPORT_MATRIX.md"),
    },
    notarizationReceipt: {
      statementPath: "docs/release/evidence/macos-notarization.json",
      file: placeholderPinnedFile(externalRoot, "evidence/macos-notarization.json"),
    },
    liveEvidence: createLiveEvidence(externalRoot),
    revocations: emptyRevocations(),
  };
}

function createReadBackPlan(externalRoot, promotion, promotionPlanSha256) {
  return {
    schemaVersion: 1,
    product: "OpenDelegate",
    releaseId: promotion.releaseId,
    channel: promotion.channel,
    tag: `v${PLACEHOLDER_PRODUCT_VERSION}`,
    receiptId: "PLACEHOLDER-supported-channel-receipt-0001",
    observedAt: PLACEHOLDER_OBSERVED_AT,
    publication: {
      uploaderAuthorityKeyId: PLACEHOLDER_KEY_ID,
      immutable: true,
    },
    promotion: {
      planSha256: promotionPlanSha256,
      attestation: placeholderPinnedFile(externalRoot, "promotion/promotion-attestation.json"),
    },
    readBackRecords: FIRST_MILESTONE_TARGETS.map((target) => {
      const name = targetName(target);
      return {
        target,
        expectedSource: {
          provider: "PLACEHOLDER-immutable-provider",
          immutableObjectId: `PLACEHOLDER-object-${name}`,
          immutableObjectVersion: `PLACEHOLDER-version-${name}`,
        },
        envelope: placeholderPinnedFile(
          externalRoot,
          `read-back/${name}.observation-envelope.json`,
        ),
      };
    }),
  };
}

function createConfigurationPlan(mode, externalRoot, promotion, readBack) {
  const candidate = promotion.candidates[0];
  return {
    schemaVersion: 1,
    product: "OpenDelegate",
    mode,
    source: {
      buildCommit: promotion.source.buildCommit,
    },
    candidate: {
      target: candidate.target,
      root: candidate.root,
      expectedManifestSha256: candidate.expectedManifestSha256,
      expectedCandidateDigest: candidate.expectedCandidateDigest,
      archive: candidate.archive,
      publisherAttestation: candidate.publisherAttestation,
      publisherTrustRoot: candidate.publisherTrustRoot,
    },
    promotion:
      mode === "publisher-only"
        ? null
        : {
            promotionAttestation: readBack.promotion.attestation,
            supportedChannelReceipt: placeholderPinnedFile(
              externalRoot,
              "promotion/supported-channel-receipt.json",
            ),
            promotionTrustRoot: placeholderPinnedFile(
              externalRoot,
              "promotion/promotion-public.pem",
            ),
            observerTrustRoot: placeholderPinnedFile(externalRoot, "read-back/observer-public.pem"),
            readBackObservations: readBack.readBackRecords.map(({ target, envelope }) => ({
              target,
              envelope,
            })),
            supportMatrix: promotion.supportMatrix,
            notarizationReceipt: promotion.notarizationReceipt,
            liveEvidence: promotion.liveEvidence,
          },
    policy: emptyRevocations(),
  };
}

function createSigningPolicy(externalRoot, role) {
  return {
    schemaVersion: 2,
    product: "OpenDelegate",
    role,
    publicKey: placeholderPinnedFile(externalRoot, `signing/${role}-release-public.pem`),
    broker: {
      protocol: releaseSignerBrokerProtocol,
      endpoint:
        process.platform === "win32"
          ? `\\\\.\\pipe\\opendelegate-PLACEHOLDER-${role}`
          : `/tmp/opendelegate-PLACEHOLDER-${role}.sock`,
      transportPublicKey: placeholderPinnedFile(
        externalRoot,
        `signing/${role}-broker-transport-public.pem`,
      ),
      timeoutMs: 30_000,
    },
  };
}

function createLiveEvidence(externalRoot) {
  return Array.from({ length: 36 }, (_, index) => {
    const criterion = String(index + 1).padStart(2, "0");
    return {
      criterionId: index + 1,
      statementPath: `docs/release/evidence/live-criterion-${criterion}.json`,
      file: placeholderPinnedFile(externalRoot, `live-evidence/live-criterion-${criterion}.json`),
    };
  });
}

function emptyRevocations() {
  return {
    revokedCertificateIdentities: [],
    revokedObserverKeyIds: [],
    revokedPromotionKeyIds: [],
    revokedPublisherKeyIds: [],
    revokedStatementIds: [],
  };
}

function placeholderPinnedFile(externalRoot, suffix) {
  return {
    path: join(externalRoot, ...suffix.split("/")),
    sha256: PLACEHOLDER_SHA256,
  };
}

function validatePromotionPlan(value) {
  requireCanonicalKeys(
    value,
    [
      "schemaVersion",
      "product",
      "releaseId",
      "channel",
      "issuedAt",
      "statementId",
      "source",
      "candidates",
      "supportMatrix",
      "notarizationReceipt",
      "liveEvidence",
      "revocations",
    ],
    "promotion plan",
  );
  if (
    value.schemaVersion !== 1 ||
    value.product !== "OpenDelegate" ||
    !value.releaseId.startsWith("PLACEHOLDER-") ||
    !externalIdPattern.test(value.releaseId) ||
    !channelPattern.test(value.channel) ||
    value.channel === "release-candidate" ||
    value.channel.includes("preview") ||
    value.issuedAt !== PLACEHOLDER_ISSUED_AT ||
    !value.statementId.startsWith("PLACEHOLDER-") ||
    !externalIdPattern.test(value.statementId)
  ) {
    throw new Error("The promotion plan PLACEHOLDER identity is invalid.");
  }
  requireCanonicalKeys(value.source, ["buildCommit"], "promotion source");
  if (
    value.source.buildCommit !== PLACEHOLDER_COMMIT ||
    !commitPattern.test(value.source.buildCommit)
  ) {
    throw new Error("The promotion source PLACEHOLDER commit is invalid.");
  }
  if (!Array.isArray(value.candidates) || value.candidates.length !== 3) {
    throw new Error("The promotion plan requires the exact first-milestone targets.");
  }
  const candidates = value.candidates.map((candidate, index) =>
    validatePromotionCandidate(candidate, FIRST_MILESTONE_TARGETS[index]),
  );
  const supportMatrix = validateEvidence(value.supportMatrix, "support matrix");
  if (supportMatrix.statementPath !== "docs/release/SUPPORT_MATRIX.md") {
    throw new Error("The promotion support matrix statement path is invalid.");
  }
  const notarizationReceipt = validateEvidence(
    value.notarizationReceipt,
    "macOS notarization receipt",
  );
  if (notarizationReceipt.statementPath !== "docs/release/evidence/macos-notarization.json") {
    throw new Error("The promotion notarization statement path is invalid.");
  }
  const liveEvidence = validateLiveEvidence(value.liveEvidence, "promotion");
  const revocations = validateRevocations(value.revocations, "promotion");
  assertDistinct(
    [
      supportMatrix.file.path,
      notarizationReceipt.file.path,
      ...liveEvidence.map(({ file }) => file.path),
      ...candidates.flatMap((candidate) => [
        candidate.archive.path,
        candidate.publisherAttestation.path,
        candidate.publisherTrustRoot.path,
        ...candidate.platformAuthenticity.verificationEvidence.map(({ file }) => file.path),
      ]),
    ],
    "promotion pinned input paths",
  );
  return Object.freeze({
    ...value,
    candidates: Object.freeze(candidates),
    supportMatrix,
    notarizationReceipt,
    liveEvidence: Object.freeze(liveEvidence),
    revocations,
  });
}

function validatePromotionCandidate(value, expectedTarget) {
  requireCanonicalKeys(
    value,
    [
      "target",
      "root",
      "expectedManifestSha256",
      "expectedCandidateDigest",
      "archive",
      "publisherAttestation",
      "publisherTrustRoot",
      "platformAuthenticity",
    ],
    "promotion candidate",
  );
  const target = validateTarget(value.target, "promotion candidate target");
  if (targetName(target) !== targetName(expectedTarget)) {
    throw new Error("Promotion candidates are not in the exact target order.");
  }
  assertPlaceholderAbsolutePath(value.root, "promotion candidate root");
  assertPlaceholderSha(value.expectedManifestSha256, "expected manifest");
  assertPlaceholderSha(value.expectedCandidateDigest, "expected candidate");
  const archive = validatePinnedFile(value.archive, "release archive");
  const publisherAttestation = validatePinnedFile(
    value.publisherAttestation,
    "publisher attestation",
  );
  const publisherTrustRoot = validatePinnedFile(value.publisherTrustRoot, "publisher trust root");
  requireCanonicalKeys(
    value.platformAuthenticity,
    ["recordSha256", "certificateIdentities", "productCertificateIdentity", "verificationEvidence"],
    "platform authenticity",
  );
  assertPlaceholderSha(value.platformAuthenticity.recordSha256, "platform authenticity");
  if (
    !Array.isArray(value.platformAuthenticity.certificateIdentities) ||
    value.platformAuthenticity.certificateIdentities.some(
      (identity) =>
        typeof identity !== "string" ||
        !identity.startsWith("PLACEHOLDER-") ||
        identity.length > 512,
    ) ||
    new Set(value.platformAuthenticity.certificateIdentities).size !==
      value.platformAuthenticity.certificateIdentities.length
  ) {
    throw new Error("Platform certificate PLACEHOLDER identities are invalid.");
  }
  if (
    value.platformAuthenticity.productCertificateIdentity !== null &&
    !value.platformAuthenticity.certificateIdentities.includes(
      value.platformAuthenticity.productCertificateIdentity,
    )
  ) {
    throw new Error("The platform product certificate PLACEHOLDER is invalid.");
  }
  if (
    !Array.isArray(value.platformAuthenticity.verificationEvidence) ||
    value.platformAuthenticity.verificationEvidence.length < 1
  ) {
    throw new Error("Platform authenticity requires verification evidence.");
  }
  const verificationEvidence = value.platformAuthenticity.verificationEvidence.map((item) =>
    validateEvidence(item, "platform authenticity"),
  );
  assertStrictlySorted(
    verificationEvidence.map(({ statementPath }) => statementPath),
    "platform authenticity evidence paths",
  );
  return Object.freeze({
    ...value,
    target,
    archive,
    publisherAttestation,
    publisherTrustRoot,
    platformAuthenticity: Object.freeze({
      ...value.platformAuthenticity,
      verificationEvidence: Object.freeze(verificationEvidence),
    }),
  });
}

function validateReadBackPlan(value, promotion, promotionPlanSha256) {
  requireCanonicalKeys(
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
    value.releaseId !== promotion.releaseId ||
    value.channel !== promotion.channel ||
    value.tag !== `v${PLACEHOLDER_PRODUCT_VERSION}` ||
    !value.receiptId.startsWith("PLACEHOLDER-") ||
    !externalIdPattern.test(value.receiptId) ||
    value.observedAt !== PLACEHOLDER_OBSERVED_AT
  ) {
    throw new Error("The release read-back PLACEHOLDER identity is invalid.");
  }
  requireCanonicalKeys(
    value.publication,
    ["uploaderAuthorityKeyId", "immutable"],
    "publication description",
  );
  if (
    value.publication.uploaderAuthorityKeyId !== PLACEHOLDER_KEY_ID ||
    !keyIdPattern.test(value.publication.uploaderAuthorityKeyId) ||
    value.publication.immutable !== true
  ) {
    throw new Error("The release publication PLACEHOLDER authority is invalid.");
  }
  requireCanonicalKeys(
    value.promotion,
    ["planSha256", "attestation"],
    "read-back promotion binding",
  );
  if (value.promotion.planSha256 !== promotionPlanSha256) {
    throw new Error("The read-back plan does not bind the canonical promotion skeleton.");
  }
  const attestation = validatePinnedFile(value.promotion.attestation, "promotion attestation");
  if (!Array.isArray(value.readBackRecords) || value.readBackRecords.length !== 3) {
    throw new Error("The read-back plan requires exactly three target records.");
  }
  const records = value.readBackRecords.map((record, index) => {
    requireCanonicalKeys(record, ["target", "expectedSource", "envelope"], "read-back record");
    const target = validateTarget(record.target, "read-back target");
    if (targetName(target) !== targetName(FIRST_MILESTONE_TARGETS[index])) {
      throw new Error("Read-back records are not in the exact target order.");
    }
    requireCanonicalKeys(
      record.expectedSource,
      ["provider", "immutableObjectId", "immutableObjectVersion"],
      "expected remote source",
    );
    for (const [name, candidate] of Object.entries(record.expectedSource)) {
      if (
        typeof candidate !== "string" ||
        !candidate.startsWith("PLACEHOLDER-") ||
        candidate.includes("\0") ||
        candidate.length > 1024
      ) {
        throw new Error(`The expected remote ${name} PLACEHOLDER is invalid.`);
      }
    }
    return Object.freeze({
      ...record,
      target,
      envelope: validatePinnedFile(record.envelope, "read-back envelope"),
    });
  });
  assertDistinct(
    [attestation.path, ...records.map(({ envelope }) => envelope.path)],
    "read-back input paths",
  );
  return Object.freeze({
    ...value,
    promotion: Object.freeze({ ...value.promotion, attestation }),
    readBackRecords: Object.freeze(records),
  });
}

function validateConfigurationPlan(value, expectedMode, promotion, readBack) {
  requireCanonicalKeys(
    value,
    ["schemaVersion", "product", "mode", "source", "candidate", "promotion", "policy"],
    "release configuration plan",
  );
  if (
    value.schemaVersion !== 1 ||
    value.product !== "OpenDelegate" ||
    value.mode !== expectedMode
  ) {
    throw new Error("The release configuration skeleton mode is invalid.");
  }
  requireCanonicalKeys(value.source, ["buildCommit"], "release configuration source");
  if (value.source.buildCommit !== promotion.source.buildCommit) {
    throw new Error("The release configuration source does not match promotion.");
  }
  const candidate = validateConfigurationCandidate(value.candidate);
  const expectedCandidate = promotion.candidates[0];
  if (
    JSON.stringify(candidate) !==
    JSON.stringify({
      target: expectedCandidate.target,
      root: expectedCandidate.root,
      expectedManifestSha256: expectedCandidate.expectedManifestSha256,
      expectedCandidateDigest: expectedCandidate.expectedCandidateDigest,
      archive: expectedCandidate.archive,
      publisherAttestation: expectedCandidate.publisherAttestation,
      publisherTrustRoot: expectedCandidate.publisherTrustRoot,
    })
  ) {
    throw new Error("The configuration candidate does not bind the promotion skeleton.");
  }
  let configurationPromotion = null;
  if (expectedMode === "publisher-only") {
    if (value.promotion !== null) {
      throw new Error("Publisher-only configuration cannot include promotion inputs.");
    }
  } else {
    configurationPromotion = validateConfigurationPromotion(value.promotion, promotion, readBack);
  }
  const policy = validateRevocations(value.policy, "release configuration");
  const pinnedPaths = [
    candidate.archive.path,
    candidate.publisherAttestation.path,
    candidate.publisherTrustRoot.path,
    ...(configurationPromotion === null
      ? []
      : [
          configurationPromotion.promotionAttestation.path,
          configurationPromotion.supportedChannelReceipt.path,
          configurationPromotion.promotionTrustRoot.path,
          configurationPromotion.observerTrustRoot.path,
          ...configurationPromotion.readBackObservations.map(({ envelope }) => envelope.path),
          configurationPromotion.supportMatrix.file.path,
          configurationPromotion.notarizationReceipt.file.path,
          ...configurationPromotion.liveEvidence.map(({ file }) => file.path),
        ]),
  ];
  assertDistinct(pinnedPaths, "release configuration pinned paths");
  return Object.freeze({
    ...value,
    candidate,
    promotion: configurationPromotion,
    policy,
  });
}

function validateConfigurationCandidate(value) {
  requireCanonicalKeys(
    value,
    [
      "target",
      "root",
      "expectedManifestSha256",
      "expectedCandidateDigest",
      "archive",
      "publisherAttestation",
      "publisherTrustRoot",
    ],
    "release configuration candidate",
  );
  return Object.freeze({
    ...value,
    target: validateTarget(value.target, "release configuration target"),
    root: assertPlaceholderAbsolutePath(value.root, "release configuration candidate root"),
    expectedManifestSha256: assertPlaceholderSha(
      value.expectedManifestSha256,
      "configuration manifest",
    ),
    expectedCandidateDigest: assertPlaceholderSha(
      value.expectedCandidateDigest,
      "configuration candidate",
    ),
    archive: validatePinnedFile(value.archive, "configuration archive"),
    publisherAttestation: validatePinnedFile(
      value.publisherAttestation,
      "configuration publisher attestation",
    ),
    publisherTrustRoot: validatePinnedFile(
      value.publisherTrustRoot,
      "configuration publisher trust root",
    ),
  });
}

function validateConfigurationPromotion(value, promotion, readBack) {
  requireCanonicalKeys(
    value,
    [
      "promotionAttestation",
      "supportedChannelReceipt",
      "promotionTrustRoot",
      "observerTrustRoot",
      "readBackObservations",
      "supportMatrix",
      "notarizationReceipt",
      "liveEvidence",
    ],
    "release configuration promotion",
  );
  const result = Object.freeze({
    promotionAttestation: validatePinnedFile(
      value.promotionAttestation,
      "configuration promotion attestation",
    ),
    supportedChannelReceipt: validatePinnedFile(
      value.supportedChannelReceipt,
      "configuration supported-channel receipt",
    ),
    promotionTrustRoot: validatePinnedFile(
      value.promotionTrustRoot,
      "configuration promotion trust root",
    ),
    observerTrustRoot: validatePinnedFile(
      value.observerTrustRoot,
      "configuration observer trust root",
    ),
    readBackObservations: Object.freeze(
      validateReadBackObservationReferences(value.readBackObservations),
    ),
    supportMatrix: validateEvidence(value.supportMatrix, "configuration support matrix"),
    notarizationReceipt: validateEvidence(
      value.notarizationReceipt,
      "configuration notarization receipt",
    ),
    liveEvidence: Object.freeze(validateLiveEvidence(value.liveEvidence, "release configuration")),
  });
  if (
    JSON.stringify(result.promotionAttestation) !==
      JSON.stringify(readBack.promotion.attestation) ||
    JSON.stringify(result.readBackObservations) !==
      JSON.stringify(
        readBack.readBackRecords.map(({ target, envelope }) => ({ target, envelope })),
      ) ||
    JSON.stringify(result.supportMatrix) !== JSON.stringify(promotion.supportMatrix) ||
    JSON.stringify(result.notarizationReceipt) !== JSON.stringify(promotion.notarizationReceipt) ||
    JSON.stringify(result.liveEvidence) !== JSON.stringify(promotion.liveEvidence)
  ) {
    throw new Error("Released configuration does not bind the promotion/read-back skeletons.");
  }
  return result;
}

function validateReadBackObservationReferences(value) {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error("Released configuration requires exactly three read-back observations.");
  }
  return value.map((item, index) => {
    requireCanonicalKeys(item, ["target", "envelope"], "configuration read-back observation");
    const target = validateTarget(item.target, "configuration read-back target");
    if (targetName(target) !== targetName(FIRST_MILESTONE_TARGETS[index])) {
      throw new Error("Configuration read-back observations are not in target order.");
    }
    return Object.freeze({
      target,
      envelope: validatePinnedFile(item.envelope, "configuration read-back envelope"),
    });
  });
}

function validateSigningPolicy(value, expectedRole) {
  requireCanonicalKeys(
    value,
    ["schemaVersion", "product", "role", "publicKey", "broker"],
    "release-signing policy",
  );
  if (
    value.schemaVersion !== 2 ||
    value.product !== "OpenDelegate" ||
    value.role !== expectedRole
  ) {
    throw new Error("The release-signing policy identity is invalid.");
  }
  const publicKey = validatePinnedFile(value.publicKey, "release-signing public key");
  requireCanonicalKeys(
    value.broker,
    ["protocol", "endpoint", "transportPublicKey", "timeoutMs"],
    "release-signing broker",
  );
  if (
    value.broker.protocol !== releaseSignerBrokerProtocol ||
    typeof value.broker.endpoint !== "string" ||
    !value.broker.endpoint.includes("PLACEHOLDER") ||
    value.broker.endpoint.includes("\0") ||
    value.broker.timeoutMs !== 30_000
  ) {
    throw new Error("The release-signing broker PLACEHOLDER is invalid.");
  }
  if (
    process.platform === "win32"
      ? !/^\\\\\.\\pipe\\[A-Za-z0-9._-]{1,160}$/u.test(value.broker.endpoint)
      : !isAbsolute(value.broker.endpoint)
  ) {
    throw new Error("The release-signing broker endpoint is not local and absolute.");
  }
  const transportPublicKey = validatePinnedFile(
    value.broker.transportPublicKey,
    "signer-broker transport public key",
  );
  if (publicKey.path === transportPublicKey.path) {
    throw new Error("Release and broker public-key PLACEHOLDER paths must be distinct.");
  }
  return Object.freeze({
    ...value,
    publicKey,
    broker: Object.freeze({
      ...value.broker,
      transportPublicKey,
    }),
  });
}

function validateEvidence(value, label) {
  requireCanonicalKeys(value, ["statementPath", "file"], `${label} evidence`);
  assertPortableStatementPath(value.statementPath, `${label} statement path`);
  return Object.freeze({
    statementPath: value.statementPath,
    file: validatePinnedFile(value.file, `${label} file`),
  });
}

function validateLiveEvidence(value, label) {
  if (!Array.isArray(value) || value.length !== 36) {
    throw new Error(`${label} requires exactly 36 live-evidence criteria.`);
  }
  return value.map((item, index) => {
    requireCanonicalKeys(item, ["criterionId", "statementPath", "file"], `${label} live evidence`);
    if (item.criterionId !== index + 1) {
      throw new Error(`${label} live evidence must be ordered 1-36.`);
    }
    assertPortableStatementPath(item.statementPath, `${label} live evidence statement path`);
    return Object.freeze({
      criterionId: item.criterionId,
      statementPath: item.statementPath,
      file: validatePinnedFile(item.file, `${label} live evidence file`),
    });
  });
}

function validateRevocations(value, label) {
  const names = [
    "revokedCertificateIdentities",
    "revokedObserverKeyIds",
    "revokedPromotionKeyIds",
    "revokedPublisherKeyIds",
    "revokedStatementIds",
  ];
  requireCanonicalKeys(value, names, `${label} revocation policy`);
  for (const name of names) {
    if (!Array.isArray(value[name]) || value[name].length !== 0) {
      throw new Error(`${label} ${name} must start as an empty PLACEHOLDER policy.`);
    }
  }
  return Object.freeze(Object.fromEntries(names.map((name) => [name, Object.freeze([])])));
}

function validatePinnedFile(value, label) {
  requireCanonicalKeys(value, ["path", "sha256"], label);
  return Object.freeze({
    path: assertPlaceholderAbsolutePath(value.path, `${label} path`),
    sha256: assertPlaceholderSha(value.sha256, label),
  });
}

function validateTarget(value, label) {
  requireCanonicalKeys(value, ["platform", "architecture"], label);
  if (!FIRST_MILESTONE_TARGETS.some((target) => targetName(target) === targetName(value))) {
    throw new Error(`The ${label} is not a first-milestone target.`);
  }
  return Object.freeze({ platform: value.platform, architecture: value.architecture });
}

function assertPlaceholderAbsolutePath(value, label) {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    value.includes("\0") ||
    !value.includes("PLACEHOLDER")
  ) {
    throw new Error(`The ${label} must be an absolute PLACEHOLDER path.`);
  }
  return resolve(value);
}

function assertPlaceholderSha(value, label) {
  if (!sha256Pattern.test(value) || value !== PLACEHOLDER_SHA256) {
    throw new Error(`The ${label} must retain its zeroed PLACEHOLDER SHA-256.`);
  }
  return value;
}

function assertPortableStatementPath(value, label) {
  if (
    typeof value !== "string" ||
    !portablePathPattern.test(value) ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`The ${label} is not a portable repository-relative path.`);
  }
}

function assertStrictlySorted(values, label) {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1] >= values[index]) {
      throw new Error(`The ${label} must be strictly sorted and unique.`);
    }
  }
}

function assertDistinct(values, label) {
  const normalized = values.map((value) =>
    isAbsolute(value)
      ? process.platform === "win32"
        ? resolve(value).toLowerCase()
        : resolve(value)
      : process.platform === "win32"
        ? value.toLowerCase()
        : value,
  );
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`The ${label} must be distinct.`);
  }
}

function assertCredentialFreeJson(value, label, depth = 0) {
  if (depth > 20) {
    throw new Error(`The ${label} exceeds the release-example depth limit.`);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      assertCredentialFreeJson(item, label, depth + 1);
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    if (typeof value === "string" && privateKeyPattern.test(value)) {
      throw new Error(`The ${label} contains private key material.`);
    }
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (prohibitedJsonKeyPattern.test(key)) {
      throw new Error(`The ${label} contains a prohibited credential field.`);
    }
    assertCredentialFreeJson(nested, label, depth + 1);
  }
}

function assertExamplePathsUseDestination(promotion, readBack, destination) {
  const placeholderRoot = resolve(dirname(destination), "PLACEHOLDER-release-inputs");
  const paths = [
    ...promotion.candidates.flatMap((candidate) => [
      candidate.root,
      candidate.archive.path,
      candidate.publisherAttestation.path,
      candidate.publisherTrustRoot.path,
      ...candidate.platformAuthenticity.verificationEvidence.map(({ file }) => file.path),
    ]),
    promotion.supportMatrix.file.path,
    promotion.notarizationReceipt.file.path,
    ...promotion.liveEvidence.map(({ file }) => file.path),
    readBack.promotion.attestation.path,
    ...readBack.readBackRecords.map(({ envelope }) => envelope.path),
  ];
  if (
    paths.some((path) => {
      const difference = relative(placeholderRoot, path);
      return difference === ".." || difference.startsWith(`..${sep}`) || isAbsolute(difference);
    })
  ) {
    throw new Error("Release-example paths escaped the documented PLACEHOLDER input root.");
  }
}

async function listRegularExampleFiles(root) {
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("The release-example root must be a regular directory.");
  }
  const files = [];
  const visit = async (directory, prefix) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const absolutePath = join(directory, entry.name);
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) {
        throw new Error("Release examples reject linked filesystem entries.");
      }
      if (metadata.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (metadata.isFile()) {
        files.push(relativePath);
      } else {
        throw new Error("Release examples require regular files and directories.");
      }
    }
  };
  await visit(root, "");
  return files.sort(compareCodeUnits);
}

async function readCanonicalExampleJson(path, dependencies) {
  const text = await readBoundedText(path, dependencies);
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error("A release-example JSON file is invalid.", { cause: error });
  }
  if (`${JSON.stringify(value)}\n` !== text) {
    throw new Error("A release-example JSON file is not canonical.");
  }
  return Object.freeze({ text, value });
}

async function readBoundedText(path, dependencies = {}) {
  const flags =
    process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
  const handle = await open(path, flags);
  let bytes;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.size < 1n || opened.size > BigInt(maximumExampleFileBytes)) {
      throw new Error("A release-example file is not a bounded regular file.");
    }
    await dependencies.afterFileMetadata?.(path);
    const canonicalPath = await realpath(path);
    const [pathBefore, canonicalBefore] = await Promise.all([
      lstat(path, { bigint: true }),
      lstat(canonicalPath, { bigint: true }),
    ]);
    if (
      pathBefore.isSymbolicLink() ||
      canonicalBefore.isSymbolicLink() ||
      !sameStableFile(opened, pathBefore) ||
      !sameStableFile(opened, canonicalBefore)
    ) {
      throw new Error("A release-example file changed before it could be read.");
    }
    bytes = Buffer.alloc(Number(opened.size));
    let position = 0;
    while (position < bytes.byteLength) {
      const { bytesRead } = await handle.read(
        bytes,
        position,
        bytes.byteLength - position,
        position,
      );
      if (bytesRead < 1) {
        throw new Error("A release-example file ended while it was being read.");
      }
      position += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const canonicalPathAfter = await realpath(path);
    const [pathAfter, canonicalAfter] = await Promise.all([
      lstat(path, { bigint: true }),
      lstat(canonicalPathAfter, { bigint: true }),
    ]);
    if (
      pathAfter.isSymbolicLink() ||
      canonicalAfter.isSymbolicLink() ||
      !sameCanonicalPath(canonicalPath, canonicalPathAfter) ||
      !sameStableFile(opened, after) ||
      !sameStableFile(after, pathAfter) ||
      !sameStableFile(after, canonicalAfter)
    ) {
      bytes.fill(0);
      throw new Error("A release-example file changed while it was being read.");
    }
  } finally {
    await handle.close();
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error("A release-example file is not valid UTF-8.", { cause: error });
  }
}

function sameCanonicalPath(left, right) {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}

function sameStableFile(left, right) {
  return (
    (left.dev === 0n || right.dev === 0n || left.dev === right.dev) &&
    left.ino !== 0n &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function requireCanonicalKeys(value, expected, label) {
  requireExactKeys(value, expected, label);
  if (Object.keys(value).some((key, index) => key !== expected[index])) {
    throw new Error(`The ${label} fields do not match the canonical order.`);
  }
}

function canonicalJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function digestBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function targetName(target) {
  return `${target.platform}-${target.architecture}`;
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function renderReleaseExampleReadme() {
  return `# NOT-A-RELEASE: OpenDelegate release input examples

These files are credential-free, schema-valid PLACEHOLDER skeletons. They are
examples of exact field order and cross-file bindings, not release evidence and not
authorization to publish OpenDelegate. This generator never writes credentials,
private keys, signatures, candidate artifacts, or engineering proof.

Before any production command:

1. Copy the plans into an operator-controlled external input directory.
2. Replace every \`PLACEHOLDER\` value and every zeroed SHA-256 or Git commit.
3. Point each absolute path at a real immutable input outside the source checkout.
4. Provision distinct publisher, promotion, uploader, observer, and broker
   authorities; keep every private key and credential outside these files.
5. Recompute the promotion-plan SHA-256 stored by \`read-back-plan.json\`.
6. Run the normal pinned release commands and let their production loaders verify
   the real artifacts, signatures, identities, revocations, and external evidence.

The two configuration plans show the only supported shapes:
\`publisher-only\` for a publisher-verified candidate and \`released\` for the full
promotion plus independent remote read-back evidence.
`;
}

async function isDirectInvocation(candidate) {
  if (typeof candidate !== "string") {
    return false;
  }
  try {
    const [candidatePath, modulePath] = await Promise.all([
      realpath(resolve(candidate)),
      realpath(currentFile),
    ]);
    return process.platform === "win32"
      ? candidatePath.toLowerCase() === modulePath.toLowerCase()
      : candidatePath === modulePath;
  } catch {
    return false;
  }
}

if (await isDirectInvocation(process.argv[1])) {
  try {
    const arguments_ = parseReleaseExamplesArguments(process.argv.slice(2));
    if (arguments_.help) {
      process.stdout.write(renderReleaseExamplesHelp());
    } else {
      const result = await createReleaseExamples(arguments_);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Release example generation failed.";
    process.stderr.write(`Release example generation failed: ${message}\n`);
    process.exitCode = 1;
  }
}
