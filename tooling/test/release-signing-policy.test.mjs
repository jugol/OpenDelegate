import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  describePinnedReleaseSigningPolicy,
  getPinnedReleaseSigningTrust,
  readPinnedReleaseSigningPolicy,
  signWithPinnedReleasePolicy,
} from "../release-signing-policy.mjs";

test("a pinned release policy signs through an opaque handle without exposing paths", async (t) => {
  const fixture = await createPolicyFixture(t, "publisher");
  const policy = await readPinnedReleaseSigningPolicy({
    expectedRole: "publisher",
    path: fixture.policyPath,
    sha256: await sha256File(fixture.policyPath),
  });

  assert.deepEqual(describePinnedReleaseSigningPolicy(policy), {
    invocationArtifactSha256: [await sha256File(fixture.helperPath)],
    keyId: fixture.keyId,
    policySha256: await sha256File(fixture.policyPath),
    publicKeySha256: await sha256File(fixture.publicKeyPath),
    role: "publisher",
    signerExecutableSha256: await sha256File(process.execPath),
  });
  assert.equal(
    JSON.stringify(describePinnedReleaseSigningPolicy(policy)).includes(fixture.root),
    false,
  );
  const trust = getPinnedReleaseSigningTrust(policy);
  assert.equal(trust.keyId, fixture.keyId);
  assert.equal(trust.role, "publisher");
  assert.deepEqual(Buffer.from(trust.publicKeyPem), await readFile(fixture.publicKeyPath));
  trust.publicKeyPem.fill(0);
  assert.deepEqual(
    Buffer.from(getPinnedReleaseSigningTrust(policy).publicKeyPem),
    await readFile(fixture.publicKeyPath),
  );

  const signingBytes = Buffer.from("OpenDelegate publisher attestation v2\nfixture\n", "utf8");
  const result = await signWithPinnedReleasePolicy({ policy, signingBytes });
  assert.equal(result.keyId, fixture.keyId);
  assert.equal(result.role, "publisher");
  assert.match(result.signature, /^[A-Za-z0-9_-]{86}$/u);
  assert.equal(result.inputSha256, sha256(signingBytes));
  assert.deepEqual(result.runner, {
    executableSha256: await sha256File(process.execPath),
    invocationArtifactSha256: [await sha256File(fixture.helperPath)],
  });
  assert.equal(JSON.stringify(result).includes(fixture.root), false);
});

test("release policies reject the wrong role, digest, and noncanonical fields", async (t) => {
  const fixture = await createPolicyFixture(t, "promotion");
  const digest = await sha256File(fixture.policyPath);
  await assert.rejects(
    readPinnedReleaseSigningPolicy({
      expectedRole: "publisher",
      path: fixture.policyPath,
      sha256: digest,
    }),
    /role does not match/u,
  );
  await assert.rejects(
    readPinnedReleaseSigningPolicy({
      expectedRole: "promotion",
      path: fixture.policyPath,
      sha256: "0".repeat(64),
    }),
    /policy SHA-256 does not match/u,
  );

  const value = JSON.parse(await readFile(fixture.policyPath, "utf8"));
  value.privateKeyPath = join(fixture.root, "must-not-be-accepted.pem");
  await writeFile(fixture.policyPath, `${JSON.stringify(value)}\n`, "utf8");
  await assert.rejects(
    readPinnedReleaseSigningPolicy({
      expectedRole: "promotion",
      path: fixture.policyPath,
      sha256: await sha256File(fixture.policyPath),
    }),
    /policy fields do not match/u,
  );

  delete value.privateKeyPath;
  value.publicKey = {
    sha256: value.publicKey.sha256,
    path: value.publicKey.path,
  };
  await writeFile(fixture.policyPath, `${JSON.stringify(value)}\n`, "utf8");
  await assert.rejects(
    readPinnedReleaseSigningPolicy({
      expectedRole: "promotion",
      path: fixture.policyPath,
      sha256: await sha256File(fixture.policyPath),
    }),
    /canonical order/u,
  );
});

test("release policy handles fail closed after policy or public-key mutation", async (t) => {
  const policyMutation = await createPolicyFixture(t, "publisher");
  const policy = await readPinnedReleaseSigningPolicy({
    expectedRole: "publisher",
    path: policyMutation.policyPath,
    sha256: await sha256File(policyMutation.policyPath),
  });
  await writeFile(policyMutation.policyPath, "{}\n", "utf8");
  await assert.rejects(
    signWithPinnedReleasePolicy({
      policy,
      signingBytes: Buffer.from("statement", "utf8"),
    }),
    /policy SHA-256 does not match/u,
  );

  const keyMutation = await createPolicyFixture(t, "publisher");
  const secondPolicy = await readPinnedReleaseSigningPolicy({
    expectedRole: "publisher",
    path: keyMutation.policyPath,
    sha256: await sha256File(keyMutation.policyPath),
  });
  await writeFile(keyMutation.publicKeyPath, "not the pinned public key\n", "utf8");
  await assert.rejects(
    signWithPinnedReleasePolicy({
      policy: secondPolicy,
      signingBytes: Buffer.from("statement", "utf8"),
    }),
    /public key SHA-256 does not match/u,
  );
});

test("release signing accepts only handles returned by the pinned policy reader", async () => {
  assert.throws(
    () => describePinnedReleaseSigningPolicy({}),
    /opaque pinned release-signing policy/u,
  );
  await assert.rejects(
    signWithPinnedReleasePolicy({
      policy: {},
      signingBytes: Buffer.from("statement", "utf8"),
    }),
    /opaque pinned release-signing policy/u,
  );
});

async function createPolicyFixture(t, role) {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-release-policy-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPath = join(root, "external-private.pem");
  const publicKeyPath = join(root, "public.pem");
  const helperPath = join(root, "signer-helper.mjs");
  const policyPath = join(root, "policy.json");
  await writeFile(privateKeyPath, privateKey.export({ format: "pem", type: "pkcs8" }), {
    mode: 0o600,
  });
  await writeFile(publicKeyPath, publicKey.export({ format: "pem", type: "spki" }), {
    mode: 0o644,
  });
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
  if (total > 4 * 1024 * 1024) throw new Error("oversized");
  chunks.push(chunk);
}
const privateKey = createPrivateKey(
  await readFile(join(dirname(fileURLToPath(import.meta.url)), "external-private.pem")),
);
const publicKey = createPublicKey(privateKey);
const response = {
  schemaVersion: 1,
  algorithm: "ed25519",
  keyId: \`sha256:\${createHash("sha256")
    .update(publicKey.export({ format: "der", type: "spki" }))
    .digest("hex")}\`,
  signature: sign(null, Buffer.concat(chunks, total), privateKey).toString("base64url"),
};
process.stdout.write(\`\${JSON.stringify(response)}\\n\`);
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
  const publicKeySha256 = await sha256File(publicKeyPath);
  const policy = {
    schemaVersion: 1,
    product: "OpenDelegate",
    role,
    publicKey: {
      path: publicKeyPath,
      sha256: publicKeySha256,
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
  const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
  return {
    helperPath,
    keyId: `sha256:${sha256(publicKeyDer)}`,
    policyPath,
    publicKeyPath,
    root,
  };
}

async function sha256File(path) {
  return sha256(await readFile(path));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
