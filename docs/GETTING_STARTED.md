# Getting started

OpenDelegate is installed with an Agent, then operated through Admin Web and Discord. You do not
start it with `npm run start`, copy credentials into a prompt, or configure every pair of Devices
with SSH.

This guide takes one owner from an empty Main computer to a first isolated Discord Task and an
additional Worker Device.

> [!IMPORTANT]
> No supported OpenDelegate release has been published yet. The current repository can produce an
> explicitly marked internal preview for validation. The setup journey below is the intended owner
> experience, but a preview remains unsupported until the complete release evidence and promotion
> chain says otherwise.

## Before you start

Prepare:

- one computer that will remain the fixed **Main Device**;
- Codex, Claude, or another capable local Agent on Main;
- a private route from each future Worker to Main, such as LAN, Omada, Tailscale, or an
  owner-configured tunnel;
- a Discord Community server where you can create an App, bot, and Forum Channel; and
- a password manager or another safe place for the owner passphrase, recovery codes, and bot token.

If you want Discord in the current internal preview, complete
[Discord Forum setup](DISCORD_SETUP.md) before the first deterministic `init`. The preview cannot
add or replace a Discord binding after Main has been initialized, and Configuration Chat must not
pretend that it can. You may instead initialize without Discord and use Admin Web, but that Main
will remain Discord-disabled in this build.

The Main computer may run macOS, Windows, or Linux and is also enrolled as a normal Worker. Other
Devices connect outbound to Main. They never need pairwise SSH trust or database credentials.

Choose a Main that can stay on and that you can reach for recovery even when Discord is unavailable.
Moving Main between computers is deliberately outside the first milestone.

## 1. Get an OpenDelegate bundle

Use the bundle built for the operating system and architecture of the computer you are setting up.
A bundle contains:

- `opendelegate.cmd` on Windows or `opendelegate` on macOS and Linux;
- the audited Node.js runtime used by OpenDelegate;
- `skills/opendelegate-init/SKILL.md` and `skills/opendelegate-join/SKILL.md`;
- `release-metadata.json`, `SHA256SUMS`, and the release evidence snapshot; and
- Admin Web and the Main and Worker runtime payloads.

Obtain the checksum through the trusted publication channel independently of the bundle. Extract the
bundle to an owner-controlled program directory, but keep databases, credentials, logs, Device
Knowledge, and generated Artifacts outside it. The init Agent verifies the bundle before running it.

