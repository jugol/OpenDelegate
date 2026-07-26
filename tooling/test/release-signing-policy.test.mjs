import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { releaseSignerBrokerProtocol } from "../external-release-signer.mjs";
import {
  authorizeCredentialUse,
  describeCredentialAuthorization,
} from "../release-credential-authorization.mjs";
import {
  assertPinnedReleaseSigningPolicyExternal,
  describePinnedReleaseSigningPolicy,
  getPinnedReleaseSigningTrust,
  readPinnedReleaseSigningPolicy,
  signWithPinnedReleasePolicy,
} from "../release-signing-policy.mjs";
import {
  createPublisherSigningBytes as publisherSigningBytes,
  createReleaseSignerBrokerFixture,
} from "./support/release-signer-broker-fixture.mjs";

test("a pinned policy authorizes an authenticated broker without exposing endpoint paths", async (t) => {
  const fixture = await createPolicyFixture(t, "publisher");
  const policy = await readPolicy(fixture, "publisher");
  const description = describePinnedReleaseSigningPolicy(policy);

  assert.deepEqual(description, {
    brokerEndpointSha256: sha256(Buffer.from(fixture.endpoint, "utf8")),
    brokerProtocol: releaseSignerBrokerProtocol,
    brokerTransportKeyId: fixture.transportKeyId,
    keyId: fixture.keyId,
    policySha256: await sha256File(fixture.policyPath),
    publicKeySha256: await sha256File(fixture.publicKeyPath),
    role: "publisher",
    transportPublicKeySha256: await sha256File(fixture.transportPublicKeyPath),
  });
  assert.equal(JSON.stringify(description).includes(fixture.root), false);
  assert.throws(
    () => assertPinnedReleaseSigningPolicyExternal(policy, [fixture.root]),
    /must remain outside candidate and output roots/u,
  );
  assert.doesNotThrow(() =>
    assertPinnedReleaseSigningPolicyExternal(policy, [join(fixture.root, "unrelated-output")]),
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

  const signingBytes = publisherSigningBytes("fixture");
  const result = await signWithPinnedReleasePolicy({
    authorization: await credentialAuthorization(
      signingBytes,
      "publisher",
      "publisher-attestation-v2",
      fixture,
    ),
    policy,
    signingBytes,
  });
  assert.equal(result.keyId, fixture.keyId);
  assert.equal(result.role, "publisher");
  assert.match(result.signature, /^[A-Za-z0-9_-]{86}$/u);
  assert.equal(result.inputSha256, sha256(signingBytes));
  assert.deepEqual(result.runner, {
    brokerEndpointSha256: sha256(Buffer.from(fixture.endpoint, "utf8")),
    brokerProtocol: releaseSignerBrokerProtocol,
    brokerTransportKeyId: fixture.transportKeyId,
  });
  assert.equal(JSON.stringify(result).includes(fixture.root), false);
});

test("release policies reject the wrong role, digest, legacy helper schema, and key reuse", async (t) => {
  const fixture = await createPolicyFixture(t, "promotion");
  await assert.rejects(readPolicy(fixture, "publisher"), /role does not match/u);
  await assert.rejects(
    readPinnedReleaseSigningPolicy({
      expectedRole: "promotion",
      path: fixture.policyPath,
      sha256: "0".repeat(64),
    }),
    /policy SHA-256 does not match/u,
  );

  await rewritePolicy(fixture.policyPath, (value) => {
    value.signer = {
      executable: { path: process.execPath, sha256: "0".repeat(64) },
      invocationArtifacts: [],
      timeoutMs: 30_000,
    };
  });
  await assert.rejects(readPolicy(fixture, "promotion"), /policy fields do not match/u);

  const reused = await createPolicyFixture(t, "promotion");
  await rewritePolicy(reused.policyPath, (value) => {
    value.broker.transportPublicKey = { ...value.publicKey };
  });
  await assert.rejects(readPolicy(reused, "promotion"), /authorities must be distinct/u);
});

test("policy handles fail closed after policy, release-key, or transport-key mutation", async (t) => {
  for (const target of ["policy", "release-key", "transport-key"]) {
    const fixture = await createPolicyFixture(t, "publisher");
    const policy = await readPolicy(fixture, "publisher");
    if (target === "policy") {
      await writeFile(fixture.policyPath, "{}\n", "utf8");
    } else if (target === "release-key") {
      await writeFile(fixture.publicKeyPath, "not the pinned public key\n", "utf8");
    } else {
      await writeFile(fixture.transportPublicKeyPath, "not the pinned transport key\n", "utf8");
    }
    const signingBytes = publisherSigningBytes(target);
    await assert.rejects(
      signWithPinnedReleasePolicy({
        authorization: await credentialAuthorization(
          signingBytes,
          "publisher",
          "publisher-attestation-v2",
          fixture,
        ),
        policy,
        signingBytes,
      }),
      /SHA-256 does not match/u,
    );
    assert.equal(fixture.requests.length, 0);
  }
});

test("signing accepts only pinned policy and one-shot credential-authorization handles", async (t) => {
  assert.throws(
    () => describePinnedReleaseSigningPolicy({}),
    /opaque pinned release-signing policy/u,
  );
  const fixture = await createPolicyFixture(t, "publisher");
  const policy = await readPolicy(fixture, "publisher");
  const signingBytes = publisherSigningBytes("one-shot");
  const authorization = await credentialAuthorization(
    signingBytes,
    "publisher",
    "publisher-attestation-v2",
    fixture,
  );
  await signWithPinnedReleasePolicy({ authorization, policy, signingBytes });
  await assert.rejects(
    signWithPinnedReleasePolicy({ authorization, policy, signingBytes }),
    /opaque unconsumed credential authorization/u,
  );
  assert.equal(fixture.requests.length, 1);
});

test("policy and credential state are revalidated after broker capability issuance", async (t) => {
  const policyMutation = await createPolicyFixture(t, "publisher");
  const policy = await readPolicy(policyMutation, "publisher");
  const signingBytes = publisherSigningBytes("post-capability-policy");
  const authorization = await credentialAuthorization(
    signingBytes,
    "publisher",
    "publisher-attestation-v2",
    policyMutation,
  );
  policyMutation.broker.behavior.afterCapabilityIssued = () => {
    writeFileSync(policyMutation.policyPath, "{}\n", "utf8");
  };
  await assert.rejects(
    signWithPinnedReleasePolicy({ authorization, policy, signingBytes }),
    /policy SHA-256 does not match/u,
  );
  assert.equal(policyMutation.broker.metrics.capabilitiesIssued, 1);
  assert.equal(policyMutation.broker.metrics.releaseKeyUseCount, 0);

  const credentialMutation = await createPolicyFixture(t, "publisher");
  const credentialPolicy = await readPolicy(credentialMutation, "publisher");
  const credentialBytes = publisherSigningBytes("post-capability-credential");
  let revalidationCount = 0;
  const credentialAuthorizationHandle = await authorizeCredentialUse({
    domain: "publisher-attestation-v2",
    inputSha256: sha256(credentialBytes),
    revalidate: async () => {
      revalidationCount += 1;
      if (revalidationCount > 1) {
        throw new Error("credential precondition changed");
      }
    },
    role: "publisher",
    snapshot: {
      candidateSha256: "c".repeat(64),
      sourceCommit: "d".repeat(40),
    },
  });
  credentialMutation.broker.approve(describeCredentialAuthorization(credentialAuthorizationHandle));
  await assert.rejects(
    signWithPinnedReleasePolicy({
      authorization: credentialAuthorizationHandle,
      policy: credentialPolicy,
      signingBytes: credentialBytes,
    }),
    /credential precondition changed/u,
  );
  assert.equal(revalidationCount, 2);
  assert.equal(credentialMutation.broker.metrics.releaseKeyUseCount, 0);
});

test("release signing policies reject linked ancestors for policies and both trust roots", async (t) => {
  const linkedPolicy = await createPolicyFixture(t, "promotion");
  const policyAlias = join(linkedPolicy.root, "policy-alias");
  await createDirectoryAlias(policyAlias, linkedPolicy.root);
  await assert.rejects(
    readPinnedReleaseSigningPolicy({
      expectedRole: "promotion",
      path: join(policyAlias, "policy.json"),
      sha256: await sha256File(linkedPolicy.policyPath),
    }),
    /canonical path|linked ancestor/iu,
  );

  const linkedReleaseKey = await createPolicyFixture(t, "promotion");
  const releaseKeyAlias = join(linkedReleaseKey.root, "release-key-alias");
  await createDirectoryAlias(releaseKeyAlias, linkedReleaseKey.root);
  await rewritePolicy(linkedReleaseKey.policyPath, (value) => {
    value.publicKey.path = join(releaseKeyAlias, "public.pem");
  });
  await assert.rejects(
    readPolicy(linkedReleaseKey, "promotion"),
    /canonical path|linked ancestor/iu,
  );

  const linkedTransportKey = await createPolicyFixture(t, "promotion");
  const transportKeyAlias = join(linkedTransportKey.root, "transport-key-alias");
  await createDirectoryAlias(transportKeyAlias, linkedTransportKey.root);
  await rewritePolicy(linkedTransportKey.policyPath, (value) => {
    value.broker.transportPublicKey.path = join(transportKeyAlias, "transport-public.pem");
  });
  await assert.rejects(
    readPolicy(linkedTransportKey, "promotion"),
    /canonical path|linked ancestor/iu,
  );
});

async function createPolicyFixture(t, role) {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-release-policy-"));
  const broker = await createReleaseSignerBrokerFixture(t, { role });
  const publicKeyPath = join(root, "public.pem");
  const transportPublicKeyPath = join(root, "transport-public.pem");
  const policyPath = join(root, "policy.json");
  const endpoint = broker.endpoint;
  await writeFile(publicKeyPath, broker.releasePublicKeyPem);
  await writeFile(transportPublicKeyPath, broker.transportPublicKeyPem);
  const keyId = broker.releaseKeyId;
  const transportKeyId = broker.transportKeyId;
  const policy = {
    schemaVersion: 2,
    product: "OpenDelegate",
    role,
    publicKey: {
      path: publicKeyPath,
      sha256: await sha256File(publicKeyPath),
    },
    broker: {
      protocol: releaseSignerBrokerProtocol,
      endpoint,
      transportPublicKey: {
        path: transportPublicKeyPath,
        sha256: await sha256File(transportPublicKeyPath),
      },
      timeoutMs: 30_000,
    },
  };
  await writeFile(policyPath, `${JSON.stringify(policy)}\n`, "utf8");
  broker.setPolicySha256(await sha256File(policyPath));
  t.after(async () => {
    await rm(root, { force: true, recursive: true });
  });
  return {
    broker,
    endpoint,
    keyId,
    policyPath,
    publicKeyPath,
    requests: broker.signRequests,
    root,
    transportKeyId,
    transportPublicKeyPath,
  };
}

async function credentialAuthorization(
  signingBytes,
  authorizationRole,
  authorizationDomain,
  fixture,
) {
  const authorization = await authorizeCredentialUse({
    domain: authorizationDomain,
    inputSha256: sha256(signingBytes),
    revalidate: async () => undefined,
    role: authorizationRole,
    snapshot: {
      candidateSha256: "c".repeat(64),
      sourceCommit: "d".repeat(40),
    },
  });
  fixture?.broker.approve(describeCredentialAuthorization(authorization));
  return authorization;
}

async function readPolicy(fixture, expectedRole) {
  return readPinnedReleaseSigningPolicy({
    expectedRole,
    path: fixture.policyPath,
    sha256: await sha256File(fixture.policyPath),
  });
}

async function createDirectoryAlias(aliasPath, targetPath) {
  await symlink(resolve(targetPath), aliasPath, process.platform === "win32" ? "junction" : "dir");
}

async function rewritePolicy(path, mutate) {
  const value = JSON.parse(await readFile(path, "utf8"));
  mutate(value);
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

async function sha256File(path) {
  return sha256(await readFile(path));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
