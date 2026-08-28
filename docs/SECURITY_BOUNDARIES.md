# Security boundaries

A Hermes Device Agent can execute commands, read files, and contact services with the authority of its
OS user. Connect a fleet as an authority system, not only as a networking exercise.

## Device-local state

Never synchronize or commit:

- `.env` files;
- API or bot tokens;
- auth files and provider homes;
- sessions, databases, logs, or locks;
- SSH private keys or peer keys;
- a complete `HERMES_HOME`;
- private Device inventories or owner paths.

Use the templates in this repository as unpopulated examples. Keep populated copies outside the repo or
ignored locally.

## Network is not identity

A private IP, VPN membership, LAN reachability, or Tailscale address does not prove Device identity.
Use application authentication and verified SSH host keys. Refuse unexpected host-key changes.

## API exposure

- Bind to the narrowest required interface.
- Require a strong API key.
- Restrict inbound access with the existing trusted network policy.
- Prefer a sandbox for remotely initiated work.
- Do not expose an unsandboxed terminal-capable Agent to the public Internet.

## Least authority

- Use a dedicated OS account when practical.
- Give Discord only the intents and channel permissions it needs.
- Allow only intended users.
- Keep service and profile credentials separate when the bots have different roles.
- Confirm authority expansion, firewall changes, network mutations, package sources, and privileged
  service installation.

## Owner confirmations

Confirm before:

- Git push or deployment;
- external messages or public sharing;
- purchases or paid resources;
- destructive deletion;
- credential disclosure;
- broader filesystem, network, or account authority.

## Logging and documentation

Record sanitized evidence only. Generic examples may use placeholders such as `DEVICE_PRIVATE_URL` and
`PEER_API_KEY`; do not replace them with real values in Git.

## Incident response

If a key may have leaked:

1. stop using it;
2. rotate it on the Device that owns it;
3. update only local dependents;
4. review logs for misuse;
5. remove the value from current files and Git history if it was committed;
6. document the incident without reproducing the secret.

Report repository security issues privately as described in [SECURITY.md](../SECURITY.md).
