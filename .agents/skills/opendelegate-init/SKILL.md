---
name: opendelegate-init
description: Set up and verify a multi-Device Hermes fleet over SSH.
version: 0.2.0
platforms: [linux, macos, windows]
---

# Initialize OpenDelegate

Use one Origin Hermes Agent to install, update, configure, and verify Hermes Agents on multiple
Devices through the owner's existing SSH access. Do not create an OpenDelegate Admin Web instance or
enrollment-grant flow.

## When to use

- The owner wants to set up several Hermes Device Agents.
- The owner cloned OpenDelegate and wants the Agent to handle the configuration.
- Existing Devices need routes, roles, gateways, or peer registration repaired.

Use `../opendelegate-join/SKILL.md` when adding or repairing only one Device.

## Prerequisites

- Read `CONTEXT.md` and `README.md` first.
- Origin Hermes passes `hermes doctor`.
- Target Devices are reachable through approved SSH targets or aliases.
- The owner can complete unavoidable login, MFA, sudo, or first-host-key confirmation.

## Procedure

### 1. Establish the fleet inventory

Collect or discover, without reading private keys:

- Device name;
- SSH target or alias;
- intended role;
- preferred encrypted Peer API transport and fallback;
- whether the Device should run at login or boot.

Do not include passwords, private keys, API keys, or real credentials in the inventory.

### 2. Inspect Origin

Verify:

```sh
hermes doctor
hermes peer list
```

Resolve the real Origin `HERMES_HOME`. Never place Origin or target Hermes state inside the
OpenDelegate checkout.

### 3. Probe SSH safely

For each approved target:

```sh
ssh -o BatchMode=yes -o ConnectTimeout=10 TARGET "echo OpenDelegate-SSH-ready"
```

A successful probe prints exactly `OpenDelegate-SSH-ready`. Use this cross-shell marker instead of
the POSIX-only `true` command so Windows OpenSSH targets work with their configured default shell.

A first-time host key requires owner verification. An unexpected change is a hard failure. Never
weaken `StrictHostKeyChecking` to hide an identity problem.

### 4. Detect and prepare the target

Through SSH, detect the remote OS, architecture, current Hermes version, `HERMES_HOME`, and gateway
status. Install Hermes only through the official platform installer when missing. For an existing
installation, use `hermes doctor` and its detected update path.

Remote installers may skip provider and model setup when SSH has no TTY. If the target is not
already configured, allocate a PTY and let the owner complete Device-local setup:

```sh
ssh -t TARGET hermes setup
```

Never relay provider credentials through Agent chat. Before continuing, verify `hermes doctor` and a
bounded target-local response:

```sh
hermes chat -q "Reply with exactly: OpenDelegate-Agent-ready"
```

Do not copy Origin's Hermes home, config, auth, memory, sessions, provider home, or peer keys.

### 5. Write Device-local metadata

Create `$HERMES_HOME/DEVICE.md` from `templates/DEVICE.md`. Set the real Device ID, role, routes,
local paths, boundaries, and non-secret Origin peer note on the target only. Do not commit the
rendered file. Do not assume Hermes core automatically loads `DEVICE.md`; Origin routes by the
persisted peer note and explicit owner target names.

### 6. Configure the target gateway

`hermes gateway setup` is interactive. Run it in an owner-controlled target terminal or allocate an
SSH PTY; never invoke it through non-interactive SSH with stdin at EOF:

```sh
ssh -t TARGET hermes gateway setup
hermes gateway install --start-now --start-on-login
hermes gateway status
```

Enable the API Server platform only on an encrypted transport. Plain HTTP is acceptable inside
Tailscale, another authenticated encrypted VPN, or an SSH tunnel bound to Origin loopback; otherwise
use validated HTTPS. The strong `API_SERVER_KEY` stays in the target's local secret store. Do not
ask for it in chat or send it over direct plain-HTTP LAN.

Use `--system` only on an owner-approved headless Linux service that must start at boot.

### 7. Register the peer on Origin

Register the encrypted route and non-secret semantic-routing note first. This example uses HTTP only
inside Tailscale's encrypted transport:

```sh
hermes peer add DEVICE_NAME --url http://TAILSCALE_ADDRESS:PORT --note "role=ROLE; capabilities=CAPABILITIES; boundaries=BOUNDARIES"
```

The public CLI has no masked key prompt or key-stdin option. Pause for the unavoidable owner-only
step in a local Origin terminal. Never read the target `.env`, copy the key over SSH, ask for it in
chat, or place a literal key in a terminal tool argument. For Bash or Zsh, the recorded command may
contain the variable name only:

```sh
set +x
OPENDELEGATE_PEER_NOTE='role=ROLE; capabilities=CAPABILITIES; boundaries=BOUNDARIES'
printf 'Peer API key: ' >&2
IFS= read -r -s OPENDELEGATE_PEER_KEY
printf '\n' >&2
hermes peer add DEVICE_NAME --url http://TAILSCALE_ADDRESS:PORT --note "$OPENDELEGATE_PEER_NOTE" --key "$OPENDELEGATE_PEER_KEY"
unset OPENDELEGATE_PEER_KEY OPENDELEGATE_PEER_NOTE
hermes peer list
```

For PowerShell 7, use `Read-Host -MaskInput` and clear the transient variable as documented in
`docs/GETTING_STARTED.md`. The current CLI briefly receives the expanded value in process argv. If
the Origin cannot provide masked no-echo local input or its policy forbids transient argv exposure,
stop with a peer-key registration blocker. Do not improvise a weaker transfer path.

The key-setting call must repeat the same `--note` because `peer add` replaces the stored entry.
Verify that `hermes peer list` shows `key set` and the intended role note. Prefer a stable Tailscale
address; otherwise require another encrypted transport. Keep route descriptions non-secret.

### 8. Verify each boundary

Verify separately:

1. Tailscale or network presence;
2. SSH reachability and host identity;
3. remote `hermes gateway status`;
4. Origin-to-target `/health` returning `status: ok`;
5. Origin peer roster showing `key set` and the intended role note;
6. one real `hermes peer dm` request and reply.

Do not report a Device as powered off from `/health` alone.

The published `hermes peer dm` command is synchronous and has no `--timeout` option. For longer
work, use Bot messaging when available, or have the Device start background work, return a durable
local handle, and answer later status requests.

### 9. Hand off the fleet

Return a concise table with:

- Device and role;
- SSH status;
- network presence;
- Hermes version;
- gateway state;
- Peer API state;
- verified request/reply result;
- exact unresolved owner action.

## Pitfalls

- SSH success does not prove the Hermes gateway is running.
- Tailscale `Online: true` does not prove `/health` is ready.
- `/health` failure does not prove the Device is powered off.
- A successful install does not prove service persistence; check the native gateway lifecycle.
- Never create an all-to-all SSH mesh merely because several Devices exist.

## Verification

Initialization is complete only when every requested Device either returns a real peer reply or has
one exact, honest blocker assigned to the correct boundary.
