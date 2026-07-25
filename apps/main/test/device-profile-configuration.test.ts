import assert from "node:assert/strict";
import test from "node:test";

import type { EffectiveConfigurationValue } from "@opendelegate/configuration";

import { projectMainOwnedDeviceProfile } from "../src/index.ts";

test("Device profiles expose effective configurable and immutable Policies", () => {
  const deviceScope = { kind: "device" as const, id: "device-worker-1" };
  const profile = projectMainOwnedDeviceProfile({
    "device.display-name": effective("device.display-name", "Release workstation", deviceScope),
    "device.roles": effective("device.roles", ["release-engineering"], deviceScope),
    "device.instructions": effective(
      "device.instructions",
      ["Use signed release workspaces only."],
      deviceScope,
    ),
    "policy.official-package-install": effective(
      "policy.official-package-install",
      "deny",
      deviceScope,
    ),
    "policy.network-change": defaulted("policy.network-change", "require-approval"),
  });

  assert.equal(profile?.displayName, "Release workstation");
  assert.deepEqual(profile?.roles, ["release-engineering"]);
  assert.deepEqual(profile?.instructions, ["Use signed release workspaces only."]);
  assert.deepEqual(profile?.policies, [
    {
      policyId: "policy.official-package-install",
      actionCategory: "configured-official-package-install",
      decision: "deny",
      source: "configuration",
      effectiveScope: "device",
    },
    {
      policyId: "policy.network-change",
      actionCategory: "os-network-change",
      decision: "require-approval",
      source: "built-in",
      effectiveScope: "instance",
    },
    {
      policyId: "built-in-secret-export",
      actionCategory: "secret-export",
      decision: "deny",
      source: "built-in",
      effectiveScope: "instance",
    },
    {
      policyId: "built-in-cross-device-knowledge-transfer",
      actionCategory: "cross-device-knowledge-transfer",
      decision: "deny",
      source: "built-in",
      effectiveScope: "instance",
    },
    {
      policyId: "built-in-policy-bypass-attempt",
      actionCategory: "policy-bypass-attempt",
      decision: "deny",
      source: "built-in",
      effectiveScope: "instance",
    },
  ]);
});

function effective(
  key: string,
  value: unknown,
  source: Extract<EffectiveConfigurationValue["source"], object>,
): EffectiveConfigurationValue {
  return {
    key,
    value,
    source,
    inherited: false,
    candidates: [{ scope: source, value }],
  };
}

function defaulted(key: string, value: unknown): EffectiveConfigurationValue {
  return {
    key,
    value,
    source: "default",
    inherited: false,
    candidates: [],
  };
}
