# Device Agent: <device-id>

- Device ID: `<stable-device-id>`
- Host: `<ssh-alias-or-private-host>`
- Tailscale address: `<100.x.y.z or none>`
- Peer transport: `<tailscale|encrypted-vpn|ssh-tunnel|https>`
- Encrypted fallback: `<authenticated VPN, HTTPS, SSH tunnel, or none>`
- Peer API: `<http://tailscale-address:port or https://private-name:port>`
- Role: `<short semantic role>`
- Origin peer note: `role=<role>; capabilities=<short list>; boundaries=<short list>`
- Hermes home: `<Device-local HERMES_HOME>`
- Shared library: `<human-readable shared path or none>`
- Computer Use: `<ready|unavailable|not-configured>`

## Availability

Probe `/health` before peer work. A failed Peer API probe means only that the Hermes Agent is not
ready from Origin; it does not prove that the Device is powered off. Check network presence and SSH
separately.

## Local boundaries

This Device owns its Hermes configuration, credentials, auth, sessions, databases, memories,
provider homes, peer keys, processes, and locks. Do not synchronize or commit its Hermes home.
Shared storage may contain human-readable knowledge, project files, and artifacts only.

`DEVICE.md` is local operator and peer-Agent context; Hermes core does not automatically load this
filename. Origin persists the non-secret role summary with `hermes peer add --note` and reads it
back with `hermes peer list`. Never put a credential in that note.

Plain HTTP is acceptable only inside Tailscale, another authenticated encrypted VPN, or an SSH
tunnel bound to Origin loopback. Otherwise use validated HTTPS. Do not use direct plain-HTTP LAN for
peer keys or Agent traffic.
