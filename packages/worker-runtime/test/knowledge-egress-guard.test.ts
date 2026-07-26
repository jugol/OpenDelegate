import assert from "node:assert/strict";
import test from "node:test";

import { WorkerEgressGuard, type WorkerEgressGuardSnapshot } from "../src/index.ts";

const PATH_SENTINEL = "private-path/KNOWLEDGE_PATH_SENTINEL.md";
const TITLE_SENTINEL = "KNOWLEDGE_TITLE_SENTINEL";
const BODY_SENTINEL =
  "Use KNOWLEDGE_BODY_SENTINEL with the signed local release cache before packaging.";

test("selected Knowledge path, title, body, normalized fragments, and encodings are blocked", async () => {
  const guard = WorkerEgressGuard.empty();
  await guard.protectKnowledge({
    noteIds: [PATH_SENTINEL],
    titles: [TITLE_SENTINEL],
    contents: [BODY_SENTINEL],
  });

  for (const candidate of [
    `Opened ${PATH_SENTINEL}.`,
    `The title is ${TITLE_SENTINEL}.`,
    BODY_SENTINEL,
    "knowledge body sentinel with the signed-local release cache",
    encodeURIComponent(BODY_SENTINEL),
    Buffer.from(BODY_SENTINEL, "utf8").toString("base64"),
    Buffer.from(BODY_SENTINEL, "utf8").toString("hex"),
  ]) {
    assert.deepEqual(guard.inspectText(candidate), {
      safe: false,
      reason: "device-local-knowledge",
    });
  }

  assert.deepEqual(guard.inspectText("Release build completed successfully."), {
    safe: true,
  });
});

test("a persisted guard protects resumed native sessions without storing source prose", async () => {
  const guard = WorkerEgressGuard.empty();
  await guard.protectKnowledge({
    noteIds: [PATH_SENTINEL],
    titles: [TITLE_SENTINEL],
    contents: [BODY_SENTINEL],
  });
  const snapshot = guard.snapshot();
  const serialized = JSON.stringify(snapshot);

  assert.equal(serialized.includes(PATH_SENTINEL), false);
  assert.equal(serialized.includes(TITLE_SENTINEL), false);
  assert.equal(serialized.includes(BODY_SENTINEL), false);

  const restored = WorkerEgressGuard.restore(snapshot);
  assert.deepEqual(restored.inspectText(`Resumed output: ${BODY_SENTINEL}`), {
    safe: false,
    reason: "device-local-knowledge",
  });
  assert.deepEqual(restored.inspectText("Safe resumed result."), { safe: true });
});

test("unknown historical exposure and unscannable artifacts fail closed", async () => {
  const opaque = WorkerEgressGuard.restore(undefined);
  assert.deepEqual(opaque.inspectText("Otherwise harmless free-form output."), {
    safe: false,
    reason: "unverifiable-knowledge-history",
  });

  const guard = WorkerEgressGuard.empty();
  await guard.protectKnowledge({
    noteIds: [PATH_SENTINEL],
    titles: [TITLE_SENTINEL],
    contents: [BODY_SENTINEL],
  });
  assert.deepEqual(
    guard.inspectArtifact({
      relativePath: "screenshot.png",
      originalFilename: "screenshot.png",
      mediaType: "image/png",
    }),
    {
      safe: false,
      reason: "unscannable-artifact",
    },
  );
  assert.deepEqual(
    guard.inspectArtifact({
      relativePath: "report.md",
      originalFilename: "report.md",
      mediaType: "text/markdown",
      bytes: Buffer.from("Safe owner-facing report.", "utf8"),
    }),
    { safe: true },
  );
  assert.deepEqual(
    guard.inspectArtifact({
      relativePath: "report.md",
      originalFilename: "report.md",
      mediaType: "text/markdown",
      bytes: Buffer.from(BODY_SENTINEL, "utf8"),
    }),
    {
      safe: false,
      reason: "device-local-knowledge",
    },
  );
});

test("corrupt or widened persisted guard snapshots are rejected", () => {
  const invalid = {
    schemaVersion: 1,
    mode: "scoped",
    exactFingerprints: [],
    fragmentFingerprints: ["not-a-fingerprint"],
  } as unknown as WorkerEgressGuardSnapshot;

  assert.throws(() => WorkerEgressGuard.restore(invalid), /Knowledge egress snapshot is invalid/u);
});

test("Secret byte matchers catch binary and cross-chunk encoded values without persistence", async () => {
  const secret = "SECRET_BYTE_SENTINEL+/=private";
  const guard = WorkerEgressGuard.empty();
  await guard.protectSecrets([secret]);
  const serialized = JSON.stringify(guard.snapshot());
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes(Buffer.from(secret).toString("base64")), false);
  const percentEncoded = encodeURIComponent(secret);
  const base64 = Buffer.from(secret, "utf8").toString("base64");

  for (const protectedValue of [
    Buffer.from(secret, "utf8"),
    Buffer.from(JSON.stringify(secret).slice(1, -1), "utf8"),
    Buffer.from(percentEncoded, "utf8"),
    Buffer.from(
      percentEncoded.replace(/%[A-F0-9]{2}/gu, (match) => match.toLowerCase()),
      "utf8",
    ),
    base64,
    base64.replace(/=+$/u, ""),
    Buffer.from(secret, "utf8").toString("base64url"),
    Buffer.from(secret, "utf8").toString("hex"),
  ].map((value) => (typeof value === "string" ? Buffer.from(value, "utf8") : value))) {
    const scanner = guard.createByteScanner();
    const split = Math.max(1, Math.floor(protectedValue.byteLength / 2));
    assert.deepEqual(scanner.push(protectedValue.subarray(0, split)), { safe: true });
    assert.deepEqual(scanner.push(protectedValue.subarray(split)), {
      safe: false,
      reason: "device-local-secret",
    });
  }
});
