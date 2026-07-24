import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readStableRegularFile, StableFileError } from "../src/stable-file.ts";

test("stable file reads are handle-bound, byte-limited, and link rejecting", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-stable-file-"));
  t.after(() => rm(root, { force: true, recursive: true }));

  const regular = join(root, "regular.txt");
  await writeFile(regular, "stable");
  assert.equal((await readStableRegularFile(regular, 6)).toString("utf8"), "stable");
  await assert.rejects(
    readStableRegularFile(regular, 5),
    (error: unknown) => error instanceof StableFileError && error.code === "TOO_LARGE",
  );

  const target = join(root, "target");
  const linked = join(root, "linked");
  await mkdir(target);
  await symlink(target, linked, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    readStableRegularFile(linked),
    (error: unknown) => error instanceof StableFileError && error.code === "NOT_REGULAR",
  );
});
