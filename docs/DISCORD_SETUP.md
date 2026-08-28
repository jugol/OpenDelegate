# Discord Forum setup

> [!WARNING]
> **Legacy prototype only.** This guide configures the retired Admin Web/Main prototype; it is not
> part of the current SSH-first OpenDelegate workflow. Read [`CONTEXT.md`](../CONTEXT.md) and
> [`README.md`](../README.md) for current Device setup and operations.

OpenDelegate uses Discord as an owner-facing Task client: one Forum post maps to one durable Task,
and replies in that post continue the same Task. Main remains the source of truth.

Discord is optional. If the owner declines it, keep the installation explicitly Discord-disabled,
stop this guide, and create Tasks through **Admin Web → Tasks → New task**. The candidate validity
rules below apply only after the owner selects Discord.

> [!IMPORTANT]
> Read `release-metadata.json` and use the path for its exact `supportStatus`. A
> `release-candidate` remains unsupported until external promotion, but its bundled onboarding must
> use the verified Configuration Chat path. A status beginning with `internal-preview` remains
> unsupported even though it exposes the same binding lifecycle for evaluation.

> [!WARNING]
> Never paste the bot token into Configuration Chat's conversation composer, a Task, JSON, a shell
> argument, an environment variable, a temporary plaintext file, Discord, or a log. Use the
> separate secure credential panel inside Configuration Chat. Only its opaque Main-local alias
> reaches the Agent and durable configuration.

> [!IMPORTANT]
> OpenDelegate has no packaged tag-discovery command. Discord does not document a Developer Mode
> action for copying Forum tag IDs, so setup must read them from `available_tags` in
> Discord's `GET /channels/{forumChannelId}` response through an owner-controlled, secret-safe API
> client. Stop setup if that boundary is unavailable.

