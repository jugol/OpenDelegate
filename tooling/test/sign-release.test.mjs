import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, verify as verifySignature } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { writeIntegrityManifests } from "../build-release.mjs";
import {
  inspectBundleForPublisherSigning,
  parsePublisherSigningArguments,
  publisherSignatureInput,
  signReleaseBundle,
} from "../sign-release.mjs";

test("publisher signing arguments require explicit absolute paths", () => {
  const bundle = resolve("bundle");
  const privateKey = resolve("publisher-private.pem");
  const publicKey = resolve("publisher-public.pem");

  assert.deepEqual(
    parsePublisherSigningArguments([
      "--bundle",
      bundle,
      "--private-key",
      privateKey,
      "--public-key-destination",
      publicKey,
      "--allow-unsupported-preview",
    ]),
    {
      allowUnsupportedPreview: true,
      bundle,
      help: false,
      privateKey,
      publicKeyDestination: publicKey,
    },
  );
  assert.throws(
    () =>
      parsePublisherSigningArguments([
        "--bundle",
        "relative",
        "--private-key",
        privateKey,
        "--public-key-destination",
        publicKey,
      ]),
    /absolute/u,
  );
  assert.throws(
    () => parsePublisherSigningArguments(["--bundle", bundle]),
    /--private-key is required/u,
  );
});

test("legacy publisher signing rejects candidates and signs only acknowledged previews", async (t) => {
  const candidate = await createSigningFixture(t, "release-candidate");
  await assert.rejects(
    signReleaseBundle({
      bundle: candidate.bundle,
      privateKey: candidate.privateKeyPath,
      publicKeyDestination: candidate.publicKeyPath,
      allowUnsupportedPreview: false,
    }),
    /legacy publisher signer.*unsupported previews/u,
  );

  const fixture = await createSigningFixture(t, "internal-preview-complete");
  const result = await signReleaseBundle({
    bundle: fixture.bundle,
    privateKey: fixture.privateKeyPath,
    publicKeyDestination: fixture.publicKeyPath,
    allowUnsupportedPreview: true,
  });

  assert.equal(
    result.attestationPath,
    await realpath(`${fixture.bundle}.publisher-attestation.json`),
  );
  assert.equal(result.publicKeyPath, await realpath(fixture.publicKeyPath));
  assert.equal(result.supportStatus, "internal-preview-complete");
  const attestation = JSON.parse(await readFile(result.attestationPath, "utf8"));
  const publicKey = createPublicKey(await readFile(fixture.publicKeyPath));
  assert.equal(attestation.schemaVersion, 1);
  assert.equal(attestation.product, "OpenDelegate");
  assert.equal(attestation.algorithm, "ed25519");
  assert.equal(attestation.keyId, result.keyId);
  assert.equal(attestation.manifestSha256, result.manifestSha256);
  assert.equal(
    verifySignature(
      null,
      publisherSignatureInput(result.manifestSha256),
      publicKey,
      Buffer.from(attestation.signature, "base64url"),
    ),
    true,
  );
});

test("unsupported previews require an explicit signing acknowledgement", async (t) => {
  const fixture = await createSigningFixture(t, "internal-preview-blocked");

  await assert.rejects(
    signReleaseBundle({
      bundle: fixture.bundle,
      privateKey: fixture.privateKeyPath,
      publicKeyDestination: fixture.publicKeyPath,
      allowUnsupportedPreview: false,
    }),
    /--allow-unsupported-preview/u,
  );
  const inspection = await inspectBundleForPublisherSigning(fixture.bundle, {
    allowUnsupportedPreview: true,
  });
  assert.equal(inspection.supportStatus, "internal-preview-blocked");
});

test("publisher signing rejects tampering and missing service hosts", async (t) => {
  const tampered = await createSigningFixture(t, "internal-preview-complete");
  await writeFile(join(tampered.bundle, "payload.txt"), "tampered\n", "utf8");
  await assert.rejects(
    inspectBundleForPublisherSigning(tampered.bundle, {
      allowUnsupportedPreview: true,
    }),
    /manifest/u,
  );

  const missingHost = await createSigningFixture(t, "internal-preview-complete", {
    includeHelper: false,
  });
  await assert.rejects(
    inspectBundleForPublisherSigning(missingHost.bundle, {
      allowUnsupportedPreview: true,
    }),
    /session-helper/u,
  );
});

test("publisher signing never overwrites detached outputs or writes trust material into payload", async (t) => {
  const fixture = await createSigningFixture(t, "internal-preview-complete");
  await writeFile(fixture.publicKeyPath, "occupied\n", "utf8");
  await assert.rejects(
    signReleaseBundle({
      bundle: fixture.bundle,
      privateKey: fixture.privateKeyPath,
      publicKeyDestination: fixture.publicKeyPath,
      allowUnsupportedPreview: true,
    }),
    /already exists/u,
  );

  const second = await createSigningFixture(t, "internal-preview-complete");
  await assert.rejects(
    signReleaseBundle({
      bundle: second.bundle,
      privateKey: second.privateKeyPath,
      publicKeyDestination: join(second.bundle, "publisher.pem"),
      allowUnsupportedPreview: true,
    }),
    /outside the signed bundle/u,
  );
});

async function createSigningFixture(t, supportStatus, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-publisher-signing-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const bundle = join(root, "bundle");
  await mkdir(join(bundle, "bin"), { recursive: true });
  await writeFile(join(bundle, "payload.txt"), "verified payload\n", "utf8");
  await writeFile(
    join(
      bundle,
      "bin",
      process.platform === "win32" ? "opendelegate-service-host.exe" : "opendelegate-service-host",
    ),
    "host\n",
    { encoding: "utf8", mode: 0o755 },
  );
  if (options.includeHelper !== false) {
    await writeFile(
      join(
        bundle,
        "bin",
        process.platform === "win32"
          ? "opendelegate-session-helper.exe"
          : "opendelegate-session-helper",
      ),
      "helper\n",
      { encoding: "utf8", mode: 0o755 },
    );
  }
  await writeFile(
    join(bundle, "release-metadata.json"),
    `${JSON.stringify(
      {
        schemaVersion: 2,
        product: "OpenDelegate",
        productVersion: "0.1.0-alpha.1",
        platform: process.platform,
        architecture: "x64",
        supportStatus,
        releaseEvidence: {
          complete: options.complete ?? supportStatus === "release-candidate",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    join(bundle, "smoke-evidence.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        platform: process.platform,
        architecture: "x64",
        productVersion: "0.1.0-alpha.1",
        checks: {
          cliHelp: "passed",
          backupCliHelp: "passed",
          serviceCliHelp: "passed",
          cleanHomeInitialization: "passed",
          mainHealth: "passed",
          adminStaticApp: "passed",
          loopbackOwnerClaim: "passed",
          ownerLogin: "passed",
          ownerSessionCookieContract: "passed",
          ownerSessionRoundTrip: "passed",
          cleanShutdown: {
            status: "passed",
            markerObserved: true,
            naturalExit: true,
            exitCode: 0,
            signal: null,
            shutdownTimedOut: false,
            forcedTermination: false,
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeIntegrityManifests(bundle);

  const { privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPath = join(root, "publisher-private.pem");
  const publicKeyPath = join(root, "publisher-public.pem");
  await writeFile(privateKeyPath, privateKey.export({ format: "pem", type: "pkcs8" }), {
    mode: 0o600,
  });
  return { bundle, privateKeyPath, publicKeyPath };
}