There is no supported download today. To evaluate the current source, follow
[Build an internal preview](../README.md#build-an-internal-preview) from a clean checkout and use the
resulting platform-specific directory. Do not publish that directory under a release tag.

## 2. Initialize the fixed Main Device

Open the extracted bundle directory as the workspace in Codex, or start Claude from that directory.
Then send this prompt:

> Read `skills/opendelegate-init/SKILL.md` and initialize this computer as my fixed OpenDelegate Main
> Device. Guide me through every owner decision, keep runtime state outside this bundle, and stop if
> a required safety check fails.

Before invoking the launcher for the first time, tell the Agent whether Discord is part of this
installation. If it is, the Agent must finish the Discord guide, obtain the complete non-secret
binding through the documented safe boundaries, and include it in the first initialization.

The Agent will inspect the host, verify the bundle, and ask only for choices that affect your intent.
Unless you choose otherwise, the accepted defaults are:

- embedded SQLite;
- Agent selection set to `Auto`;
- Assisted autonomy;
- automatic package installation only from already configured official sources;
- private-network Artifact exposure; and
- no automatic network, firewall, driver, kernel, new package-source, or remote-script changes.

The Agent also enrolls the Main computer as its own co-located Worker. OpenDelegate does not treat
Main as a control-only exception.

If you want to inspect the deterministic launcher before the Agent begins:

```powershell
.\opendelegate.cmd help
```

```sh
./opendelegate help
```

The launcher is the product boundary. A development server, package-manager command, or visible
Agent window is not the OpenDelegate runtime.

## 3. Claim owner access

During first initialization, OpenDelegate starts a loopback-only claim flow on Main. Let the Agent
open the local claim page, then:

1. create the owner passphrase;
2. save all **ten one-time recovery codes** in your password manager;
3. sign out and confirm that normal sign-in works; and
4. keep at least one recovery path that does not depend on Discord.

Never paste the claim token, passphrase, recovery codes, session cookie, or database credential into
an Agent prompt, Discord, a command argument, or a log. OpenDelegate stores only the appropriate
derived or Device-local secret representation.

If an owner already exists, initialization preserves it. It never creates a second owner.

## 4. Finish setup in Admin Web

Sign in to Admin Web and open **Configuration Chat** from the lower-right corner. This conversation
configures OpenDelegate itself; it is separate from Task conversations.

Work through these items with the Configuration Agent:

1. review detected Main Device Facts and capabilities;
2. approve the proposed Device name, Roles, and Instructions;
3. select Codex, Claude, or a custom Agent Adapter and complete its interactive provider login;
4. inspect the persisted Discord binding and feature state when Discord was configured during
   initial setup;
5. define ordered routes that Workers may use to reach Main;
6. choose Artifact exposure and retention;
7. decide whether the core service starts at boot, the graphical helper starts at login, and Admin
   opens after login; and
8. review the exact diff before applying any persistent configuration change.

Codex and Claude use OpenDelegate-controlled provider homes. Authenticate those exact homes through
the provider's normal interactive flow; do not copy your global credential directory.

If Configuration Chat reports that its Agent is unavailable, use its read-only checklist and return
after the selected Agent Adapter is ready. OpenDelegate must not simulate a configuration response.

## 5. Connect Discord Forum

When Discord was selected, its App, bot, Forum, workflow tags, non-secret binding, and bot credential
were prepared before the first Main initialization. Sign in to Admin Web and confirm that the
Discord feature reports `ready / DISCORD_READY`, the correct Forum is bound, and your owner identity
is allowlisted.

The current preview cannot add or replace a Discord binding on an existing Main. Configuration Chat
may inspect the persisted binding but does not create the App, Forum, tags, or binding. For the
exact setup, token rotation, permission, and first-Task verification flow, follow
[Discord Forum setup](DISCORD_SETUP.md). The token must never enter a chat message, JSON file,
environment variable, or command argument.

Discord is a client of the durable Task service, not its database. If Discord is offline, Admin Web,
Task state, and recovery remain available on Main. After connectivity returns, reconciliation
resumes idempotently.

## 6. Add another Device

Install the matching platform bundle on the new macOS, Windows, or Linux Device and make sure that
Device can reach one of Main's configured enrollment routes.

In Main's Configuration Chat, ask to add the Device, describe what it should be used for, and review
the proposed name, bootstrap Role, and route. The deterministic grant boundary is:

```text
opendelegate device grant --device-id DEVICE_ID \
  --output ABSOLUTE_LOCAL_PATH
```

The default grant lasts five minutes and can be used once. **Never open, paste, or send the grant**
through Discord, a Task, an Agent prompt, a log, or an ordinary shared document. Transfer the
unopened file with an owner-controlled local or operating-system-secure handoff.

On the new Device, open its bundle directory in Codex or Claude and send:

> Read `skills/opendelegate-join/SKILL.md` and join this computer to my fixed OpenDelegate Main using
> the unopened grant file at `ABSOLUTE_GRANT_FILE`. Detect its capabilities, keep all Knowledge
> local, and ask before any network or privileged change.

The join Agent passes only the file path to the packaged Worker. The Worker generates its own
Device-local key, validates Main's identity, consumes the grant, and confirms the mutual-TLS
channel. If the grant expired or was consumed, delete any retained handoff copy and issue a new one;
never edit or reuse it.

Register Workspaces on that Device and approve its Roles and Instructions in Configuration Chat.
Main receives only scheduling-safe metadata. Local Workspace paths and the linked Markdown
Knowledge graph remain on the Device.

## 7. Create your first Task

Open the bound Discord Forum Channel and create a new post:

- use a short outcome-oriented title;
- put the goal, constraints, and useful input links in the first message; and
- do not include credentials or enrollment grants.

In the OpenDelegate model, **one Forum post becomes one Task**. Replies in that post continue the
same Task and its provider-native Agent session. A new post starts a clean Task context, so unrelated
work does not leak into it.

Main evaluates the Task, creates Work Orders, selects eligible Devices from durable capability,
Role, policy, route, and health state, and reports progress back to the post. When a result is better
shown visually, OpenDelegate may attach it or publish an Artifact link under the configured exposure
policy.

Use Admin Web to inspect the durable Task journal, Work Orders, Device health, approvals, audit
events, and Artifacts. Discord remains the conversational surface; Admin Web remains the operational
source of truth.

## Daily operation

- Create a new Forum post for each independent outcome.
- Continue an existing post when you want its native Agent session and context to resume.
- Use Configuration Chat for OpenDelegate configuration, not for project work.
- Review approval requests in Admin Web or the authorized Discord control before privileged or
  policy-gated actions proceed.
- Let deterministic routes exhaust their configured attempts before asking an Agent to diagnose a
  connection failure.
- Keep Main backed up according to [Backup and restore](BACKUP_AND_RESTORE.md). Device Knowledge is
  intentionally local and may be lost with that Device.

For a quick deterministic health check, use the packaged launcher:

```powershell
.\opendelegate.cmd status
.\opendelegate.cmd worker status
```

```sh
./opendelegate status
./opendelegate worker status
```

## Recovery and troubleshooting

Start with `opendelegate status` on Main and `opendelegate worker status` on the affected Device.
Keep diagnostic output redacted before sharing it.

| Symptom | What to do |
| --- | --- |
| Discord is unavailable | Continue through Admin Web. Check the Discord feature status, bot credential availability, intents, Forum permissions, and route, then let reconciliation resume. |
| A Worker is offline | Check its service, selected Main route, certificate status, and clock. OpenDelegate keeps durable dispatch state; do not create pairwise SSH trust as a shortcut. |
| A grant expired | Delete any retained transfer copy on both ends and issue a fresh single-use grant. |
| Codex or Claude is unavailable | Authenticate the exact OpenDelegate-controlled provider home and rerun its compatibility probe. Select another configured adapter if necessary. |
| Computer Use is unavailable | Check the per-Device graphical helper, unlocked desktop, and OS privacy permissions. Headless Linux remains healthy with Computer Use unavailable. |
| Owner access is lost | Use one saved recovery code locally, rotate the passphrase, and replace the remaining recovery set. Do not depend on Discord for recovery. |
| An update fails | Keep the previous active version, inspect the bounded health failure, and follow [Service lifecycle](SERVICE_LIFECYCLE.md). Do not bypass rollback. |

For security-sensitive issues, follow [Security policy](../SECURITY.md). For the exact distinction
between an internal preview, release candidate, and supported release, see
[Release evidence and support semantics](release/README.md).
