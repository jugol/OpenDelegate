import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  EXPECTED_WORKSPACE_DEPENDENCIES,
  auditWorkspaceBoundaries,
  validateWorkspaceGraph,
  validateWorkspaceTooling,
} from "../check-workspace-boundaries.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

test("the checked-in workspace graph matches the accepted module map", async () => {
  assert.deepEqual(await auditWorkspaceBoundaries(repositoryRoot), []);
});

test("Phase 2 services keep their accepted inward dependency directions", () => {
  assert.deepEqual(EXPECTED_WORKSPACE_DEPENDENCIES["@opendelegate/configuration"], []);
  assert.deepEqual(EXPECTED_WORKSPACE_DEPENDENCIES["@opendelegate/control-plane"], [
    "@opendelegate/event-store",
    "@opendelegate/owner-auth",
    "@opendelegate/protocol",
    "@opendelegate/task-service",
  ]);
  assert.deepEqual(EXPECTED_WORKSPACE_DEPENDENCIES["@opendelegate/main"], [
    "@opendelegate/agent-adapters",
    "@opendelegate/artifact-gateway",
    "@opendelegate/artifact-store",
    "@opendelegate/configuration",
    "@opendelegate/control-plane",
    "@opendelegate/device-channel",
    "@opendelegate/device-identity",
    "@opendelegate/discord-adapter",
    "@opendelegate/domain",
    "@opendelegate/event-store",
    "@opendelegate/owner-auth",
    "@opendelegate/platform-services",
    "@opendelegate/policy",
    "@opendelegate/protocol",
    "@opendelegate/release-integrity",
    "@opendelegate/scheduler",
    "@opendelegate/secrets",
    "@opendelegate/storage-sql",
    "@opendelegate/task-service",
  ]);
  assert.deepEqual(EXPECTED_WORKSPACE_DEPENDENCIES["@opendelegate/owner-auth"], []);
  assert.deepEqual(EXPECTED_WORKSPACE_DEPENDENCIES["@opendelegate/storage-sql"], [
    "@opendelegate/artifact-store",
    "@opendelegate/configuration",
    "@opendelegate/device-channel",
    "@opendelegate/device-identity",
    "@opendelegate/discord-adapter",
    "@opendelegate/event-store",
    "@opendelegate/owner-auth",
    "@opendelegate/policy",
  ]);
  assert.deepEqual(EXPECTED_WORKSPACE_DEPENDENCIES["@opendelegate/task-service"], [
    "@opendelegate/domain",
    "@opendelegate/event-store",
    "@opendelegate/protocol",
  ]);
  assert.ok(
    EXPECTED_WORKSPACE_DEPENDENCIES["@opendelegate/worker"].includes(
      "@opendelegate/computer-use-os",
    ),
  );
  assert.ok(
    EXPECTED_WORKSPACE_DEPENDENCIES["@opendelegate/worker"].includes(
      "@opendelegate/computer-use-mcp",
    ),
  );
  assert.ok(
    EXPECTED_WORKSPACE_DEPENDENCIES["@opendelegate/worker"].includes(
      "@opendelegate/run-capability-broker",
    ),
  );
  assert.ok(
    EXPECTED_WORKSPACE_DEPENDENCIES["@opendelegate/worker"].includes(
      "@opendelegate/platform-services",
    ),
  );
});

test("platform and external adapter packages keep injected ports at their edges", () => {
  assert.deepEqual(EXPECTED_WORKSPACE_DEPENDENCIES["@opendelegate/agent-adapters"], []);
  assert.deepEqual(EXPECTED_WORKSPACE_DEPENDENCIES["@opendelegate/computer-use-mcp"], []);
  assert.deepEqual(EXPECTED_WORKSPACE_DEPENDENCIES["@opendelegate/computer-use-os"], []);
  assert.deepEqual(EXPECTED_WORKSPACE_DEPENDENCIES["@opendelegate/discord-adapter"], []);
  assert.deepEqual(EXPECTED_WORKSPACE_DEPENDENCIES["@opendelegate/platform-services"], [
    "@opendelegate/release-integrity",
  ]);
  assert.deepEqual(EXPECTED_WORKSPACE_DEPENDENCIES["@opendelegate/run-capability-broker"], []);
  assert.deepEqual(EXPECTED_WORKSPACE_DEPENDENCIES["@opendelegate/session-helper-ipc"], []);
});

