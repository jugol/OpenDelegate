import assert from "node:assert/strict";
import test from "node:test";

import { DeviceId, DomainError, Instance, InstanceId, Owner, OwnerId } from "../src/index.ts";

test("an Instance has one Owner, one fixed Main Device, and Assisted autonomy by default", () => {
  const owner = Owner.create({
    id: OwnerId.from("owner-personal"),
    displayName: "Personal owner",
  });
  const mainDeviceId = DeviceId.from("device-main");
  const instance = Instance.create({
    id: InstanceId.from("instance-personal"),
    ownerId: owner.id,
    mainDeviceId,
  });

  assert.deepEqual(instance.snapshot, {
    id: "instance-personal",
    ownerId: "owner-personal",
    mainDeviceId: "device-main",
    deviceIds: ["device-main"],
    autonomyProfile: "assisted",
  });
  assert.equal(Object.isFrozen(instance.snapshot), true);
  assert.equal(Object.isFrozen(instance.snapshot.deviceIds), true);

  instance.assignMainDevice(mainDeviceId);
  assert.throws(
    () => instance.assignMainDevice(DeviceId.from("device-replacement")),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "INSTANCE_MAIN_FIXED");
      return true;
    },
  );
});

test("the Owner maintains an immutable allowlist without creating another tenant", () => {
  const owner = Owner.create({
    id: OwnerId.from("owner-personal"),
    displayName: "Personal owner",
  });

  owner.allowDiscordIdentity({
    guildId: "guild-home",
    userId: "discord-owner",
  });
  owner.allowDiscordIdentity({
    guildId: "guild-home",
    userId: "discord-owner",
  });

  assert.equal(
    owner.isDiscordIdentityAllowed({
      guildId: "guild-home",
      userId: "discord-owner",
    }),
    true,
  );
  assert.deepEqual(owner.discordIdentities, [
    {
      guildId: "guild-home",
      userId: "discord-owner",
    },
  ]);
  assert.equal(Object.isFrozen(owner.discordIdentities), true);
  assert.equal(Object.isFrozen(owner.discordIdentities[0]), true);
});
