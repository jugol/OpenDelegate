# Getting started

OpenDelegate is installed with an Agent, then operated through Admin Web and Discord. You do not
start it with `npm run start`, copy credentials into a prompt, or configure every pair of Devices
with SSH.

This guide takes one owner from an empty Main computer to a first isolated Task and an additional
Worker Device.

> [!IMPORTANT]
> Read `release-metadata.json` before setup. When `supportStatus` begins with `internal-preview`,
> every preview-specific note in this guide applies and the bundle is unsupported. A
> `release-candidate` uses the verified candidate paths described below but remains unsupported until
> the external promotion and supported-channel chain makes those exact bytes effectively released.

## Before you start

Prepare:

- one computer that will remain the fixed **Main Device**;
- Codex, Claude, or another capable local Agent on Main;
- a private route from each future Worker to Main, such as LAN, Omada, Tailscale, or an
  owner-configured tunnel;
- if you want Discord, a Community server where you can create an App, bot, and Forum Channel; and
- a password manager or another safe place for the owner passphrase and recovery codes, plus the bot
  token when Discord is enabled.

Discord is optional during deterministic `init`. You may initialize without it and add a binding
later, or initialize with a prepared non-secret binding. In either case, create the external App,
bot, Community Forum, workflow tags, intents, and permissions by following the
[Discord Forum setup](DISCORD_SETUP.md). After owner claim, Configuration Chat can add, replace,
extend, or disable the live binding without deleting Main's durable Tasks or native Agent sessions.

For a release candidate or the same bytes after supported promotion, the authenticated
Configuration Chat path is a required release feature. If it is absent or cannot activate and
validate a selected binding, treat the candidate as invalid. Declining Discord remains valid and
leaves Admin Web as the Task entry point.

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

The current source checkout has no supported download. From a clean checkout, use **Build an
internal preview** in the [repository README](../README.md). If this guide is already inside an
assembled bundle, return to that README and continue the Quick Start for the exact `supportStatus`
instead of building again. Do not publish an internal-preview directory under a release tag.

## 2. Initialize the fixed Main Device

Open the extracted bundle directory as the workspace in Codex, or start Claude from that directory.
Then send this prompt:

> Read `skills/opendelegate-init/SKILL.md` and initialize this computer as my fixed OpenDelegate Main
> Device. Guide me through every owner decision, keep runtime state outside this bundle, and stop if
> a required safety check fails.

Before invoking the launcher for the first time, tell the Agent whether you want to configure
Discord now, defer it until after owner claim, or keep it disabled. A prepared non-secret binding
may still be included in the first initialization, but it is no longer required. A deferred or
declined choice initializes Main explicitly Discord-disabled and never blocks Admin Web.

The Agent will inspect the host, verify the bundle, and ask only for choices that affect your intent.
Unless you choose otherwise, the accepted defaults are:

- embedded SQLite;
- Agent selection set to `Auto`;
- Assisted autonomy;
- automatic package installation only from already configured official sources;
- private-network Artifact exposure with authentication; and
- no automatic network, firewall, driver, kernel, new package-source, or remote-script changes.

### Make the Configuration Agent ready

Before Main is initialized, the init Agent must make the initial Main Agent Adapter ready. This
avoids a bootstrap deadlock in which Configuration Chat needs the same provider login that the chat
was expected to configure.

First read `supportStatus`. A release candidate must expose a packaged provider login and probe
boundary that uses the same command resolver as Main, authenticates the controlled home through
owner-interactive stdio, persists the canonical command identity and tested version, and revalidates
them on foreground and service startup. If that boundary is absent, the candidate is invalid and
must not be promoted or represented as supported.

The current internal preview does not expose that deterministic boundary. Its init Agent may use the
following foreground-only validation path, but this does not prove a pinned executable identity or
service readiness:

1. resolve the exact `MAIN_HOME` and create only the selected provider's owner-restricted home;
2. resolve one installed provider command from the same owner environment that will launch the
   foreground Main, then verify the exact version against the
   [support matrix](release/SUPPORT_MATRIX.md);
3. authenticate and inspect only the controlled home:

   - Codex: `MAIN_HOME/state/providers/codex`, supplied as `CODEX_HOME`; run `codex login` in the
     owner's interactive session, then require `codex login status` to pass.
   - Claude: `MAIN_HOME/state/providers/claude`, supplied as `CLAUDE_CONFIG_DIR`; run
     `claude auth login` in the owner's interactive session, then require
     `claude auth status --json` to report ready. Native Windows does not select Claude until its
     fail-closed sandbox is available; use Codex or an explicitly configured WSL2/container path.

The Agent must not copy or inherit the global provider home, accept a login token through a prompt,
or place credentials in argv, an environment value other than the non-secret home selector, a log,
or the bundle. It initializes Main with the selected `--agent codex` or `--agent claude` only after
the preview version and authentication checks pass, keeps Main in that exact foreground owner
environment, and continues to the local claim flow. `Auto` means choosing a provider that passes
this preview boundary, not accepting the first installed but unauthenticated CLI. It never upgrades
the preview into a persistent or supported installation.

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

