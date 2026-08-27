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
- approved private route;
- owner decision for login-start or boot-start service.

Never request a password, private key, peer key, or provider token in chat.

## Procedure

### 1. Read current context

Read `CONTEXT.md`, Origin `DEVICE.md`, and the current peer roster. Preserve existing Device names,
roles, and routes unless the owner asked to change them.

### 2. Prove target identity

Probe:

```sh
ssh -o BatchMode=yes -o ConnectTimeout=10 TARGET true
```

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
- Configure the API Server with `hermes gateway setup` when absent.
- Use the native gateway install/start lifecycle when service state is the problem.
- Update Origin `hermes peer add` only when name, route, note, or key state requires it.

### 5. Verify

Check:

```sh
hermes gateway status
hermes peer list
```

Probe target `/health`, then send one real peer request with a two-hour deadline. The request should
perform a harmless Device-local observation and return the result.

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

Join is complete when Origin can name the Device, show its intended role and private route, and
receive one verified Hermes peer response from it.
