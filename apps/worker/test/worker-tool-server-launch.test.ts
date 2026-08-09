import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { resolveWorkerToolServerLaunch } from "../src/worker-app.ts";

test("source Workers launch internal MCP bridges through the Worker CLI", () => {
  const sourceModule = resolve("apps/worker/src/worker-app.ts");

  assert.deepEqual(resolveWorkerToolServerLaunch(sourceModule), {
    command: process.execPath,
    argsPrefix: ["--experimental-strip-types", join(dirname(sourceModule), "cli.ts")],
  });
});

test("bundled Workers launch internal MCP bridges through the release launcher", () => {
  const bundledModule = resolve("release/apps/worker/opendelegate-service-host.mjs");

  assert.deepEqual(resolveWorkerToolServerLaunch(bundledModule), {
    command: process.execPath,
    argsPrefix: [resolve("release/apps/launcher/opendelegate.mjs"), "worker"],
  });
});