The Discord UI can change. Use Discord's official
[App quick start](https://docs.discord.com/developers/quick-start/getting-started),
[Community setup](https://support.discord.com/hc/en-us/articles/360047132851-Enabling-Your-Community-Server),
and [Forum guide](https://support.discord.com/hc/en-us/articles/6208479917079-Forum-Channels-FAQ)
alongside this OpenDelegate-specific checklist.

## Supported binding lifecycle

You may initialize Main with Discord disabled and return later. Open **Admin Web → Configuration
Chat**, use its secure credential panel for the token, and let the Configuration Agent propose the
non-secret `discord.binding`. The owner reviews the exact diff and approves it in **Approvals**.

The same path adds the first binding, appends Forum Channels, replaces a bot, guild, or Forum, and
disables Discord. Main checks the candidate credential and installation, serializes the one Gateway
transition, and restores the previous binding if activation or Configuration commit fails. Durable
Tasks and native Agent sessions remain authoritative in Main; old Discord thread identities are
not silently migrated.

For release-candidate bytes, failure to expose or complete this path is a release blocker. Internal
previews may exercise it but remain unsupported.

## Discord-side preparation

### 1. Create the Discord App and bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications), select
   **New Application**, and create a dedicated App for this OpenDelegate instance.
2. On **General Information**, record the Application ID. This becomes `"applicationId"`.
3. On **Bot**, keep the dedicated bot user and record its user ID later from Discord Developer Mode.
4. Create or reset the bot token only when you are ready to provision it through Configuration
   Chat's secure credential panel or the optional first-init bounded-stdin path. Store it in an
   owner-controlled password manager or credential provider; do not paste it into the JSON
   configuration.
5. On **Installation**, enable Guild Install and select only the `bot` OAuth scope. The current
   runtime does not require `applications.commands`, a user install, an Interactions Endpoint URL,
   or a webhook.

Do not reuse a general-purpose bot. A dedicated App keeps its token, intents, permissions, and
revocation boundary specific to OpenDelegate.

### 2. Prepare the Community server and Forum

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

### 3. Configure intents and permissions

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

Optionally grant `ADD_REACTIONS` if you want OpenDelegate's lifecycle to appear on the exact owner
message: `👀` while the Task turn is active, then `✅` after a durable response or `❌` after a
failure. OpenDelegate treats this as presentation-only: the installation remains ready without it,
Discord typing still provides transient activity, and a missing reaction permission never blocks
Task ingestion.

Do not grant `ADMINISTRATOR`, `MANAGE_CHANNELS`, or `CREATE_PUBLIC_THREADS` for the current manual
setup. OpenDelegate needs `MANAGE_THREADS` to project tags and reconcile owner-created posts; it
does not need authority to configure the server or create Forum Channels.

See Discord's official [Gateway intent reference](https://docs.discord.com/developers/events/gateway)
and [thread permission model](https://docs.discord.com/developers/topics/threads) for the platform
semantics.

### 4. Collect the non-secret IDs

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

OpenDelegate does not provide a packaged secret-safe client for that request. An init Agent may use a
pre-existing owner-approved credential provider that writes the authorization material directly to
a bounded child process, but it must not receive or print the token itself. If that is not possible,
leave Discord disabled and record tag discovery as an explicit setup blocker.

### 5. Create the OpenDelegate binding

For Configuration Chat, collect the fields in this exact non-secret value. The Agent will compose
and validate it through typed tools; you do not need to create a file:

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
  }
}
```

The binding supports one Guild and 1–100 Forum Channels in that Guild. Every ID must be a 17–20
digit Discord snowflake. At least one Owner User ID is required; the Role allowlist may be empty.
Unknown fields, duplicate IDs, missing workflow states, and credential values are rejected.

### 6. Provision or verify the bot token

1. Claim Main, sign in to Admin Web, and inspect the effective `discord.binding`.
2. If first init already seeded the intended binding and provisioned its token, confirm the IDs from
   sections 4–5 and require `ready / DISCORD_READY`. Do not upload the token again or submit an
   identical proposal.
3. For a deferred, new, or changed binding, open **Configuration Chat** and select
   **Discord bot token** under **Credential type**.
4. Paste the token only into that password field and choose **Store securely**. The browser clears
   its byte buffer after intake and sends the Agent only a reference such as
   `secret://main/discord_...`.
5. Ask the Agent to configure Discord using the IDs from sections 4–5. It stores only the suffix
   after `secret://main/` as `botTokenAlias`.
6. Review the typed proposal, approve it in **Approvals**, and wait for
   `ready / DISCORD_READY`.

To add a Forum, preserve all existing `forumBindings` entries and append the new Channel. To replace
the bot, guild, or Forum, submit the complete replacement object. To disable Discord, set
`discord.binding` to `null`. A failed candidate leaves the previous binding active.

First-init provisioning remains available for an Agent that already has the complete non-secret
binding. In that optional flow, the JSON file adds a platform-specific `secretBackend` descriptor
matching Main's top-level managed Secret Store. The credential provider writes only the token bytes
to bounded stdin and closes it. On Windows, the init Agent uses:

```powershell
.\opendelegate.cmd init --discord-config ABSOLUTE_PATH --discord-token-stdin
```

On macOS and Linux:

```sh
./opendelegate init --discord-config ABSOLUTE_PATH --discord-token-stdin
```

One init invocation can provision only one stdin Secret. If PostgreSQL and Discord both need new
credentials during first init, provision the PostgreSQL URI first with
`--database-uri-stdin`, then repeat the same complete non-secret `init` options with
`--discord-token-stdin`. Do not change the binding or any other persisted setting between those
invocations.

Re-running `init` is only for that exact bootstrap configuration and token rotation. Use
Configuration Chat—not `main.json` edits or a different `init` request—for every later binding
change.

### 7. Verify the first Task

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
| Credential unavailable | Store or rotate the credential through Configuration Chat's secure panel; use bounded stdin only for the optional first-init flow. |
| Discord offline or rate-limited | Keep using Admin Web and let durable reconciliation retry safely. |

This deterministic probe is not live release proof. The dedicated server, desktop/mobile journey,
Gateway resume, rate-limit, permission-loss, and outage evidence remain part of the
[private Discord release laboratory](release/PLATFORM_LAB.md).
