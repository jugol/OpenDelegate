import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify as verifySignature } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { invokePinnedReleaseSigner } from "../external-release-signer.mjs";

test("a pinned external signer receives only signing bytes and returns a verified signature", async (t) => {
  const fixture = await createSignerFixture(t);
  const signingBytes = Buffer.from(
    'OpenDelegate publisher attestation v2\n{"candidate":"fixture"}\n',
    "utf8",
  );
  const previousSecret = process.env["OPENDELEGATE_TEST_SIGNER_SECRET"];
  process.env["OPENDELEGATE_TEST_SIGNER_SECRET"] = "must-not-reach-the-signer";
  try {
    const result = await invokePinnedReleaseSigner({
      invocationArtifacts: [
        {
          path: fixture.helperPath,
          sha256: await sha256File(fixture.helperPath),
        },
      ],
      executable: {
        path: process.execPath,
        sha256: await sha256File(process.execPath),
      },
      publicKeyPem: fixture.publicKeyPem,
      signingBytes,
    });

    assert.equal(result.algorithm, "ed25519");
    assert.equal(result.keyId, fixture.keyId);
    assert.match(result.signature, /^[A-Za-z0-9_-]{86}$/u);
    assert.equal(
      verifySignature(
        null,
        signingBytes,
        fixture.publicKeyPem,
        Buffer.from(result.signature, "base64url"),
      ),
      true,
    );
    assert.deepEqual(result.runner, {
      executable: {
        path: await realpath(process.execPath),
        sha256: await sha256File(process.execPath),
      },
      invocationArtifacts: [
        {
          path: await realpath(fixture.helperPath),
          sha256: await sha256File(fixture.helperPath),
        },
      ],
    });
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.runner), true);
    assert.equal(Object.isFrozen(result.runner.executable), true);
    assert.equal(Object.isFrozen(result.runner.invocationArtifacts), true);
  } finally {
    if (previousSecret === undefined) {
      delete process.env["OPENDELEGATE_TEST_SIGNER_SECRET"];
    } else {
      process.env["OPENDELEGATE_TEST_SIGNER_SECRET"] = previousSecret;
    }
  }
});

test("the signer boundary fails closed for unpinned tools and an unrelated trust root", async (t) => {
  const fixture = await createSignerFixture(t);
  const executableSha256 = await sha256File(process.execPath);
  const helperSha256 = await sha256File(fixture.helperPath);
  const signingBytes = Buffer.from("release statement", "utf8");

  await assert.rejects(
    invokePinnedReleaseSigner({
      invocationArtifacts: [{ path: fixture.helperPath, sha256: "0".repeat(64) }],
      executable: { path: process.execPath, sha256: executableSha256 },
      publicKeyPem: fixture.publicKeyPem,
      signingBytes,
    }),
    /invocation artifact SHA-256 does not match/u,
  );

  const unrelated = generateKeyPairSync("ed25519").publicKey.export({
    format: "pem",
    type: "spki",
  });
  await assert.rejects(
    invokePinnedReleaseSigner({
      invocationArtifacts: [{ path: fixture.helperPath, sha256: helperSha256 }],
      executable: { path: process.execPath, sha256: executableSha256 },
      publicKeyPem: Buffer.from(unrelated),
      signingBytes,
    }),
    /signer response key ID does not match the external trust root/u,
  );

  await writeFile(fixture.helperPath, `${await readFile(fixture.helperPath, "utf8")}\n`);
  await assert.rejects(
    invokePinnedReleaseSigner({
      invocationArtifacts: [{ path: fixture.helperPath, sha256: helperSha256 }],
      executable: { path: process.execPath, sha256: executableSha256 },
      publicKeyPem: fixture.publicKeyPem,
      signingBytes,
    }),
    /invocation artifact SHA-256 does not match/u,
  );
});

test("the signer boundary rejects free-form, oversized, and noncanonical inputs", async (t) => {
  const fixture = await createSignerFixture(t);
  const executableSha256 = await sha256File(process.execPath);
  const helperSha256 = await sha256File(fixture.helperPath);
  const valid = {
    invocationArtifacts: [{ path: fixture.helperPath, sha256: helperSha256 }],
    executable: { path: process.execPath, sha256: executableSha256 },
    publicKeyPem: fixture.publicKeyPem,
    signingBytes: Buffer.from("statement", "utf8"),
  };

  await assert.rejects(
    invokePinnedReleaseSigner({
      ...valid,
      arguments: ["--private-key", "secret.pem"],
    }),
    /release signer input fields do not match the strict schema/u,
  );
  await assert.rejects(
    invokePinnedReleaseSigner({
      ...valid,
      executable: { ...valid.executable, path: "relative-signer" },
    }),
    /signer executable path must be absolute/u,
  );
  await assert.rejects(
    invokePinnedReleaseSigner({
      ...valid,
      invocationArtifacts: [
        ...valid.invocationArtifacts,
        { path: fixture.helperPath, sha256: helperSha256 },
      ],
    }),
    /signer invocation paths must be distinct/u,
  );
  await assert.rejects(
    invokePinnedReleaseSigner({
      ...valid,
      signingBytes: Buffer.alloc(4 * 1024 * 1024 + 1),
    }),
    /signing input is empty or oversized/u,
  );
  await assert.rejects(
    invokePinnedReleaseSigner({
      ...valid,
      timeoutMs: 0,
    }),
    /signer timeout must be an integer/u,
  );

  const reordered = await createSignerFixture(t, { reorderResponseKeys: true });
  await assert.rejects(
    invokePinnedReleaseSigner({
      invocationArtifacts: [
        {
          path: reordered.helperPath,
          sha256: await sha256File(reordered.helperPath),
        },
      ],
      executable: {
        path: process.execPath,
        sha256: executableSha256,
      },
      publicKeyPem: reordered.publicKeyPem,
      signingBytes: valid.signingBytes,
    }),
    /signer response is not canonical JSON/u,
  );
});

