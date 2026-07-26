import assert from "node:assert/strict";
import fs from "node:fs";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname } from "node:path";

const statePath = process.argv[2];
assert.ok(statePath);
const lockPath = `${statePath}.mutation.lock`;
await mkdir(dirname(statePath), { recursive: true });
await writeFile(
  lockPath,
  JSON.stringify({
    pid: 2_147_483_647,
    token: "00000000-0000-4000-8000-000000000000",
    createdAt: Date.now() - 60_000,
  }),
  { encoding: "utf8", mode: 0o600 },
);

const originalOpen = fs.promises.open;
let mutationOpenCalls = 0;
let injectedFailures = 0;
fs.promises.open = async (path, flags, mode) => {
  if (path === lockPath && flags === "wx") {
    mutationOpenCalls += 1;
    if (mutationOpenCalls === 3) {
      injectedFailures += 1;
      throw Object.assign(new Error("Injected Windows delete-pending contention."), {
        code: "EPERM",
        errno: -4048,
        path,
        syscall: "open",
      });
    }
  }
  return await originalOpen(path, flags, mode);
};
syncBuiltinESMExports();

try {
  const { AgentAdapterError, FileSessionLeaseStore } = await import("../src/index.ts");
  const left = new FileSessionLeaseStore({ statePath });
  const right = new FileSessionLeaseStore({ statePath });
  const outcomes = await Promise.allSettled([
    left.acquire("recovered-session", "run-left", 1_000, 35_000),
    right.acquire("recovered-session", "run-right", 1_000, 35_000),
  ]);
  const rejected = outcomes.find((outcome) => outcome.status === "rejected");
  assert.ok(rejected?.status === "rejected");
  assert.ok(rejected.reason instanceof AgentAdapterError);
  await assert.rejects(
    lstat(lockPath),
    (error) => error instanceof Error && "code" in error && error.code === "ENOENT",
  );
  process.stdout.write(
    JSON.stringify({
      fulfilled: outcomes.filter((outcome) => outcome.status === "fulfilled").length,
      rejectedCode: rejected.reason.code,
      injectedFailures,
      lockRemoved: true,
    }),
  );
} finally {
  fs.promises.open = originalOpen;
  syncBuiltinESMExports();
}
