import assert from "node:assert/strict";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { inspectExistingRuntimePath } from "../src/internal/runtime-path-inspection.ts";

test("runtime inspection skips only a path that vanished after enumeration", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-runtime-path-inspection-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const path = join(root, "native-session-leases.json.mutation.lock");
  await writeFile(path, "lock", { mode: 0o600 });

  const present = await inspectExistingRuntimePath(path, lstat);
  assert.equal(present?.isFile(), true);

  assert.equal(
    await inspectExistingRuntimePath(path, async () => {
      throw Object.assign(new Error("The enumerated lock was released."), { code: "ENOENT" });
    }),
    undefined,
  );

  await assert.rejects(
    inspectExistingRuntimePath(path, async () => {
      throw Object.assign(new Error("Inspection permission was denied."), { code: "EACCES" });
    }),
    { code: "EACCES" },
  );
});
