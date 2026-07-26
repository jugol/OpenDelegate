# Discord Forum setup

Discord is disabled when Main has no Discord binding. Enabling it requires an
owner-authored, non-secret JSON file during `init`:

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "botTokenAlias": "discord-bot",
  "forum": {
    "applicationId": "100000000000000001",
    "botUserId": "100000000000000002",
    "guildId": "100000000000000003",
    "forumBindings": [
      {
        "channelId": "100000000000000004",
        "workflowTagIds": {
          "intake": "200000000000000001",
          "running": "200000000000000002",
          "waiting": "200000000000000003",
          "review": "200000000000000004",
          "done": "200000000000000005",
          "failed": "200000000000000006"
        }
      }
    ],
    "ownerUserIds": ["100000000000000005"],
    "allowedRoleIds": []
  },
  "secretBackend": {
    "backend": "windows-dpapi",
    "vaultRoot": "C:\\ProgramData\\OpenDelegate\\secrets\\discord"
  }
}
```

The binding accepts IDs, workflow-tag mappings, backend metadata, and a Secret
Store alias only. Unknown fields and credential values are rejected. Select the
backend for the Main host:

- Windows: `windows-dpapi` with an absolute `vaultRoot`.
- macOS: `macos-keychain` with the signed helper's absolute `helperPath` and
  `expectedHelperSha256`.
- graphical Linux: `linux-secret-service` with the absolute `secretToolPath`.
- headless Linux: `linux-systemd-credential-vault` with `credentialName` and an
  absolute `vaultRoot`; the service must provide `CREDENTIALS_DIRECTORY`.

Provision the bot token through bounded stdin during initialization. Feed it
directly from an interactive credential provider or password manager; do not put
the value in command arguments, a shell variable, or the process environment:

```text
<credential-provider> | opendelegate init \
  --discord-config /absolute/path/discord.json \
  --discord-token-stdin
```

Main copies the credential bytes into the selected Device-local managed Secret
Store and persists only `botTokenAlias`. Omit
`--discord-token-stdin` when that alias has already been provisioned. One init
invocation can provision only one stdin Secret, so initialize the database and
Discord in separate invocations when both credentials are new.
Subsequent `serve` runs reconstruct the backend from non-secret configuration.
If Discord is offline or its credential is unavailable, Admin Web and the
durable Task service remain available while Discord reports an unavailable
feature status and retries safely.

This setup path does not replace the live private-laboratory release gate in
[`release/PLATFORM_LAB.md`](release/PLATFORM_LAB.md).