From the authenticated owner session, read `GET /api/v1/runtime/features` and require
`configurationAgent.status` is `ready` before opening Configuration Chat. This authenticated check
happens after claim because the runtime feature endpoint does not accept an unclaimed or anonymous
request. If provider identity, tested version, authentication, capabilities, or the feature probe
fails, return to the init Agent and leave an exact resumable provider-readiness checklist; do not
simulate a Configuration Agent. For an internal preview, `ready` applies only to that exact
foreground process and does not establish service or release readiness.

Sign in to Admin Web and open **Configuration Chat** from the lower-right corner. This conversation
configures OpenDelegate itself; it is separate from Task conversations.

Work through these items with the Configuration Agent:

1. review detected Main Device Facts and capabilities;
2. approve the proposed Device name, Roles, and Instructions;
3. confirm the bootstrapped Main Agent Adapter is ready, then configure any additional Worker or
   custom Agent Adapters;
4. inspect the current `discord.binding`: if first init already seeded the intended binding, do not
   upload the token again or submit a no-op proposal—confirm its IDs and require
   `ready / DISCORD_READY`; for deferred, new, or changed Discord setup, use the secure credential
   panel and complete the approved proposal; otherwise confirm that the binding remains disabled;
5. define ordered routes that Workers may use to reach Main;
6. choose Artifact exposure and retention;
7. when a supported bundle exposes verified service commands, decide whether the core service
   starts at boot, the graphical helper starts at login, and Admin opens after login. Internal
   previews remain foreground-only and do not authorize persistent service registration; and
8. review the exact diff before applying any persistent configuration change.

The initial Main provider login already happened through the init Agent in section 2. Additional
Codex and Claude adapters use their own OpenDelegate-controlled provider homes and the same normal
owner-interactive login rule; never copy a global credential directory.

If Configuration Chat nevertheless reports that its Agent is unavailable, use its read-only
checklist and return to the init Agent's provider-readiness flow. Do not attempt the missing login
inside the unavailable chat, and do not simulate a configuration response.

## 5. Connect Discord Forum

If you do not want Discord, skip this section and create Tasks through
**Admin Web → Tasks → New task**. You can return later without reinitializing Main.

### Internal preview

Internal previews remain unsupported, but their Configuration Chat uses the same deterministic
binding lifecycle as the candidate: secure token intake, typed proposal, owner Approval, serialized
Gateway replacement, and failure rollback. Follow the [Discord Forum setup](DISCORD_SETUP.md) for
the external Discord work and the exact IDs. The chat does not create the Discord App, Forum, tags,
intents, or permissions for you.

### Release candidate or promoted supported release

First inspect the effective `discord.binding`. If first init already seeded the intended binding and
provisioned its token, confirm the Application, bot, guild, Forum, six workflow-tag, owner-user, and
optional Role IDs, then wait for `ready / DISCORD_READY`; do not upload a duplicate token or submit a
no-op proposal. For a deferred, new, or changed binding, open **Configuration Chat**, select
**Discord bot token** in its secure credential panel, store the token, and let the Agent use only the
returned opaque alias. Review the complete diff, approve the protected change in **Approvals**, and
wait for `ready / DISCORD_READY`.

Adding a Forum preserves the existing `forumBindings` entries and appends a distinct Channel.
Replacing a bot, guild, or Forum submits the complete replacement object. Disabling sets
`discord.binding` to `null`. These operations preserve durable Tasks, event history, and native
Agent sessions, but OpenDelegate never silently migrates an old Discord thread identity into a new
Forum; start new Forum posts for new Tasks as needed.

The token must never enter a chat message, JSON file, environment variable, command argument, or
log. The runtime checks that the credential alias exists before stopping the current Gateway. It
then starts the candidate binding under a single serialized lifecycle; activation or Configuration
commit failure restores the previous binding. A release candidate that cannot complete this path is
invalid and must not be promoted.

Discord is a client of the durable Task service, not its database. If Discord is offline, Admin Web,
Task state, and recovery remain available on Main. After connectivity returns, reconciliation
resumes idempotently.

## 6. Add another Device

Install the matching platform bundle on the new macOS, Windows, or Linux Device and make sure that
Device can reach one of Main's configured enrollment routes.

In Main's Configuration Chat, ask to add the Device, describe what it should be used for, and review
the proposed name, bootstrap Role, and route. On Windows, the deterministic grant boundary is:

```powershell
.\opendelegate.cmd device grant --device-id DEVICE_ID --output ABSOLUTE_LOCAL_PATH
```

On macOS and Linux:

```sh
./opendelegate device grant --device-id DEVICE_ID \
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

Choose the intake path available to you.

### Discord Forum

When Discord is configured and available, open the bound Forum Channel and create a new post:

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
events, and Artifacts. Discord remains the conversational surface. The Main database remains the
source of truth, and Admin Web exposes that durable operational state.

### Admin Web

When Discord is disabled or unavailable, open **Admin Web → Tasks → New task**. Enter the objective,
completion criteria, constraints, and `Auto` or `Manual` execution mode, then create the Task. This
minimal intake reaches the same durable Task service and keeps the system operable without Discord;
it does not create or mirror a Forum conversation.

## Daily operation

- When Discord is available, create a new Forum post for each independent outcome.
- Continue an existing Forum post when you want its native Agent session and context to resume.
- When Discord is disabled or unavailable, create a minimal Task from **Admin Web → Tasks → New
  task**.
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
