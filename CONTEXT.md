# OpenDelegate Domain Context

Status: **Approved — SSH-first direction confirmed 2026-08-27**

This file is the current source of truth for OpenDelegate. It supersedes the earlier Admin Web
control-plane direction preserved under legacy product documents and source directories.

## Product in one paragraph

OpenDelegate is a repository and Agent procedure for setting up and managing Hermes Agents on
multiple computers. One Origin Agent uses the owner's existing SSH access to install, update,
configure, and recover Hermes on target Devices. After setup, normal Agent work travels through the
Hermes Peer API. Tailscale, LAN, or another existing private network provides reachability. Each
Device keeps its own Hermes home, credentials, sessions, memory, and process state. OpenDelegate does
not require a separate Admin Web, central database, enrollment grant, or Discord management site.

## Non-negotiable invariants

1. **Origin owns the request.** The Agent that receives the owner request remains responsible for
   routing, collecting peer results, and replying on the original surface.
2. **SSH is bootstrap and recovery.** Origin uses owner-approved SSH access for installation,
   updates, service repair, and direct diagnostics.
3. **Peer API is the normal work channel.** After setup, Agent work uses registered Hermes peers
   rather than repeated remote shell execution.
4. **No separate web control plane.** OpenDelegate does not ask the owner to run or maintain an Admin
   Web site.
5. **No enrollment grants.** A new Device is added through SSH, Device-local Hermes configuration,
   peer registration, and a verified request/reply.
6. **State stays Device-local.** Hermes homes, configs, secrets, auth, sessions, databases, locks,
   and process state are never synchronized between Devices.
7. **Host identity fails closed.** An unexpected SSH host-key change is an error and is never
   accepted automatically.
8. **Secrets never enter chat or source.** SSH credentials, peer API keys, provider credentials,
   and private keys remain in their local secure stores.
9. **Targets answer locally before peer registration.** A remote install can skip model/provider setup
   without a TTY. Complete missing setup in an owner-controlled target TTY and verify one bounded
   local Agent response before registering the Peer API.
10. **Power and Agent readiness are separate.** Tailscale/network presence and Hermes `/health`
   readiness are reported independently.
11. **Shared storage is human-readable only.** Shared libraries may contain docs, project files,
    knowledge, and artifacts, but not Hermes runtime homes or credentials.
12. **Explicit Device names win.** Semantic role routing is a convenience; an owner-named target
    always takes priority.
13. **Long work must use shipped behavior.** The public `hermes peer dm` command is synchronous and
    has no `--timeout` flag. Use Bot messaging when available, or split long work into start and
    status requests with a durable Device-local handle.

## Canonical flow

1. The owner installs Hermes on Origin and clones this repository.
2. Hermes trusts the project skills and reads this context.
3. The owner names SSH targets and desired roles, or the Agent discovers approved aliases from the
   local SSH configuration.
4. Origin probes SSH without mutation and verifies host identity.
5. Origin installs or updates Hermes on each target through the official platform path.
6. Each target completes any missing model/provider setup in an owner-controlled TTY and proves one
   local Agent response.
7. Each target receives a Device-local `DEVICE.md`, API server configuration, and native gateway
   lifecycle.
8. Origin registers the target with `hermes peer add` and stores the peer credential locally.
9. Origin distinguishes Tailscale/network presence from Peer API health.
10. Origin sends a real peer request and verifies the response.
11. Later owner work is routed through peer messages; SSH is reserved for setup and recovery.

## Legacy boundary

The `apps/`, `packages/`, release tooling, and earlier product specifications describe a previous
Admin Web control-plane prototype. They may be reviewed or reused, but they do not define current
OpenDelegate operation. Current onboarding must never instruct an owner to create an Admin Web
Instance, enrollment grant, database, or Discord Forum merely to manage Device Agents.
