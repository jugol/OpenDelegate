import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { resolveDefaultCodexCommand } from "../src/index.ts";

test("Windows Codex command resolution uses the bounded global npm package path", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opendelegate-codex-command-")));
  t.after(() => rm(root, { force: true, recursive: true }));
  const entrypoint = join(root, "node_modules", "@openai", "codex", "bin", "codex.js");
  await mkdir(dirname(entrypoint), { recursive: true });
  await writeFile(entrypoint, "// fixture\n", { encoding: "utf8", mode: 0o600 });

  const command = resolveDefaultCodexCommand({
    environment: { Path: `"${root}"` },
    hostPlatform: "win32",
    nodeExecutable: "C:\\OpenDelegate\\runtime\\node.exe",
  });

  assert.equal(command.executable, "C:\\OpenDelegate\\runtime\\node.exe");
  assert.deepEqual(command.prefixArgs, [await realpath(entrypoint)]);
});

test("Codex command resolution never executes an npm shell shim", () => {
  assert.deepEqual(
    resolveDefaultCodexCommand({
      environment: { PATH: "C:\\empty" },
      hostPlatform: "win32",
    }),
    { executable: "codex", prefixArgs: [] },
  );
});
