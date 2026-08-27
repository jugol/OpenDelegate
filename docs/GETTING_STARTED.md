# Getting started

OpenDelegate uses one Origin Hermes Agent to configure and manage Hermes on other computers through
SSH. There is no separate OpenDelegate website.

## Prerequisites

On the Origin computer:

- Hermes is installed and `hermes doctor` succeeds.
- This repository is cloned and trusted with `hermes skills trust`.
- SSH access exists to each target through an IP, hostname, Tailscale address, or SSH alias.
- The owner can approve a first-time host key and complete login when BatchMode is not ready.

On each target:

- SSH is enabled.
- The target is reachable through an existing private network.
- The account used for setup may install software and configure the Hermes gateway with owner
  approval where the OS requires it.

## 1. Describe the fleet

Give the Origin Agent a small inventory. The exact names and roles are yours.

| Device | SSH target | Intended role |
| --- | --- | --- |
| storage | `nas` | downloads, storage, Docker, long-running work |
| apple-build | `mac-studio` | Xcode, signing, macOS builds |
| gpu | `windows` | CUDA, rendering, Windows applications |

Do not put passwords or private keys in this table or chat.

## 2. Verify SSH identity and reachability

The Agent first probes each approved target without changing it:

```sh
ssh -o BatchMode=yes -o ConnectTimeout=10 TARGET true
```

A first connection may require the owner to verify and accept the expected host key. A changed host
key is never accepted automatically. Authentication failure and host identity failure are different
conditions and must be reported separately.

## 3. Install or update Hermes remotely

The setup Agent detects the remote OS and uses the official installer.

Windows PowerShell:

```powershell
iex (irm https://hermes-agent.nousresearch.com/install.ps1)
```

macOS or Linux:

```sh
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
```

After installation:

```sh
hermes doctor
```

For an existing installation, use the installation method reported by `hermes doctor` and
`hermes update`. Do not replace a working Device-local Hermes home or copy another Device's home.

## 4. Create Device-local metadata

Each target receives its own `$HERMES_HOME/DEVICE.md`. Start from `templates/DEVICE.md` and record:

- stable Device ID;
- role and useful capabilities;
- local Hermes home and shared-library path, if any;
- Peer API route and fallback route;
- whether Computer Use is available;
- local boundaries and state that must never leave the Device.

Do not commit the rendered Device file when it contains real hosts, addresses, usernames, or paths.

## 5. Configure the target Peer API

On the target, use the official interactive gateway setup:

```sh
hermes gateway setup
```

Enable the API Server platform, choose the private listener and port, and create a strong
`API_SERVER_KEY`. Store the key in the target's Device-local Hermes secret store or `.env`; never put
it in this repository or an Agent prompt.

Install and start the gateway with the native Hermes lifecycle when appropriate:

```sh
hermes gateway install --start-now --start-on-login
hermes gateway status
```

On a headless Linux system that must start at boot, the owner may approve a system service:

```sh
hermes gateway install --system --start-now
```

The setup Agent must inspect `hermes gateway install --help` on the target before selecting a service
shape.

## 6. Register the peer on Origin

From Origin, register the target's private API route and key:

```sh
hermes peer add DEVICE_NAME --url http://PRIVATE_ADDRESS:PORT --key <API_SERVER_KEY>
hermes peer list
```

The key is entered through an owner-controlled local terminal or secure input. It is stored locally
under Origin's Hermes home, not in OpenDelegate.

Prefer a stable Tailscale IP or another private route that remains valid when Origin moves between
networks. Keep a LAN or VPN route only as a tested fallback.

## 7. Verify network and Agent readiness separately

Network presence:

```sh
tailscale status
```

Hermes Peer API readiness:

```sh
curl -fsS --max-time 10 http://PRIVATE_ADDRESS:PORT/health
```

A Device may be powered on and Tailscale-online while its Hermes gateway is stopped. Do not call a
Device offline solely because `/health` fails.

## 8. Verify one real request and reply

Write the request to a file so shell characters are not interpreted, then send it:

```sh
hermes peer dm --timeout 7200 DEVICE_NAME < REQUEST_FILE
```

The response must come from the target Agent and include an observable result. Long work runs in the
background with completion notification rather than holding one foreground terminal open.

## 9. Add or repair one Device later

Use the join skill:

```text
Add the SSH target `render-box` as a Windows GPU Device. Preserve any existing Device-local Hermes
state, update only what is needed, register its peer route, and verify a request/reply.
```

The Agent distinguishes these cases:

- new Device with no Hermes installation;
- Hermes installed but gateway not configured;
- peer registered with a stale route;
- Device online but Peer API stopped;
- unexpected SSH host-key change;
- credential or owner action required.

## Operating rules

- Use SSH for setup, update, recovery, and operator diagnostics.
- Use `hermes peer dm` or Hermes bot relay for normal Agent work.
- Keep every Hermes home and secret store Device-local.
- Share only human-readable docs, project files, and artifacts.
- Report Device power/network presence and Hermes Agent readiness separately.
- Keep the Origin responsible for the original owner request and final response.
