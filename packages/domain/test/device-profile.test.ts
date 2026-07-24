import assert from "node:assert/strict";
import test from "node:test";

import { DeviceId, DeviceProfile, DomainError, type DeviceProfilePatch } from "../src/index.ts";

const workerProposal: DeviceProfilePatch = {
  proposalId: "profile-patch-computer-use",
  baseRevision: 1,
  roles: ["development", "desktop-automation"],
  instructions: [
    "Prefer structured browser automation for browser-only work.",
    "Acquire the desktop-session lock before Computer Use.",
  ],
  reason: "Codex and a verified graphical session are available.",
};

test("Main can apply a Worker-proposed Device Profile patch with an auditable revision", () => {
  const profile = DeviceProfile.create({
    id: DeviceId.from("device-windows-dev"),
    name: "Windows Dev",
    osFamily: "windows",
    roles: ["development"],
    instructions: ["Keep generated work in registered Workspaces."],
  });

  const change = profile.applyPatch({
    patch: workerProposal,
    authority: {
      kind: "main-agent",
      authorityId: "main-agent-primary",
    },
  });

  assert.equal(profile.revision, 2);
  assert.deepEqual(profile.roles, ["development", "desktop-automation"]);
  assert.deepEqual(profile.instructions, workerProposal.instructions);
  assert.deepEqual(change, {
    deviceId: "device-windows-dev",
    proposalId: "profile-patch-computer-use",
    previousRevision: 1,
    revision: 2,
    authority: {
      kind: "main-agent",
      authorityId: "main-agent-primary",
    },
    reason: "Codex and a verified graphical session are available.",
  });
});

test("a Worker cannot directly persist its own Role or Instructions", () => {
  const profile = DeviceProfile.create({
    id: DeviceId.from("device-linux-nas"),
    name: "NAS",
    osFamily: "linux",
    roles: ["storage"],
    instructions: [],
  });

  assert.throws(
    () =>
      profile.applyPatch({
        patch: {
          ...workerProposal,
          roles: ["unrestricted-admin"],
        },
        authority: {
          kind: "worker-agent",
          authorityId: "worker-agent-local",
        },
      }),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "DEVICE_PROFILE_AUTHORITY_REQUIRED");
      return true;
    },
  );
  assert.equal(profile.revision, 1);
  assert.deepEqual(profile.roles, ["storage"]);
});

test("a stale Device Profile patch cannot overwrite a newer Main decision", () => {
  const profile = DeviceProfile.create({
    id: DeviceId.from("device-mac-studio"),
    name: "Mac Studio",
    osFamily: "macos",
    roles: ["coordination"],
    instructions: [],
  });
  profile.applyPatch({
    patch: {
      ...workerProposal,
      roles: ["coordination", "research"],
    },
    authority: {
      kind: "owner",
      authorityId: "owner-personal",
    },
  });

  assert.throws(
    () =>
      profile.applyPatch({
        patch: workerProposal,
        authority: {
          kind: "main-agent",
          authorityId: "main-agent-primary",
        },
      }),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "DEVICE_PROFILE_REVISION_CONFLICT");
      return true;
    },
  );
  assert.equal(profile.revision, 2);
  assert.deepEqual(profile.roles, ["coordination", "research"]);
});

test("Device Profile collections are returned as immutable snapshots", () => {
  const profile = DeviceProfile.create({
    id: DeviceId.from("device-local"),
    name: "Local",
    osFamily: "windows",
    roles: ["development"],
    instructions: ["Do not expose local Secrets."],
  });

  assert.equal(Object.isFrozen(profile.roles), true);
  assert.equal(Object.isFrozen(profile.instructions), true);
  assert.equal(profile.osFamily, "windows");
});
