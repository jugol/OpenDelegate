# Platform Capabilities and Constraints

Research snapshot: 2026-07-25

Scope: official, first-party documentation only

This report verifies the external platform behavior that OpenDelegate's planning specification relies on. Product implications are called out separately from vendor claims. Because Codex, Claude Code, and Discord evolve quickly, the implementation should pin tested versions and keep adapter conformance tests rather than assuming these details remain unchanged.

## 1. Discord as the task interface

### Forum posts and task identity

- At the API level, a `GUILD_FORUM` channel (type `15`) is a channel that can contain only threads; a post in that forum is represented as a `PUBLIC_THREAD` (type `11`) plus its initial message. The thread and starter message share a snowflake ID, and creating a post can produce both thread and message events, so ingestion must be idempotent and must not depend on event ordering. This makes the thread ID a sound external identity for an OpenDelegate task, but not a replacement for an internal task ID. [Discord Threads](https://docs.discord.com/developers/topics/threads) [Discord Channel resource](https://docs.discord.com/developers/resources/channel)
- Forum channels are currently limited to Community-enabled servers. OpenDelegate onboarding therefore has to detect this prerequisite and guide the owner through enabling Community before it can provision or select a Forum channel. [Discord Forum Channels FAQ](https://support.discord.com/hc/en-us/articles/6208479917079-Forum-Channels-FAQ)
- A forum can expose at most 20 available tags, and a forum thread can have at most five applied tags. Tags may also be moderated so that only members with `MANAGE_THREADS` can change them. A workflow state should consequently use one status tag at a time, leaving the remaining slots for priority, device, or category, and the database must remain authoritative. [Discord Channel resource](https://docs.discord.com/developers/resources/channel)

### Bot installation and event ingestion

- A bot is backed by an application created in the Developer Portal. A guild-installed bot is authorized with the `bot` scope and the granular server permissions it needs; the token is a secret and must not be committed or displayed. [Discord bot quickstart](https://docs.discord.com/developers/quick-start/getting-started)
- Real-time server events arrive over Discord's Gateway WebSocket. `GUILD_MESSAGES` is required for `MESSAGE_CREATE` and related guild message events, while the privileged `MESSAGE_CONTENT` intent controls whether user-authored `content`, embeds, attachments, components, and polls are populated. The intent must be enabled in the Developer Portal, and verified apps also need approval for it. [Discord Gateway and intents](https://docs.discord.com/developers/events/gateway)
- A normal user-authored Forum conversation cannot be consumed through the Interactions HTTP endpoint alone. The Main needs a persistent Gateway connection with heartbeats, reconnect, and Gateway Resume handling. `GUILDS`, `GUILD_MESSAGES`, and `MESSAGE_CONTENT` are sufficient for the core task flow; `GUILD_MEMBERS` is not required merely to compare `message.author.id` with the configured owner. [Discord Gateway](https://docs.discord.com/developers/events/gateway)
- Thread events and messages inside threads require API v9 or newer; current integrations should target the current API version and handle `THREAD_CREATE`, `THREAD_UPDATE`, `THREAD_DELETE`, and `MESSAGE_CREATE`. [Discord Threads](https://docs.discord.com/developers/topics/threads)
- The bot needs `VIEW_CHANNEL`, `READ_MESSAGE_HISTORY`, `SEND_MESSAGES`, and `SEND_MESSAGES_IN_THREADS` for normal operation, plus `ATTACH_FILES` for rich results. `MANAGE_THREADS` is needed if OpenDelegate must reliably change tags, archive, lock, or reopen owner-created posts; `MANAGE_CHANNELS` is needed only when onboarding creates or configures the Forum itself. [Discord Permissions](https://docs.discord.com/developers/topics/permissions) [Discord Threads](https://docs.discord.com/developers/topics/threads)
- Discord's HTTP API is appropriate for creating/updating posts and messages, while the Gateway is the event stream. OpenDelegate should consume both: Gateway events for low-latency operation and periodic HTTP reconciliation after disconnects. [Discord Gateway](https://docs.discord.com/developers/events/gateway)

### Archive and lock behavior

- A thread can auto-archive after 60, 1,440, 4,320, or 10,080 minutes of inactivity. Archiving removes it from the active channel list rather than deleting its messages. [Discord Channel resource](https://docs.discord.com/developers/resources/channel)
- Archived threads are generally immutable, but sending a message automatically unarchives an unlocked thread. A locked thread can be unarchived only by a principal with `MANAGE_THREADS`; Discord's user documentation likewise says an unlocked forum post can be reopened. [Discord Channel resource](https://docs.discord.com/developers/resources/channel) [Discord Forum Channels FAQ](https://support.discord.com/hc/en-us/articles/6208479917079-Forum-Channels-FAQ)
- Discord initially syncs only active, visible threads through the Gateway. Archived-thread list endpoints exist, so restart recovery cannot rely only on the initial Gateway state. [Discord Threads](https://docs.discord.com/developers/topics/threads) [Discord Channel resource](https://docs.discord.com/developers/resources/channel)

### Rich result and approval UI

- Components v2 can build structured messages from layout components, Markdown text, buttons, selects, thumbnails, media galleries, files, separators, and containers. They require the per-message `IS_COMPONENTS_V2` flag; on such a message, legacy `content` and `embeds` no longer work, attachments are not displayed unless surfaced through components, and the message can contain up to 40 components. [Discord Component reference](https://docs.discord.com/developers/components/reference)
- A Media Gallery can show one to ten media items. A File component can expose an uploaded attachment. These are suitable for screenshots, compact visual reports, logs, PDFs, and downloadable outputs without leaving Discord. [Discord Component reference](https://docs.discord.com/developers/components/reference)
- A normal button sends an interaction to the app; a link-style button navigates to a URL and does not send an interaction. OpenDelegate can therefore use normal buttons for approve, deny, retry, cancel, and change-device actions, and link buttons for `Open report`. [Discord Component reference](https://docs.discord.com/developers/components/reference)
- Modals are focused forms that an app may open only as a response to an interaction such as a button, command, or select action. They cannot be pushed spontaneously. An interaction must be acknowledged or deferred within three seconds, and its token remains usable for follow-ups for 15 minutes. Modal file-upload components can accept up to ten files, bounded by the user's upload limit in that channel. [Discord Components and Modals](https://docs.discord.com/developers/platform/components) [Discord Interactions](https://docs.discord.com/developers/interactions/receiving-and-responding) [Discord Component reference](https://docs.discord.com/developers/components/reference)
- The Forum-post creation endpoint does not currently permit `IS_COMPONENTS_V2` on its starter-message flags. Bot-created incident posts should use a normal starter message, then post a bot-owned Components v2 status/result panel. [Discord Channel resource](https://docs.discord.com/developers/resources/channel)
- Discord attachment CDN URLs are signed and expire, although fetching the parent message refreshes them. Persist Discord message/attachment IDs or OpenDelegate artifact IDs rather than raw signed URLs. [Discord API reference](https://docs.discord.com/developers/reference)

## 2. Codex integration surfaces

### Headless execution and SDKs

- `codex exec` is the supported non-interactive mode for scripts and CI. It streams human-oriented progress to `stderr`, emits the final response on `stdout`, and can instead emit a JSONL event stream with `--json`; event types include thread, turn, item, and error events. [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive/)
- A non-interactive session can be resumed with `codex exec resume <SESSION_ID>` or selected by `--last`. `--ephemeral` explicitly disables persisted rollout files, so OpenDelegate must not use it for resumable task sessions. [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive/)
- `codex exec` defaults to a read-only sandbox, supports explicit `workspace-write` and `danger-full-access` modes, and normally requires a Git repository unless `--skip-git-repo-check` is supplied. [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive/)
- The TypeScript SDK can start a thread, continue it with another `run()`, or resume a recorded thread ID; it is documented for server-side Node.js 18 or later. The Python SDK controls a local `codex app-server` over JSON-RPC, ships with a pinned Codex CLI runtime, requires Python 3.10 or later, and is currently beta. [Codex SDK](https://developers.openai.com/codex/sdk/)

### App Server lifecycle, events, and approvals

- App Server is the deep-integration surface used for rich clients. It supports authentication, history, approvals, and streamed agent events over a bidirectional JSON-RPC-like protocol. The default `stdio` transport is JSONL; the WebSocket transport is explicitly experimental and unsupported. [Codex App Server](https://developers.openai.com/codex/app-server/)
- Its stable lifecycle maps well to an adapter: `thread/start`, `thread/resume`, or `thread/fork`; then `turn/start`; then notifications such as `item/started`, `item/completed`, message deltas, tool progress, and `turn/completed`. `turn/interrupt` supports cancellation. [Codex App Server](https://developers.openai.com/codex/app-server/)
- `thread/resume` appends later turns to the recorded thread. `thread/fork` creates a distinct thread with copied history. Threads can also be read without resuming, archived, unarchived, compacted, or permanently deleted. [Codex App Server](https://developers.openai.com/codex/app-server/)
- When Codex settings require approval, App Server sends a server-initiated request carrying `threadId` and `turnId`. The client can accept once, accept for the session, decline, or cancel; command approvals can also accept a proposed execution-policy amendment. Completion still arrives as the terminal item event. [Codex App Server approvals](https://developers.openai.com/codex/app-server/#approvals)
- App Server can generate TypeScript or JSON schemas that are specific to the installed Codex version. Some methods and fields require explicit `experimentalApi` opt-in, while omitting that capability keeps the client on the stable surface. [Codex App Server](https://developers.openai.com/codex/app-server/)
- The generated `0.145.0` schema exposes separate server requests for command execution, file changes, and permission-profile elevation. OpenDelegate therefore does not need to infer protected actions from streamed prose, but it must bind every response to the exact thread, turn, item, callback identifier, current Run, and current Policy decision. The generated schema is version evidence, not a stable cross-version API guarantee.

### Stability and locality caveats

- OpenDelegate should launch App Server locally through `stdio`; it should not expose App Server's experimental WebSocket directly to the network. If a remote WebSocket is ever enabled, OpenAI requires authentication and TLS for non-local use, and warns that non-loopback listeners may otherwise be unauthenticated. [Codex App Server](https://developers.openai.com/codex/app-server/)
- Native thread state is local rollout state: the SDK is documented as controlling local Codex agents and App Server archives on-disk thread logs. A Codex session ID should therefore be stored together with its device, adapter version, working directory, and lineage, and should not be treated as portable across devices. [Codex SDK](https://developers.openai.com/codex/sdk/) [Codex App Server](https://developers.openai.com/codex/app-server/)
- OpenDelegate should pin a tested Codex version, generate the matching protocol schema in CI, and avoid experimental methods for required v1 behavior. The Python SDK's beta status and the version-specific App Server schemas make an unversioned integration unnecessarily fragile. [Codex SDK](https://developers.openai.com/codex/sdk/) [Codex App Server](https://developers.openai.com/codex/app-server/)

## 3. Claude Code and Claude Agent SDK

### Headless execution and streaming

- `claude -p` runs Claude Code non-interactively and supports the same agent loop, tools, and context management exposed by the Agent SDK. It can produce plain text, JSON containing the result and session ID, or newline-delimited `stream-json`. [Claude Code programmatic mode](https://code.claude.com/docs/en/headless)
- Python and TypeScript Agent SDKs provide native messages and programmatic control. With partial-message streaming enabled, they yield raw text and tool-call stream events in addition to complete assistant and result messages. [Claude Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) [Claude Agent SDK streaming](https://code.claude.com/docs/en/agent-sdk/streaming-output)
- The SDK exposes a `canUseTool` callback for tool approvals and clarifying questions. The callback pauses execution until OpenDelegate returns a decision; it may remain pending indefinitely, or OpenDelegate can defer the decision, let the process exit, and resume from the persisted session later. [Claude Agent SDK user input](https://code.claude.com/docs/en/agent-sdk/user-input)
- Permission modes, hooks, declarative deny/ask/allow rules, and the approval callback are separate layers. A `PreToolUse` hook is the documented way to gate every tool call regardless of ordinary permission rules. [Claude Agent SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions)
- The TypeScript Agent SDK package is `@anthropic-ai/claude-agent-sdk`. Its `canUseTool` callback includes an abort signal, tool-use ID, proposed input, and optional permission suggestions; programmatic options can disable user/project/local settings, restrict MCP configuration, and keep session persistence enabled for exact resume. [Claude Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)
- Claude's OS-enforced Bash sandbox is documented for macOS, Linux, and WSL2, but not native Windows. A managed integration can require `failIfUnavailable: true` and disable unsandboxed fallback. OpenDelegate must not advertise native-Windows autonomous Bash through that sandbox; on native Windows it needs a separate verified sandbox or a narrower tool surface. [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing)

### Session identity, resume, and locality

- An Agent SDK session contains the prompt, tool calls, tool results, and responses, and is written to disk automatically. A result message exposes `session_id`; passing that ID as `resume` continues with the prior context, while `fork_session` produces a distinct history. [Claude Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions)
- Sessions preserve conversation history, not a snapshot of the filesystem. A resume also depends on the working directory: local transcripts are stored under the encoded absolute `cwd`, and a mismatched directory or missing file can make resume fail or start fresh. [Claude Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions)
- Session files are local to the host. Anthropic documents copying the transcript to the same path on another host or using a `SessionStore` adapter for cross-host resume, but also notes that carrying forward application state into a fresh session is often more robust. OpenDelegate's v1 design should deliberately keep native sessions device-local. [Claude Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions)
- Sessions created by `claude -p` or the Agent SDK do not appear in the interactive session picker, although they can still be resumed by exact session ID from the originating project directory or its worktrees. OpenDelegate must not promise that every managed session will be visible in Claude Code's normal picker. [Claude Code session management](https://code.claude.com/docs/en/sessions)
- Resuming the same session concurrently in two terminals interleaves messages into one transcript. OpenDelegate needs a single-writer lease per native session even when it permits many independent sessions to run in parallel. [Claude Code session management](https://code.claude.com/docs/en/sessions)

### Retention and worktree caveats

- Claude Code stores transcripts as local JSONL and removes them after 30 days by default; `cleanupPeriodDays` changes the period, while `--no-session-persistence` disables persistence. The JSONL entry format is explicitly internal and can change between releases, so OpenDelegate should use the Agent SDK's session APIs rather than parse transcript files. [Claude Code session management](https://code.claude.com/docs/en/sessions)
- `--worktree` creates an isolated Git worktree under `.claude/worktrees/`; worktrees isolate file edits, not conversation state. A resumed worktree session normally returns to that worktree, but if the directory no longer exists it resumes in the launch directory. [Claude Code worktrees](https://code.claude.com/docs/en/worktrees)
- Non-interactive `-p` worktrees are not cleaned up automatically because there is no exit prompt. OpenDelegate must own worktree lifecycle and garbage collection, while preserving worktrees that contain uncommitted, untracked, or unpushed work. [Claude Code worktrees](https://code.claude.com/docs/en/worktrees)
- A background Bash process started during `claude -p` is terminated shortly after the final result and stdin close. Long-lived previews or report servers must therefore be promoted to an OpenDelegate-owned artifact service rather than left running as an agent child process. [Claude Code programmatic mode](https://code.claude.com/docs/en/headless)

## 4. Private-network transports

### Tailscale and Headscale

- Tailscale uses direct peer-to-peer UDP connections when possible, falls back first to a configured peer relay and then to a DERP relay, and keeps all three connection types end-to-end encrypted with WireGuard. Direct and relayed paths differ mainly in performance. [Tailscale connection types](https://tailscale.com/docs/reference/connection-types)
- `tailscale status`, `tailscale ping`, and `tailscale netcheck` expose whether a path is direct or relayed and help diagnose NAT or UDP restrictions. OpenDelegate can use these as deterministic health evidence before asking an LLM to diagnose a route. [Tailscale connection types](https://tailscale.com/docs/reference/connection-types) [Tailscale device connectivity](https://tailscale.com/docs/reference/device-connectivity)
- MagicDNS assigns DNS names to tailnet devices, which is preferable to persisting volatile Tailscale IP addresses in human-authored device instructions. [Tailscale MagicDNS](https://tailscale.com/docs/features/magicdns)
- A Tailscale subnet router advertises access to a private subnet for nodes that do not run Tailscale; it uses SNAT by default and requires both device and tailnet administrative configuration. This is an optional way to bridge into an Omada- or LAN-reachable subnet, not something OpenDelegate should silently configure. [Tailscale subnet routers](https://tailscale.com/docs/features/subnet-routers)
- Tailscale Grants can restrict which identities may reach which devices, ports, and protocols. OpenDelegate's setup assistant should recommend grants scoped to its own endpoints instead of assuming tailnet membership itself is least privilege. [Tailscale Grants](https://tailscale.com/docs/features/access-control/grants)
- Headscale describes itself as a self-hosted implementation of the Tailscale control server with a deliberately narrow, single-tailnet scope aimed at personal use and small organizations. It is a plausible user-selected control-plane option, not a transport OpenDelegate needs to embed. [Headscale documentation](https://headscale.net/)
- Headscale's documented feature matrix currently lists Tailscale Serve and Funnel as unsupported. Artifact exposure must therefore use OpenDelegate's own gateway or another configured exposure adapter rather than depend on those Tailscale-specific features. [Headscale feature matrix](https://headscale.net/stable/about/features/)

### Cloudflare Tunnel

- `cloudflared` initiates outbound-only connections from the origin to Cloudflare, allowing bidirectional traffic over the established tunnel without a publicly routable origin IP or an inbound firewall opening. [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)
- Publishing an application hostname through Tunnel makes it reachable publicly unless a separate Cloudflare Access policy is attached. `cloudflare-public` and `cloudflare-access` must therefore be separate exposure-policy modes. [Cloudflare published applications](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/)
- Cloudflare documents Tunnel as an off-ramp: it does not support server-initiated protocols, and for non-HTTP protocols the original source IP is unavailable to the origin. OpenDelegate must authenticate requests at the application layer and must never equate a tunnel-visible source IP with device identity. [Cloudflare connectivity options](https://developers.cloudflare.com/cloudflare-one/networks/connectivity-options/)
- Quick Tunnels provide random development URLs but are explicitly development-only, have no SLA, cap concurrent in-flight requests, and do not support Server-Sent Events. They may be offered as a temporary preview convenience, never as the production Main or Worker transport. [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)

## 5. Cross-platform background services and Computer Use

### Windows

- The Windows Service Control Manager is the native supervisor for long-running, auto-start services; Microsoft identifies auto-start services as appropriate for daemons that must remain available from boot to shutdown. [Microsoft: About Services](https://learn.microsoft.com/en-us/windows/win32/services/about-services)
- A Windows service cannot directly interact with the logged-in user's desktop on supported Windows versions. Microsoft recommends a separate application in the interactive user's session and IPC between that application and the service. [Microsoft: Interactive Services](https://learn.microsoft.com/en-us/windows/win32/services/interactive-services)
- OpenDelegate therefore needs two Windows processes: an SCM-managed core daemon and a per-user session helper for Computer Use. The helper's availability must be reported separately from daemon health.

### macOS

- `launchd` manages both system LaunchDaemons and per-user LaunchAgents. A LaunchDaemon runs without user or WindowServer access and cannot present or control GUI applications, while a LaunchAgent runs in the logged-in user's context and can communicate with a system daemon. Apple explicitly describes the daemon-plus-agent split for software with both user-independent and user-specific work. [Apple: Designing Daemons and Services](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/DesigningDaemons.html)
- macOS requires the user to grant Accessibility permission before a third-party application may control the computer through accessibility features; screen capture and input monitoring are separate Privacy & Security permissions where applicable. [Apple: Accessibility access](https://support.apple.com/guide/mac-help/mh43185/mac) [Apple: Privacy & Security settings](https://support.apple.com/guide/mac-help/change-privacy-security-settings-on-mac-mchl211c911f/mac)
- OpenDelegate therefore needs a LaunchDaemon or otherwise supervised core plus a logged-in LaunchAgent/helper with explicit TCC onboarding for Computer Use. A healthy daemon does not imply that UI automation is currently available.

### Linux

- `systemd` is the standard system and service manager on systemd-based Linux distributions; it starts services, tracks them with cgroups, supports dependency management, and can run in system mode as PID 1 or in user mode with an instance for each user session. [systemd overview](https://systemd.io/) [systemd architecture](https://systemd.io/ARCHITECTURE/)
- OpenDelegate should install a system service for always-on worker connectivity and use a separate user-session helper when a graphical desktop is present. Headless NAS devices can truthfully expose daemon, shell, container, and storage capabilities while reporting Computer Use as unavailable.

## Implications for OpenDelegate

1. **Keep the database authoritative.** A Discord Forum thread is a task's conversational projection. Persist an internal `task_id`, the Discord thread ID, status, session lineage, assignments, approvals, and artifacts in OpenDelegate. Rebuild tags and messages from that state after Gateway reconnects or Discord-side edits.

2. **Model two runtime planes per device.** The always-on core daemon owns identity, transport, leases, agent adapters, logs, and artifact upload. A user-session helper owns Computer Use and reports `logged_in`, `desktop_unlocked`, permission readiness, and its exclusive `desktop-session` resource lock.

3. **Normalize provider adapters without discarding native sessions.** The minimum adapter contract should cover `start`, `resume`, `stream events`, `request approval/input`, `cancel`, `fork`, `compact/checkpoint`, and `final result`. Store every native session as `(provider, device_id, native_session_id, cwd/worktree, adapter_version, lineage)`. Never reuse it for another Forum task and never attempt to resume it on a different device by ID alone.

4. **Serialize access to one native session, not to the whole device.** Codex and Claude may run many independent sessions concurrently, but only one active run may append to a particular native session. Computer Use additionally holds the device-wide `desktop-session` lock.

5. **Layer OpenDelegate policy above provider approvals.** Provider approval protocols are useful transport surfaces, but OpenDelegate's deterministic policy engine remains the final authority. It should auto-resolve allowed requests, deny prohibited requests, and surface unresolved approvals as Discord buttons or Admin UI actions with task- and turn-scoped correlation IDs.

6. **Treat Discord UI as a projection with hard limits.** Use one workflow-status tag, reserve tag space for useful facets, render compact results with Components v2, and use a link button for large reports. Do not depend on a thread remaining active or on more than five simultaneous tags.

7. **Own artifacts and previews.** Copy static HTML, images, PDFs, logs, and bundles from the worker into the Main artifact store. Serve them through the configured exposure policy and route profile. Do not depend on an agent-launched development server surviving the native agent run.

8. **Resolve routes deterministically.** A device's ordered transport profiles should contain endpoint templates, health checks, timeout/retry rules, and secret references for LAN, Omada, Tailscale/Headscale, or Cloudflare Tunnel paths. Run those checks in code; give sanitized evidence to the LLM only after deterministic routes fail.

9. **Authenticate above every network.** VPN membership, source IP, and tunnel reachability are not sufficient device identity. Use per-device application credentials and encrypted channels even on private networks; workers should call Main's API rather than connect directly to the database.

10. **Pin and probe integrations.** Maintain a compatibility matrix for Codex, Claude Code, Discord API, and each OS helper. On startup, probe capabilities and record evidence. Generate/version Codex schemas, use Claude's supported session APIs rather than its internal JSONL format, and degrade explicitly when resume, approvals, streaming, or Computer Use are unavailable.

11. **Make native-session failure recoverable.** Preserve OpenDelegate checkpoints containing user-visible conversation, task specification, decisions, artifacts, and worker reports. If a provider session expires, is cleaned up, loses its worktree, or becomes unreadable, start a new native continuation session from that checkpoint and record the lineage change.

12. **Define the first milestone with platform-realistic tests.** “Mac, Windows, Linux, and Computer Use complete” should include reboot/startup recovery on all three OSes, offline/online route recovery, concurrent non-GUI runs, exclusive GUI locking, logged-out/locked-session behavior, native-session resume, approval round-trips through Discord, and artifact publication through at least one private and one externally exposed policy.
