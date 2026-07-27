import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SecretError, SystemdCredentialKeyProvider } from "../src/index.ts";

test(
  "systemd credentials use the service-manager supplied runtime root",
  { skip: process.platform !== "linux" },
  async (t) => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "opendelegate-systemd-credential-"));
    t.after(async () => {
      await chmod(join(fixtureRoot, "credentials", "opendelegate.service"), 0o700).catch(
        () => undefined,
      );
      await rm(fixtureRoot, { force: true, recursive: true });
    });
    const credentialRoot = join(fixtureRoot, "credentials");
    const credentialDirectory = join(credentialRoot, "opendelegate.service");
    const sourceCheckoutRoot = join(fixtureRoot, "checkout");
    const expected = Buffer.alloc(32, 91);
    await mkdir(credentialRoot, { mode: 0o755, recursive: true });
    await Promise.all([
      mkdir(credentialDirectory, { mode: 0o700 }),
      mkdir(sourceCheckoutRoot, { mode: 0o700 }),
    ]);
    const credentialPath = join(credentialDirectory, "opendelegate-vault-key");
    await writeFile(credentialPath, expected, {
      mode: 0o440,
    });
    await chmod(credentialDirectory, 0o550);

    const provider = new SystemdCredentialKeyProvider({
      credentialDirectory,
      credentialName: "opendelegate-vault-key",
      hostPlatform: "linux",
      sourceCheckoutRoot,
    });
    let observed: Uint8Array | undefined;
    await provider.executeWithKey((key) => {
      observed = key;
      assert.deepEqual(key, expected);
    });

    assert.ok(observed);
    assert.deepEqual([...observed], new Array<number>(32).fill(0));

    await chmod(credentialPath, 0o640);
    await assert.rejects(
      provider.executeWithKey(() => undefined),
      (error: unknown) =>
        error instanceof SecretError && error.code === "SECRET_BACKEND_UNAVAILABLE",
    );
  },
);
