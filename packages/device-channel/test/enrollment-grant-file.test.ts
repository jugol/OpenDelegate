import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { EnrollmentGrantFileError, executeWithEnrollmentGrantFile } from "../src/index.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("Enrollment Grant file boundary", () => {
  test("exposes a strict grant only inside one callback and removes it after success", async () => {
    const fixture = await createFixture();
    let observedToken = "";

    const result = await executeWithEnrollmentGrantFile(
      fixture.grantPath,
      { sourceCheckoutRoot: fixture.checkout },
      async (grant) => {
        observedToken = grant.token;
        assert.equal(grant.deviceId, "device-worker-1");
        assert.equal(grant.channelEndpoints[0]?.url, "wss://main.example.test:443/device");
        return "joined";
      },
    );

    assert.equal(result, "joined");
    assert.equal(observedToken, "a".repeat(43));
    await assert.rejects(
      executeWithEnrollmentGrantFile(
        fixture.grantPath,
        { sourceCheckoutRoot: fixture.checkout },
        async () => undefined,
      ),
      (error: unknown) =>
        error instanceof EnrollmentGrantFileError && error.code === "GRANT_FILE_UNAVAILABLE",
    );
  });

  test("fails closed for links, permissive POSIX permissions, and grants inside source", async () => {
    const fixture = await createFixture();
    const linkedPath = join(fixture.root, "linked-grant.json");
    await symlink(fixture.grantPath, linkedPath, "file");

    await assert.rejects(
      executeWithEnrollmentGrantFile(
        linkedPath,
        { sourceCheckoutRoot: fixture.checkout },
        async () => undefined,
      ),
      isGrantFileError("GRANT_FILE_UNSAFE"),
    );

    if (process.platform !== "win32") {
      await chmod(fixture.grantPath, 0o644);
      await assert.rejects(
        executeWithEnrollmentGrantFile(
          fixture.grantPath,
          { sourceCheckoutRoot: fixture.checkout },
          async () => undefined,
        ),
        isGrantFileError("GRANT_FILE_UNSAFE"),
      );
    }

    const checkoutGrant = join(fixture.checkout, "grant.json");
    await writeGrant(checkoutGrant);
    await assert.rejects(
      executeWithEnrollmentGrantFile(
        checkoutGrant,
        { sourceCheckoutRoot: fixture.checkout },
        async () => undefined,
      ),
      isGrantFileError("GRANT_FILE_UNSAFE"),
    );
  });

  test("does not remove a still-usable grant when the enrollment callback fails", async () => {
    const fixture = await createFixture();
    await assert.rejects(
      executeWithEnrollmentGrantFile(
        fixture.grantPath,
        { sourceCheckoutRoot: fixture.checkout },
        async () => {
          throw new Error(`boundary failed with ${"a".repeat(43)}`);
        },
      ),
      (error: unknown) =>
        error instanceof EnrollmentGrantFileError &&
        error.code === "GRANT_EXECUTOR_FAILED" &&
        !error.message.includes("a".repeat(43)),
    );

    assert.equal(
      await executeWithEnrollmentGrantFile(
        fixture.grantPath,
        { sourceCheckoutRoot: fixture.checkout },
        async () => "retryable",
      ),
      "retryable",
    );
  });
});

async function createFixture(): Promise<{
  readonly root: string;
  readonly checkout: string;
  readonly grantPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-grant-test-"));
  temporaryRoots.push(root);
  const checkout = join(root, "checkout");
  const transfer = join(root, "transfer");
  await Promise.all([mkdir(checkout), mkdir(transfer)]);
  const grantPath = join(transfer, "grant.json");
  await writeGrant(grantPath);
  return { root, checkout, grantPath };
}

async function writeGrant(path: string): Promise<void> {
  await writeFile(
    path,
    `${JSON.stringify({
      schemaVersion: 1,
      grantId: `grant_${"b".repeat(22)}`,
      token: "a".repeat(43),
      deviceId: "device-worker-1",
      mainDeviceId: "device-main-1",
      expectedMainSpkiSha256: `sha256:${"c".repeat(43)}`,
      certificateAuthorityPem:
        "-----BEGIN CERTIFICATE-----\npublic-only-test-fixture\n-----END CERTIFICATE-----\n",
      enrollmentUrl: "https://main.example.test:443/enroll",
      channelEndpoints: [
        {
          endpointId: "tailscale",
          label: "Tailscale",
          kind: "wss",
          url: "wss://main.example.test:443/device",
        },
      ],
      protocolRange: { minimum: 1, maximum: 1 },
      expiresAt: 1_900_000_000_000,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function isGrantFileError(code: EnrollmentGrantFileError["code"]) {
  return (error: unknown): boolean =>
    error instanceof EnrollmentGrantFileError && error.code === code;
}
