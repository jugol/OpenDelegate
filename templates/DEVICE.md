# Device Agent: <device-id>

- Device ID: `<stable-device-id>`
- Host: `<ssh-alias-or-private-host>`
- Tailscale address: `<100.x.y.z or none>`
- LAN/VPN fallback: `<private address or none>`
- Peer API: `http://<private-address>:<port>`
- Role: `<short semantic role>`
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
