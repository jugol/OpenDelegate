---
name: opendelegate-join
description: Add or repair one Hermes Device through SSH.
version: 0.2.0
platforms: [linux, macos, windows]
---

# Join one Device

Add or repair one Device in an existing OpenDelegate Hermes fleet. Origin uses SSH for bootstrap and
recovery, then registers the target as a Hermes peer for normal Agent work. Do not use Admin Web or
an enrollment grant.

## When to use

- Add one new computer.
- Repair a target whose gateway is stopped or misconfigured.
- Update a stale peer route.
- Recover Hermes without replacing Device-local state.

## Inputs

- Origin Hermes home and peer roster;
- target SSH hostname, address, or alias;
- intended Device name and role;
- approved encrypted Peer API route;
- owner decision for login-start or boot-start service.

Never request a password, private key, peer key, or provider token in chat.

## Procedure

### 1. Read current context

Read `CONTEXT.md` and the current `hermes peer list` roster, including each non-secret role note.
Read target-local `DEVICE.md` only on that target. Preserve existing Device names, roles, and routes
unless the owner asked to change them. Do not assume Hermes core automatically loads `DEVICE.md`.

### 2. Prove target identity

Probe:

```sh
ssh -o BatchMode=yes -o ConnectTimeout=10 TARGET "echo OpenDelegate-SSH-ready"
```

A successful probe prints exactly `OpenDelegate-SSH-ready`. The marker command must remain portable
across POSIX shells, PowerShell, and `cmd.exe`.

A first connection may pause for owner verification. An unexpected host-key change fails closed.

### 3. Inspect without mutation

Detect the remote OS, Hermes version, `HERMES_HOME`, `DEVICE.md`, gateway status, and existing API
Server settings. Distinguish:

- no Hermes installation;
- Hermes installed but gateway absent;
- gateway installed but stopped;
- Peer API healthy but Origin route stale;
- Device online but API port unavailable;
- SSH authentication unavailable.

### 4. Apply the smallest repair

- Install Hermes through the official installer only when missing.
- Update through the installation method reported by `hermes doctor`.
- Preserve Device-local config, auth, memory, sessions, databases, provider homes, and keys.
- Create or patch Device-local `DEVICE.md` from `templates/DEVICE.md`.
- If provider/model setup is missing, allocate a PTY with `ssh -t TARGET hermes setup` and let the
  owner enter credentials in the target terminal.
- Verify a bounded target-local `hermes chat -q` response before peer registration.
- Configure the API Server with `ssh -t TARGET hermes gateway setup` when absent. Do not run the
  interactive wizard with stdin at EOF.
- Use the native gateway install/start lifecycle when service state is the problem.
- Expose the Peer API only through encrypted transport. Plain HTTP is acceptable inside Tailscale,
  another authenticated encrypted VPN, or an SSH tunnel bound to Origin loopback; otherwise use
  validated HTTPS. Never send a key or Agent request over direct plain-HTTP LAN.
- Update Origin `hermes peer add` only when name, encrypted route, note, or key state requires it.
  Register non-secret route metadata with `--note` and without `--key` first. If key state requires
  repair, use the init skill's owner-only masked/no-echo `OPENDELEGATE_PEER_KEY` and
  `OPENDELEGATE_PEER_NOTE` procedure. Repeat the same `--note` during key entry because `peer add`
  replaces the stored entry. Never read the target `.env`, carry a key through SSH or chat, or place
  a literal key in an Agent tool argument. Fail closed when secure local input or transient
  process-argv exposure is not acceptable.

### 5. Verify

Check:

```sh
hermes gateway status
hermes peer list
```

Probe target `/health`, then send one real peer request. The request should perform a harmless
Device-local observation and return the result. Do not invent a `--timeout` flag; the published
`hermes peer dm` command is synchronous. Use Bot messaging or a start/status request pair for longer
work.

### 6. Report

Report Device power/network presence, SSH, gateway, Peer API, and Agent reply as separate states.
Name the exact unresolved owner action if any.

## Pitfalls

- Do not replace a healthy Device's Hermes home to make setup easier.
- Do not silently accept a new SSH host key.
- Do not infer power state from API state.
- Do not copy credentials through the OpenDelegate checkout or shared storage.
- Do not leave a long peer turn attached to a foreground terminal.

## Verification

Join is complete when Origin can name the Device, read its intended role note and encrypted route
from `hermes peer list`, and receive one verified Hermes peer response from it.
