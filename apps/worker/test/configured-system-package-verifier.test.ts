import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredSystemPackageVerifier } from "../src/configured-system-package-verifier.ts";

test("pins an owner-configured install-only system package manager and rejects replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-system-package-verifier-"));
  const executable = join(root, "apt-get");
  try {
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    if (process.platform !== "win32") {
      await chmod(executable, 0o755);
    }
    const verifier = await createConfiguredSystemPackageVerifier({
      platform: "linux",
      executables: { "apt-get": executable },
    });

    assert.equal(await verifier.verify({ manager: "apt-get", executable }), true);
    assert.equal(await verifier.verify({ manager: "apt", executable }), false);
    assert.equal(await verifier.verify({ manager: "npm", executable }), false);

    await writeFile(executable, "#!/bin/sh\nexit 1\n");
    assert.equal(await verifier.verify({ manager: "apt-get", executable }), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an executable that is writable by another POSIX identity", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX permission semantics are not available on Windows.");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "opendelegate-system-package-verifier-"));
  const executable = join(root, "brew");
  try {
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o777 });
    await chmod(executable, 0o777);
    await assert.rejects(
      createConfiguredSystemPackageVerifier({
        platform: "macos",
        executables: { brew: executable },
      }),
      /stable private file/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
