# Discord Forum setup

OpenDelegate uses Discord as an owner-facing Task client: one Forum post maps to one durable Task,
and replies in that post continue the same Task. Main remains the source of truth.

> [!WARNING]
> The current internal preview must receive its complete Discord binding during the **first** Main
> initialization. It can rotate the token for the exact same binding later, but it cannot add or
> replace a binding on an already initialized Main. Configuration Chat does not currently create a
> Discord App, Forum, workflow tags, or a new binding.

> [!IMPORTANT]
> Discord does not document a Developer Mode action for copying Forum tag IDs, and this preview has
> no packaged tag-discovery command. Those IDs must be read from `available_tags` in Discord's
> `GET /channels/{forumChannelId}` response through an owner-controlled, secret-safe API client.
> Stop setup if that boundary is unavailable. Never expose the bot token to an Agent prompt, shell
> argument, environment variable, temporary plaintext file, Discord message, or log.

The Discord UI can change. Use Discord's official
[App quick start](https://docs.discord.com/developers/quick-start/getting-started),
[Community setup](https://support.discord.com/hc/en-us/articles/360047132851-Enabling-Your-Community-Server),
and [Forum guide](https://support.discord.com/hc/en-us/articles/6208479917079-Forum-Channels-FAQ)
alongside this OpenDelegate-specific checklist.

## 1. Create the Discord App and bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications), select
   **New Application**, and create a dedicated App for this OpenDelegate instance.
2. On **General Information**, record the Application ID. This becomes `"applicationId"`.
3. On **Bot**, keep the dedicated bot user and record its user ID later from Discord Developer Mode.
4. Create or reset the bot token only when you are ready to provision it through bounded stdin.
   Store it in an owner-controlled password manager or credential provider; do not paste it into the
   JSON configuration.
5. On **Installation**, enable Guild Install and select only the `bot` OAuth scope. The current
   runtime does not require `applications.commands`, a user install, an Interactions Endpoint URL,
   or a webhook.

Do not reuse a general-purpose bot. A dedicated App keeps its token, intents, permissions, and
revocation boundary specific to OpenDelegate.

## 2. Prepare the Community server and Forum

1. In Discord, open **Server Settings → Enable Community → Get Started** and complete Discord's
   safety checklist. Enabling Community does not itself make a server public.
2. Create a Channel with type **Forum**. A list layout is usually easiest to scan as a Task
   dashboard.
3. Add six visible workflow tags:

   | OpenDelegate key | Recommended Forum tag |
   | --- | --- |
   | `"intake"` | `Intake` |
   | `"running"` | `Running` |
   | `"waiting"` | `Waiting` |
   | `"review"` | `Review` |
   | `"done"` | `Done` |
   | `"failed"` | `Failed` |

4. Leave **Require people to select tags** disabled. OpenDelegate applies the authoritative workflow
   tag. You may make the six tags moderated because the bot receives `MANAGE_THREADS`.
5. Optional category, priority, or Device tags may coexist with the workflow tag. OpenDelegate keeps
   at most four non-workflow tags while projecting exactly one workflow tag.

The configuration keys determine each tag's meaning; the runtime cannot validate the visible tag
names. Create clear names and map each ID carefully.

## 3. Configure intents and permissions

On **Developer Portal → Bot → Privileged Gateway Intents**, enable **Message Content Intent**.
OpenDelegate connects with Gateway API v10 and requests:

- `GUILDS`
- `GUILD_MESSAGES`
- `MESSAGE_CONTENT`

`GUILDS` and `GUILD_MESSAGES` are standard intents and have no separate Portal toggle.
`MESSAGE_CONTENT` is privileged and must be enabled because Task text, attachments, components, and
poll fields otherwise arrive empty. `GUILD_MEMBERS` is not required for the OpenDelegate owner and
Role allowlists.

Install the App in the target server, then give the bot exactly these effective permissions in the
bound Forum Channel:

- `VIEW_CHANNEL`
- `READ_MESSAGE_HISTORY`
- `SEND_MESSAGES`
- `SEND_MESSAGES_IN_THREADS`
- `ATTACH_FILES`
- `MANAGE_THREADS`

The combined permission bitfield is `292057877504`. Channel overrides count: an explicit deny in the
Forum can make the installation probe fail even when the bot Role allows that permission.

Do not grant `ADMINISTRATOR`, `MANAGE_CHANNELS`, or `CREATE_PUBLIC_THREADS` for the current manual
setup. OpenDelegate needs `MANAGE_THREADS` to project tags and reconcile owner-created posts; it
does not need authority to configure the server or create Forum Channels.

See Discord's official [Gateway intent reference](https://docs.discord.com/developers/events/gateway)
and [thread permission model](https://docs.discord.com/developers/topics/threads) for the platform
semantics.

## 4. Collect the non-secret IDs

In Discord, open **User Settings → Advanced** and enable **Developer Mode**. Discord documents how
to [copy user, server, and Channel IDs](https://support.discord.com/hc/en-us/articles/206346498-Where-can-I-find-my-User-Server-Message-ID).
Collect:

- `"applicationId"` — Developer Portal → General Information;
- `"botUserId"` — right-click the installed bot user and select **Copy User ID**;
- `"guildId"` — right-click the server icon and select **Copy Server ID**;
- `"channelId"` — right-click the Forum Channel and select **Copy Channel ID**;
- `"ownerUserIds"` — copy at least one Owner User ID; and
- optional Role IDs for `"allowedRoleIds"`.

For each workflow tag, use an owner-controlled, read-only Discord API request to
`GET /channels/{forumChannelId}` and map each `available_tags[].name` to its `available_tags[].id`.
The response shape is documented in Discord's
[Channel resource](https://docs.discord.com/developers/resources/channel). The six IDs for one
Forum must be different.

The preview does not provide a packaged secret-safe client for that request. An init Agent may use a
pre-existing owner-approved credential provider that writes the authorization material directly to
a bounded child process, but it must not receive or print the token itself. If that is not possible,
leave Discord disabled and record tag discovery as an explicit setup blocker.

## 5. Create the OpenDelegate binding

Create the non-secret JSON outside the source checkout and bundle. This Windows example shows the
complete strict schema:

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
    "vaultRoot": "C:\\ProgramData\\OpenDelegate\\secrets\\main"
  }
}
```

The binding supports one Guild and 1–100 Forum Channels in that Guild. Every ID must be a 17–20
digit Discord snowflake. At least one Owner User ID is required; the Role allowlist may be empty.
Unknown fields, duplicate IDs, missing workflow states, and credential values are rejected.

The nested `"secretBackend"` descriptor is required by the current input schema, but production
`init` and `serve` use Main's top-level managed Secret Store for the bot token. Mirror the exact
Main backend descriptor here; do not treat this field as a second store or as an override. The valid
descriptor shapes are:

- Windows: `windows-dpapi` with an absolute `vaultRoot`;
- macOS: `macos-keychain` with the signed helper's absolute `helperPath` and
  `expectedHelperSha256`;
- graphical Linux: `linux-secret-service` with the absolute `secretToolPath`; or
- headless Linux: `linux-systemd-credential-vault` with `credentialName` and an absolute
  `vaultRoot`; the service must provide `CREDENTIALS_DIRECTORY`.

## 6. Provision the bot token

Pass the binding on the first Main initialization and write the bot token directly to bounded stdin:

```text
opendelegate init --discord-config ABSOLUTE_PATH --discord-token-stdin
```

On Windows the packaged launcher is `opendelegate.cmd`; on macOS and Linux it is
`./opendelegate`. Let the init Agent compose the full command with the database, listener,
Device-channel, Artifact, Agent, and Admin options selected for this Main.

The credential provider must write only the token bytes to the child process and close stdin.
OpenDelegate copies those bytes into Main's managed Secret Store and persists only
`"botTokenAlias"`. One init invocation can provision only one stdin Secret, so a new PostgreSQL URI
and a new Discord token require separate provisioning invocations. Re-running `init` may rotate the
token only when the requested persisted configuration is otherwise identical.

If Main was initialized without this binding, do not edit `main.json` or attempt to force
`CONFIG_EXISTS` aside. This preview has no supported add-binding mutation. Keep Admin Web and the
durable Task service available without Discord and record the missing product path.

## 7. Verify the first Task

After Main, its co-located Worker, and Task execution are ready:

1. Sign in to Admin Web and inspect `GET /api/v1/runtime/features`. Discord must report
   `ready / DISCORD_READY`; `opendelegate status` alone proves Main liveness, not Discord readiness.
2. From a Discord account listed in `"ownerUserIds"` or an allowed Role, create a **new Forum post**
   with a short title and Task objective.
3. Confirm that Admin Web shows exactly one new Task and Discord shows one workflow tag plus the
   bot's Components v2 status panel.
4. Add a **reply in the same post** and confirm that it continues the existing Task rather than
   creating another one.
5. Create a second Forum post and confirm that it becomes a separate Task with a clean context.
6. Complete a small Work Order and confirm the final status, controls, and any Artifact link in both
   Discord and Admin Web.

The starter body becomes the Task objective. An empty starter falls back to the Forum post title.
Empty replies are ignored, while a reply with an attachment is valid input. Messages from an
unauthorized author never enter the Task or Agent context.

If the feature is unavailable, inspect the reported reason first:

| Failure | Check |
| --- | --- |
| Missing intent | Enable Message Content Intent, then restart the Gateway connection. |
| Missing permission | Check the bot Role and the bound Forum's effective Channel overrides. |
| Missing workflow tag | Re-read `available_tags`, correct the key-to-ID mapping, and restart. |
| Credential unavailable | Re-provision or rotate the same alias through bounded stdin; never print the token. |
| Discord offline or rate-limited | Keep using Admin Web and let durable reconciliation retry safely. |

This deterministic probe is not live release proof. The dedicated server, desktop/mobile journey,
Gateway resume, rate-limit, permission-loss, and outage evidence remain part of the
[private Discord release laboratory](release/PLATFORM_LAB.md).
