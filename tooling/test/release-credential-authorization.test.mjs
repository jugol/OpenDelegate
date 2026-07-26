import assert from "node:assert/strict";
import { test } from "node:test";

import {
  authorizeCredentialUse,
  consumeCredentialAuthorization,
  credentialAuthorizationDigest,
  describeCredentialAuthorization,
} from "../release-credential-authorization.mjs";

const inputSha256 = "a".repeat(64);

test("credential authorization revalidates every pinned input before minting", async () => {
  const events = [];
  const handle = await authorizeCredentialUse(
    {
      domain: "publisher-attestation-v2",
      inputSha256,
      revalidate: async () => events.push("revalidated"),
      role: "publisher",
      snapshot: {
        sourceCommit: "b".repeat(40),
        gitExecutableSha256: "c".repeat(64),
        policySha256: "d".repeat(64),
      },
    },
    {
      now: () => new Date("2026-07-26T00:00:00.000Z"),
      randomBytes: () => {
        events.push("minted");
        return Buffer.alloc(32, 7);
      },
    },
  );

  assert.deepEqual(events, ["revalidated", "minted"]);
  assert.deepEqual(describeCredentialAuthorization(handle), {
    authorizationId: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc",
    role: "publisher",
    domain: "publisher-attestation-v2",
    inputSha256,
    snapshotSha256: "5808a5b8891b4bbd4e1a3dfd4d0d69feb621b8ac4b10d9241bb3b245420a1719",
    authorizedAt: "2026-07-26T00:00:00.000Z",
    expiresAt: "2026-07-26T00:00:15.000Z",
  });
  assert.match(credentialAuthorizationDigest(handle), /^[0-9a-f]{64}$/u);
});

test("failed precredential revalidation mints nothing and never reaches a signer", async () => {
  let signerInvocations = 0;
  let randomInvocations = 0;
  await assert.rejects(
    (async () => {
      const authorization = await authorizeCredentialUse(
        {
          domain: "promotion-authorization-v1",
          inputSha256,
          revalidate: async () => {
            throw new Error("revoked statement");
          },
          role: "promotion",
          snapshot: { statementId: "release-42", revocationPolicySha256: "e".repeat(64) },
        },
        {
          randomBytes: () => {
            randomInvocations += 1;
            return Buffer.alloc(32);
          },
        },
      );
      consumeCredentialAuthorization(authorization, {
        domain: "promotion-authorization-v1",
        inputSha256,
        role: "promotion",
      });
      signerInvocations += 1;
    })(),
    /revoked statement/u,
  );
  assert.equal(randomInvocations, 0);
  assert.equal(signerInvocations, 0);
});

test("credential authorizations are one-shot and exact-role/domain/input bound", async () => {
  const create = () =>
    authorizeCredentialUse(
      {
        domain: "promotion-authorization-v1",
        inputSha256,
        revalidate: async () => {},
        role: "promotion",
        snapshot: { sourceCommit: "b".repeat(40) },
      },
      {
        now: () => new Date("2026-07-26T00:00:00.000Z"),
        randomBytes: () => Buffer.alloc(32, 9),
      },
    );

  for (const mismatch of [
    {
      domain: "publisher-attestation-v2",
      inputSha256,
      role: "promotion",
    },
    {
      domain: "promotion-authorization-v1",
      inputSha256: "f".repeat(64),
      role: "promotion",
    },
    {
      domain: "promotion-authorization-v1",
      inputSha256,
      role: "publisher",
    },
  ]) {
    const handle = await create();
    await assert.rejects(
      Promise.resolve().then(() =>
        consumeCredentialAuthorization(handle, mismatch, {
          now: () => new Date("2026-07-26T00:00:01.000Z"),
        }),
      ),
      /does not match|role.*domain/iu,
    );
    assert.throws(() => describeCredentialAuthorization(handle), /opaque|consumed/iu);
  }

  const handle = await create();
  const description = consumeCredentialAuthorization(
    handle,
    {
      domain: "promotion-authorization-v1",
      inputSha256,
      role: "promotion",
    },
    { now: () => new Date("2026-07-26T00:00:01.000Z") },
  );
  assert.equal(description.domain, "promotion-authorization-v1");
  assert.throws(
    () =>
      consumeCredentialAuthorization(handle, {
        domain: "promotion-authorization-v1",
        inputSha256,
        role: "promotion",
      }),
    /opaque|consumed/iu,
  );
});

test("expired credential authorization is consumed without invoking a signer", async () => {
  const handle = await authorizeCredentialUse(
    {
      domain: "platform-native-macos-sign-v1",
      inputSha256,
      revalidate: async () => {},
      role: "platform",
      snapshot: { componentSha256: "f".repeat(64), toolSha256: "e".repeat(64) },
      ttlMs: 5,
    },
    {
      now: () => new Date("2026-07-26T00:00:00.000Z"),
      randomBytes: () => Buffer.alloc(32, 3),
    },
  );
  let signerInvocations = 0;

  assert.throws(() => {
    consumeCredentialAuthorization(
      handle,
      {
        domain: "platform-native-macos-sign-v1",
        inputSha256,
        role: "platform",
      },
      { now: () => new Date("2026-07-26T00:00:00.006Z") },
    );
    signerInvocations += 1;
  }, /expired/iu);
  assert.equal(signerInvocations, 0);
  assert.throws(() => describeCredentialAuthorization(handle), /opaque|consumed/iu);
});

test("authorization snapshots reject secret-bearing or non-canonical values", async () => {
  const base = {
    domain: "supported-channel-receipt-v2",
    inputSha256,
    revalidate: async () => {},
    role: "promotion",
  };
  await assert.rejects(
    authorizeCredentialUse({ ...base, snapshot: { privateKey: "do not record" } }),
    /sanitized|secret|private/iu,
  );
  await assert.rejects(
    authorizeCredentialUse({ ...base, snapshot: { value: Number.NaN } }),
    /canonical|finite|snapshot/iu,
  );
  await assert.rejects(
    authorizeCredentialUse({
      ...base,
      domain: "unknown-domain-v1",
      snapshot: { sourceCommit: "b".repeat(40) },
    }),
    /role.*domain|domain/iu,
  );
});
