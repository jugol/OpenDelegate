# OpenDelegate Agent instructions

## Required context

Before planning or performing OpenDelegate work, read:

1. `CONTEXT.md`
2. `README.md`
3. `.agents/skills/opendelegate-init/SKILL.md` for Origin or fleet setup
4. `.agents/skills/opendelegate-join/SKILL.md` for adding or repairing one Device

`CONTEXT.md` is the current source of truth. The earlier Admin Web product specification,
implementation plan, decision log, `docs/adr/`, `docs/design/`, `docs/release/`, legacy operational
guides, `apps/`, `packages/`, and release tooling are legacy prototype material unless the owner
explicitly asks to work on that prototype.

## Request routing

- "Set up my Devices", "configure OpenDelegate", or "manage this fleet" loads
  `.agents/skills/opendelegate-init/SKILL.md`.
- "Add this computer", "repair this Device", or "reconnect this host" loads
  `.agents/skills/opendelegate-join/SKILL.md`.
- Normal work after setup uses Hermes peer messaging. SSH remains the installation, update, recovery,
  and operator-diagnostic channel.
- Before routing by role, read `hermes peer list`. The persisted non-secret peer note is Origin's
  durable role and capability index. An explicitly named Device always wins over semantic routing.

## Current product boundary

- OpenDelegate is SSH-first Hermes Device federation.
- It does not require a separate Admin Web or enrollment-grant system.
- The owner provides existing SSH reachability or approves the unavoidable login step.
- The Agent handles safe commands and asks only for owner-only authentication or consequential
  authority changes.
- Every Device keeps its Hermes home, credentials, sessions, databases, memories, locks, and process
  state locally.
- Never accept an unexpected SSH host-key change.
- Never infer that a Device is powered off from a failed Hermes `/health` probe.
- Never put SSH credentials, peer API keys, provider tokens, or private keys in source, logs, or chat.
- Peer API traffic must use encrypted transport. Plain HTTP is allowed only inside Tailscale, another
  authenticated encrypted VPN, or an SSH tunnel bound to Origin loopback; otherwise use validated
  HTTPS. Never send a peer key or Agent request over direct plain-HTTP LAN.

## Change discipline

- Keep instructions generic: no personal hostnames, IP addresses, usernames, or machine-local paths.
- Use official Hermes install and configuration commands. Verify CLI help or official docs rather
  than inventing flags.
- Prefer one Origin-to-Device SSH relationship over an all-to-all SSH mesh.
- Verify every state change through a read-back: SSH reachability, gateway status, `/health`, peer
  roster, and one request/reply.
- Do not present legacy prototype code as the current owner workflow.
