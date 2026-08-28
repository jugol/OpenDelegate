# Four-Device fleet example

This is a generic topology. Replace placeholders only in Device-local, untracked configuration.

## Roles

| Device | Role | Availability |
| --- | --- | --- |
| Linux/NAS coordinator | Discord or messaging entry point, coordination, storage, long-running work | always-on |
| Mac Studio | Xcode, Apple signing/builds, macOS apps | fixed |
| Windows workstation | GPU/CUDA and Windows apps | fixed |
| Laptop | owner interaction and short portable work | best-effort |

## Request flow

```text
Owner message
  → coordinator accepts and owns the Task
  → deterministic health check
  → coordinator selects one useful Worker
  → bounded peer request
  → Worker returns a complete result
  → coordinator verifies and answers the owner
```

## Example acceptance request

Use `templates/PEER_REQUEST.txt` with a read-only objective such as:

> Return your stable Device ID and whether the requested capability is currently available. Do not
> change files or settings.

## Failure behavior

- Offline laptop: report unavailable and choose another eligible Device only when policy permits.
- Wait timeout: report completion unknown; inspect read-only history before considering retry.
- Gateway restart requested during peer work: defer restart.
- Unexpected SSH host key: stop.
- Missing credential: ask the owner to configure it locally; do not copy another Device's secret.

## What is not committed

- real hostnames or private IP addresses;
- API, bot, or peer keys;
- owner filesystem paths;
- populated `DEVICE.md` files;
- Hermes sessions, databases, logs, or auth files.
