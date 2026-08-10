import assert from "node:assert/strict";
import test from "node:test";

import { renderWorkerRuntimeContext } from "../src/worker-app.ts";

test("Worker runtime context exposes bounded Run facts without local paths", () => {
  const context = renderWorkerRuntimeContext({
    deviceId: "device-windows",
    deviceName: "5090White",
    osFamily: "windows",
    serviceMode: "system-service",
    releaseVersion: "0.1.0-alpha.25",
    provider: "codex",
    adapterId: "codex-app-server",
    adapterVersion: "0.146.0",
    modelId: "gpt-5.6-sol",
    workspace: {
      workspaceId: "workspace-opendelegate",
      alias: "OpenDelegate",
      isolation: "opendelegate-worktree",
    },
  });

  assert.match(context, /Device hostname: 5090White/u);
  assert.match(context, /OS family: windows/u);
  assert.match(context, /OpenDelegate Worker release: 0\.1\.0-alpha\.25/u);
  assert.match(context, /Selected adapter: codex-app-server/u);
  assert.match(context, /Workspace isolation: opendelegate-worktree/u);
  assert.doesNotMatch(context, /[A-Z]:\\|\/Users\/|\/home\//u);
  assert.match(context, /do not use shell, OS, filesystem, or network tools merely to rediscover/u);
});
