# OpenDelegate

Languages: **[English](README.md)** · [한국어](README.ko.md) · [日本語](README.ja.md) ·
[Français](README.fr.md) · [Español](README.es.md) · [简体中文](README.zh-CN.md) ·
[繁體中文](README.zh-TW.md)

OpenDelegate is a repository for setting up and operating Hermes Agents across several computers.
It is not a separate web control plane. You clone the repository on one Origin computer, give it to
your local setup Agent, and let that Agent connect to the other Devices over SSH.

```text
Owner
  │
  ▼
Origin Hermes Agent
  ├── SSH ──> install, update, and recover Hermes on each Device
  ├── peer dm ──> send normal Agent work after setup
  └── shared library ──> exchange human-readable files and artifacts when needed
```

The current operating model is deliberately simple:

- SSH is the bootstrap and recovery channel.
- Hermes Peer API is the normal Agent-to-Agent work channel after setup.
- Tailscale, LAN, or an existing VPN provides reachability.
- Each Device keeps its own Hermes state, credentials, sessions, and memory.
- There is no OpenDelegate Admin Web to install or maintain.
- There is no enrollment-grant workflow.

## Quick start

### 1. Choose the Origin computer

The Origin is the computer where you talk to Hermes and ask for work. It keeps the peer roster and
decides which Device Agent should receive each request. The Origin does not become a central database
for the other Devices.

### 2. Install Hermes and clone OpenDelegate

Install Hermes by following the official
[Hermes installation guide](https://hermes-agent.nousresearch.com/docs/getting-started/installation),
then run:

```sh
hermes doctor
git clone https://github.com/jugol/OpenDelegate.git
cd OpenDelegate
hermes skills trust
hermes
```

If the repository already exists:

```sh
git pull --ff-only
```

Project skills live under `.agents/skills/` and load only after the repository is trusted and a fresh
Hermes session starts.

You do not need pnpm, Node.js, `apps/`, or `packages/` for the current SSH-first workflow. Those
directories belong to the retained legacy prototype.

### 3. Prepare SSH access

Each target Device must already be reachable from the Origin through an SSH host, IP address, or
`~/.ssh/config` alias. Use Tailscale or another private network when the Devices are not on the same
LAN.

Before setup, verify:

- SSH is enabled on the target Device.
- The Origin has an owner-approved key or login method.
- The expected SSH host key is known or confirmed on first connection.
- The target can reach the internet for the official Hermes installer when Hermes is not installed.

OpenDelegate never accepts an unexpected SSH host-key change.

### 4. Give the setup request to Hermes

Example:

> Set up my Hermes Device Agents from this OpenDelegate repository. Use this computer as Origin.
> Connect to `nas`, `mac-studio`, and `windows` through my existing SSH configuration. Detect each OS,
> install or update Hermes, create a Device-local DEVICE.md with its role, configure its Peer API and
> gateway service, register it in the Origin peer roster, and verify one real request and reply. Keep
> credentials, sessions, memories, databases, private keys, and Hermes homes local to each Device.
> Never accept a changed SSH host key, and ask me only when SSH authentication or another owner-only
> action is unavoidable.

The setup Agent follows `.agents/skills/opendelegate-init/SKILL.md` and handles the shell work. The
owner does not manually copy commands between computers.

## What the setup Agent does

For every Device, the Agent:

1. probes the configured SSH target without changing it;
2. detects the OS, architecture, current Hermes installation, and service state;
3. installs or updates Hermes through the official platform installer;
4. completes any missing Device-local model/provider setup in an owner-controlled TTY and verifies a
   local Agent response;
5. keeps `HERMES_HOME` and all runtime data outside the OpenDelegate checkout;
6. writes a Device-local `DEVICE.md` containing the Device ID, role, routes, and local boundaries;
7. configures the Hermes API server and gateway without putting API keys in chat or source files;
8. starts the gateway through the native Hermes lifecycle for that OS;
9. registers the Device on Origin with `hermes peer add`;
10. checks Tailscale or network presence separately from Hermes `/health` readiness; and
11. sends one bounded `hermes peer dm` request and verifies the reply.

A failed `/health` probe means the Hermes Peer API is not ready from Origin. It does not prove that
the computer is powered off.

## Add another Device

Tell the Origin Agent the new SSH target and intended role:

> Add `render-box` as my Windows GPU Device. Use the SSH alias already in my config, install or update
> Hermes, configure its Device role and Peer API, register it on Origin, and verify a request/reply.

The Agent follows `.agents/skills/opendelegate-join/SKILL.md`. No Admin Web or enrollment grant is
involved.

## Daily use

Ask the Origin Agent for the outcome, not the connection mechanics:

- "Have Windows render these images."
- "Ask the Mac Studio to build the macOS app."
- "Let the NAS download this dataset and keep working in the background."
- "Collect status from every Device."

The Origin checks the Device role and Peer API readiness, writes a bounded peer request, and sends it
with `hermes peer dm`. The published command is synchronous and currently has no `--timeout` option.
For longer work, use Hermes Bot messaging when available, or ask the target to start the work and
return a durable handle before checking status in a later peer message. SSH remains available for
installation, updates, service recovery, and direct operator diagnostics.

## Device roles

Roles are examples, not hard-coded product limits:

| Role | Typical work |
| --- | --- |
| Origin | owner conversation, routing, result collection |
| NAS | storage, downloads, Docker, long-running services |
| macOS | Xcode, Apple signing, Metal, macOS applications |
| Windows | CUDA/RTX, ComfyUI, Windows applications |
| Laptop | portable interaction and short local work |

The owner can name Devices and roles differently. Explicit Device names always override semantic
routing.

## State and security boundaries

- Never synchronize or commit `HERMES_HOME`.
- Never copy `config.yaml`, `.env`, auth files, state databases, sessions, peer keys, locks, or
  provider homes between Devices.
- API keys and SSH credentials remain Device-local and outside Agent prompts.
- Do not create pairwise trust between every Device. The Origin needs SSH access for setup; normal
  Agent work uses registered peer routes.
- Shared storage contains only human-readable knowledge, project files, and artifacts.
- A Device that is Tailscale-online may still have a stopped Hermes gateway. Report those states
  separately.

## Repository layout

- `.agents/skills/opendelegate-init/` — configure Origin and bootstrap multiple Devices over SSH.
- `.agents/skills/opendelegate-join/` — add or repair one Device over SSH.
- `docs/GETTING_STARTED.md` — complete SSH-first walkthrough.
- `docs/HERMES_SETUP_AGENT.md` — Hermes-specific setup notes and commands.
- `templates/DEVICE.md` — generic Device metadata template.
- `apps/`, `packages/`, and the old control-plane documents — retained legacy prototype source, not
  the current operating workflow.

## Documentation status

- [Current domain context](CONTEXT.md) — the active SSH-first product direction.
- [Legacy product specification](docs/PRODUCT_SPEC.md) — the earlier Admin Web prototype.
- [Legacy implementation plan](docs/IMPLEMENTATION_PLAN.md) — retained for historical reference.
- [Legacy decision log](docs/DECISIONS.md) — earlier control-plane decisions.
- [Platform capability research](docs/research/platform-capabilities.md) — reusable OS research.

## Legacy prototype notice

This repository still contains an earlier Main/Worker control-plane prototype with Admin Web,
Discord Forum orchestration, enrollment grants, and release tooling. That code is kept for reference
and possible reuse. It is not the current OpenDelegate setup or management path and must not be used
to tell owners to operate a separate website.

OpenDelegate's current purpose is to help an existing local Agent set up and manage a practical
multi-Device Hermes fleet through SSH and Hermes peer connections.