test("an undeclared workspace dependency fails the boundary check", () => {
  const errors = validateWorkspaceGraph(
    [
      {
        name: "@opendelegate/domain",
        internalDependencies: ["@opendelegate/knowledge"],
      },
      {
        name: "@opendelegate/knowledge",
        internalDependencies: [],
      },
    ],
    {
      "@opendelegate/domain": [],
      "@opendelegate/knowledge": [],
    },
  );

  assert.deepEqual(errors, [
    "@opendelegate/domain has unexpected workspace dependency @opendelegate/knowledge.",
  ]);
});

test("a missing or unknown workspace cannot bypass review", () => {
  const errors = validateWorkspaceGraph(
    [
      {
        name: "@opendelegate/domain",
        internalDependencies: ["@opendelegate/missing"],
      },
      {
        name: "@opendelegate/unmapped",
        internalDependencies: [],
      },
    ],
    {
      "@opendelegate/domain": [],
      "@opendelegate/knowledge": [],
    },
  );

  assert.deepEqual(errors, [
    "Expected workspace @opendelegate/knowledge is missing.",
    "Workspace @opendelegate/unmapped has no boundary-map entry.",
    "@opendelegate/domain depends on unknown workspace @opendelegate/missing.",
    "@opendelegate/domain has unexpected workspace dependency @opendelegate/missing.",
  ]);
});

test("a dependency cycle fails even when every edge is allowlisted", () => {
  const errors = validateWorkspaceGraph(
    [
      {
        name: "@opendelegate/domain",
        internalDependencies: ["@opendelegate/protocol"],
      },
      {
        name: "@opendelegate/protocol",
        internalDependencies: ["@opendelegate/domain"],
      },
    ],
    {
      "@opendelegate/domain": ["@opendelegate/protocol"],
      "@opendelegate/protocol": ["@opendelegate/domain"],
    },
  );

  assert.deepEqual(errors, [
    "Workspace dependency cycle detected: @opendelegate/domain -> @opendelegate/protocol -> @opendelegate/domain.",
  ]);
});

test("duplicate workspace names fail deterministically", () => {
  const errors = validateWorkspaceGraph(
    [
      {
        name: "@opendelegate/domain",
        internalDependencies: [],
      },
      {
        name: "@opendelegate/domain",
        internalDependencies: [],
      },
    ],
    {
      "@opendelegate/domain": [],
    },
  );

  assert.deepEqual(errors, ["Workspace name @opendelegate/domain is declared more than once."]);
});

test("a workspace without an isolated typecheck surface fails", () => {
  assert.deepEqual(
    validateWorkspaceTooling([
      {
        name: "@opendelegate/domain",
        hasLocalTsconfig: false,
        hasTypecheckScript: false,
        testScript: "",
      },
    ]),
    [
      "@opendelegate/domain must have a package-local tsconfig.json.",
      "@opendelegate/domain must expose an isolated typecheck script.",
      "@opendelegate/domain must expose a test script.",
    ],
  );
});

test("a positional Node test path cannot silently exclude future test files", () => {
  assert.deepEqual(
    validateWorkspaceTooling([
      {
        name: "@opendelegate/domain",
        hasLocalTsconfig: true,
        hasTypecheckScript: true,
        testScript: "node --experimental-strip-types --test test/domain.test.ts",
      },
    ]),
    [
      "@opendelegate/domain must use suite-wide Node test discovery instead of positional test paths.",
    ],
  );

  assert.deepEqual(
    validateWorkspaceTooling([
      {
        name: "@opendelegate/domain",
        hasLocalTsconfig: true,
        hasTypecheckScript: true,
        testScript: "node --experimental-strip-types --test",
      },
    ]),
    [],
  );
});
