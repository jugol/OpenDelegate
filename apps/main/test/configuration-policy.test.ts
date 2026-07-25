import assert from "node:assert/strict";
import test from "node:test";

import type {
  ConfigurationDiff,
  ConfigurationMutationAuthorizationInput,
} from "@opendelegate/configuration";

import { authorizeMainConfigurationMutation } from "../src/configuration-policy.ts";

test("allows automatic Device profile mutations only", () => {
  assert.deepEqual(authorizeMainConfigurationMutation(input([diff("device.display-name")])), {
    decision: "allow",
    authority: "policy",
    decisionId: "device-profile-auto-apply-v1",
  });
  assert.equal(
    authorizeMainConfigurationMutation(
      input([diff("device.roles"), diff("device.instructions")], "rollback"),
    ).decision,
    "allow",
  );
});

test("requires explicit owner approval for protected or mixed mutations", () => {
  for (const protectedDiff of [
    [diff("artifact.exposure")],
    [diff("device.roles"), diff("transport.routes")],
    [],
  ]) {
    assert.deepEqual(authorizeMainConfigurationMutation(input(protectedDiff)), {
      decision: "require-approval",
      code: "PROTECTED_CONFIGURATION_REQUIRES_OWNER_APPROVAL",
    });
  }
});

function input(
  changes: readonly ConfigurationDiff[],
  tool: "apply" | "rollback" = "apply",
): ConfigurationMutationAuthorizationInput {
  return {
    actor: "owner_1",
    context: {
      instanceId: "instance_1",
      mainId: "device_main",
      deviceId: "device_worker",
    },
    tool,
    reason: "Owner-requested configuration change.",
    diff: changes,
    ...(tool === "apply" ? { proposalId: "proposal_1" } : { changeSetId: "change_set_1" }),
  };
}

function diff(key: string): ConfigurationDiff {
  return {
    key,
    scope: { kind: "device", id: "device_worker" },
    before: undefined,
    after: "updated",
  };
}
