# Hermes setup Agent guide

This guide describes how Hermes acts as the Origin setup Agent for OpenDelegate's SSH-first Device
federation. It does not install or operate a separate OpenDelegate website.

## Install Hermes on Origin

Windows PowerShell:

```powershell
iex (irm https://hermes-agent.nousresearch.com/install.ps1)
```

macOS or Linux:

```sh
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
```

Then:

```sh
hermes doctor
git clone https://github.com/jugol/OpenDelegate.git
cd OpenDelegate
hermes skills trust
hermes
```

Start a fresh Hermes session after trusting the repository.

## Give Hermes the fleet setup request

Example:

> Read CONTEXT.md and set up my Hermes fleet. This computer is Origin. Use my existing SSH aliases
> `nas`, `mac-studio`, and `windows`. Verify each host identity, detect the OS, install or update
> Hermes, write a Device-local DEVICE.md, configure and start the API Server gateway, register each
> peer on Origin, and prove one request/reply. Keep all credentials and Hermes state Device-local.

Hermes loads `.agents/skills/opendelegate-init/SKILL.md` for this request.

## What Hermes may do automatically

- inspect local SSH configuration without printing private keys;
- probe approved SSH targets in BatchMode;
- detect remote OS and Hermes installation;
- run official Hermes install or update commands;
- write non-secret Device metadata;
- run `hermes gateway setup`, install, start, and status commands inside the approved scope;
- register peers on Origin;
- probe Tailscale presence and `/health`;
- send a bounded peer request and verify the response.

## What needs the owner

- accepting a first-time SSH host key after verifying it;
- entering an SSH password, MFA, sudo password, or other secret;
- approving service installation or another privilege boundary;
- selecting a route when several materially different private-network options exist;
- resolving an unexpected host-key change.

Hermes must never ask the owner to paste a password, private key, API key, or token into Agent chat.
Use the native terminal prompt or secure local input.

## Peer API configuration

Each target needs a working Device-local model and provider before it can answer peer requests.
Remote installers may skip setup without a TTY, so use an owner-controlled TTY when setup is missing:

```sh
ssh -t TARGET hermes setup
```

The owner enters provider credentials in that target terminal. Verify `hermes doctor` and one bounded
local `hermes chat -q` response before configuring the Peer API.

The target must run the Hermes `api_server` gateway platform with a strong `API_SERVER_KEY`.
`hermes gateway setup` is interactive; run it in the same owner-controlled TTY or allocate a PTY:

```sh
ssh -t TARGET hermes gateway setup
hermes gateway install --start-now --start-on-login
hermes gateway status
```

Register the non-secret route on Origin first:

```sh
hermes peer add DEVICE_NAME --url http://PRIVATE_ADDRESS:PORT
```

The public CLI has no masked key prompt or key-stdin option. In an owner-only local Origin terminal,
use a no-echo prompt and pass only a transient variable name in the recorded command:

```sh
set +x
printf 'Peer API key: ' >&2
IFS= read -r -s OPENDELEGATE_PEER_KEY
printf '\n' >&2
hermes peer add DEVICE_NAME --url http://PRIVATE_ADDRESS:PORT --key "$OPENDELEGATE_PEER_KEY"
unset OPENDELEGATE_PEER_KEY
hermes peer list
```

Never read the target `.env`, transfer the key through Agent chat or SSH output, or place a literal
key in an Agent tool argument. Hermes stores it under Origin's local home. Because the current CLI
briefly receives the expanded key in process argv, fail closed if an owner-only session or transient
argv exposure is not acceptable. The PowerShell 7 masked-input equivalent is in `GETTING_STARTED.md`.

Normal Device work then uses:

```sh
hermes peer dm DEVICE_NAME < REQUEST_FILE
```

The published command is synchronous and currently has no `--timeout` option. Use Hermes Bot
messaging when available, or split long work into a start request and later status requests.

## State boundary

Never synchronize, commit, or copy these between Devices:

- `HERMES_HOME`;
- `config.yaml` or `.env`;
- auth files and provider homes;
- sessions and state databases;
- peer keys and SSH keys;
- locks, logs, or process state.

A shared library may carry human-readable knowledge, source files, and artifacts only.

## Diagnose without confusing Device power and Agent readiness

1. Check Tailscale or network presence.
2. Check the target host through SSH.
3. Check `hermes gateway status` on the target.
4. Check `/health` from Origin.
5. Check `hermes peer list` and one `peer dm` request.

A failed step identifies one boundary. It does not prove every earlier boundary failed.