test("the signer boundary force-terminates a signer that exceeds its timeout", async (t) => {
  const fixture = await createSignerFixture(t);
  const hangingHelper = join(fixture.root, "hanging-signer.mjs");
  await writeFile(
    hangingHelper,
    `process.on("SIGTERM", () => {
  setTimeout(() => process.exit(0), 5_000);
});
setInterval(() => undefined, 1_000);
`,
    { mode: 0o700 },
  );
  if (process.platform !== "win32") {
    await chmod(hangingHelper, 0o700);
  }
  const startedAt = Date.now();
  await assert.rejects(
    invokePinnedReleaseSigner({
      invocationArtifacts: [
        {
          path: hangingHelper,
          sha256: await sha256File(hangingHelper),
        },
      ],
      executable: {
        path: process.execPath,
        sha256: await sha256File(process.execPath),
      },
      publicKeyPem: fixture.publicKeyPem,
      signingBytes: Buffer.from("bounded signing request", "utf8"),
      timeoutMs: 100,
    }),
    /exceeded its bounded timeout/u,
  );
  assert.ok(Date.now() - startedAt < 2_000);
});

test("the signer boundary rejects an invocation artifact reached through a linked ancestor", async (t) => {
  const fixture = await createSignerFixture(t);
  const aliasRoot = join(fixture.root, "artifact-alias");
  await symlink(
    resolve(fixture.root),
    aliasRoot,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    invokePinnedReleaseSigner({
      invocationArtifacts: [
        {
          path: join(aliasRoot, "signer-helper.mjs"),
          sha256: await sha256File(fixture.helperPath),
        },
      ],
      executable: {
        path: process.execPath,
        sha256: await sha256File(process.execPath),
      },
      publicKeyPem: fixture.publicKeyPem,
      signingBytes: Buffer.from("must never reach a linked signer artifact", "utf8"),
    }),
    /canonical path|linked ancestor/iu,
  );
});

async function createSignerFixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-external-signer-"));
  t.after(async () => {
    await rm(root, { force: true, recursive: true });
  });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPath = join(root, "signer-private.pem");
  const helperPath = join(root, "signer-helper.mjs");
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" });
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" });
  const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
  const keyId = `sha256:${createHash("sha256").update(publicKeyDer).digest("hex")}`;
  const responseSource =
    options.reorderResponseKeys === true
      ? `{
  signature: sign(null, signingBytes, privateKey).toString("base64url"),
  keyId,
  algorithm: "ed25519",
  schemaVersion: 1,
}`
      : `{
  schemaVersion: 1,
  algorithm: "ed25519",
  keyId,
  signature: sign(null, signingBytes, privateKey).toString("base64url"),
}`;
  await writeFile(privateKeyPath, privateKeyPem, { mode: 0o600 });
  await writeFile(
    helperPath,
    `import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.OPENDELEGATE_TEST_SIGNER_SECRET !== undefined) {
  throw new Error("The release runner leaked its environment.");
}
const chunks = [];
let total = 0;
for await (const chunk of process.stdin) {
  total += chunk.byteLength;
  if (total > 4 * 1024 * 1024) {
    throw new Error("Signing input is oversized.");
  }
  chunks.push(chunk);
}
const signingBytes = Buffer.concat(chunks, total);
const keyPath = join(dirname(fileURLToPath(import.meta.url)), "signer-private.pem");
const privateKey = createPrivateKey(await readFile(keyPath));
const publicKey = createPublicKey(privateKey);
const keyId = \`sha256:\${createHash("sha256")
  .update(publicKey.export({ format: "der", type: "spki" }))
  .digest("hex")}\`;
const response = ${responseSource};
process.stdout.write(\`\${JSON.stringify(response)}\\n\`);
`,
    { mode: 0o700 },
  );
  if (process.platform !== "win32") {
    await Promise.all([chmod(privateKeyPath, 0o600), chmod(helperPath, 0o700)]);
  }
  return {
    helperPath,
    keyId,
    publicKeyPem: Buffer.from(publicKeyPem),
    root,
  };
}

async function sha256File(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
