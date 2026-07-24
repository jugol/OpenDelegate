import type { OwnerId } from "./identifiers.ts";

export interface DiscordOwnerIdentity {
  readonly guildId: string;
  readonly userId: string;
}

export interface CreateOwner {
  readonly id: OwnerId;
  readonly displayName: string;
  readonly discordIdentities?: readonly DiscordOwnerIdentity[];
}

export interface OwnerSnapshot {
  readonly id: string;
  readonly displayName: string;
  readonly discordIdentities: readonly DiscordOwnerIdentity[];
}

export class Owner {
  public readonly id: OwnerId;
  public readonly displayName: string;
  private readonly allowedDiscordIdentities = new Map<string, DiscordOwnerIdentity>();

  private constructor(input: CreateOwner) {
    this.id = input.id;
    this.displayName = input.displayName;

    for (const identity of input.discordIdentities ?? []) {
      this.allowDiscordIdentity(identity);
    }
  }

  public static create(input: CreateOwner): Owner {
    return new Owner(input);
  }

  public get discordIdentities(): readonly DiscordOwnerIdentity[] {
    return freezeIdentities(this.allowedDiscordIdentities.values());
  }

  public get snapshot(): OwnerSnapshot {
    return Object.freeze({
      id: this.id.value,
      displayName: this.displayName,
      discordIdentities: this.discordIdentities,
    });
  }

  public allowDiscordIdentity(identity: DiscordOwnerIdentity): void {
    const frozenIdentity = Object.freeze({ ...identity });
    this.allowedDiscordIdentities.set(identityKey(identity), frozenIdentity);
  }

  public revokeDiscordIdentity(identity: DiscordOwnerIdentity): void {
    this.allowedDiscordIdentities.delete(identityKey(identity));
  }

  public isDiscordIdentityAllowed(identity: DiscordOwnerIdentity): boolean {
    return this.allowedDiscordIdentities.has(identityKey(identity));
  }
}

function identityKey(identity: DiscordOwnerIdentity): string {
  return `${identity.guildId}\u0000${identity.userId}`;
}

function freezeIdentities(
  identities: Iterable<DiscordOwnerIdentity>,
): readonly DiscordOwnerIdentity[] {
  return Object.freeze(
    [...identities]
      .map((identity) => Object.freeze({ ...identity }))
      .sort(
        (left, right) =>
          left.guildId.localeCompare(right.guildId) || left.userId.localeCompare(right.userId),
      ),
  );
}
