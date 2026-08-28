Give your Agent this repository URL and ask it to configure your multi-computer Hermes environment.

# OpenDelegate

**OpenDelegate is a lightweight, field-tested setup kit for Hermes Device Agent federation.**

It exists so an owner can hand one repository URL to an Agent instead of manually wiring every
computer. The Agent discovers each machine, installs or repairs official Hermes Agent, chooses an
owner-approved connection, assigns Device roles, starts the right services, and verifies that one
request can reach the best computer and finish there.

Language: **English** · [한국어](README.ko.md)

## The intended outcome

After setup:

- one stable computer can act as the always-on coordinator and messaging entry point;
- macOS, Windows, Linux/NAS, and portable Devices retain their useful local capabilities;
- Devices connect through SSH, Hermes peer/API, or another owner-approved private route;
- a request sent from Discord, a phone, or any connected computer can be delegated to the best
  eligible Device;
- the result returns to the original conversation;
- credentials, sessions, databases, and each `HERMES_HOME` stay Device-local.

This repository also records the traps we hit first: PATH drift, stale services, Discord intents and
mention policy, peer quoting, conflicting timeout layers, Gateway restart races, completion loss,
sleeping portable Devices, and the difference between reachability and authenticated authority.

## Quick start

1. Open an Agent on the computer that should coordinate the fleet.
2. Give it this repository URL.
3. Send this prompt:

> Read this repository as a Hermes federation setup kit. Discover this computer and the other
> owner-approved computers I want to connect. Install or repair official Hermes Agent locally, keep
> credentials and `HERMES_HOME` Device-local, choose an appropriate private connection such as SSH or
> Hermes peer/API, assign useful Device roles, install persistent Gateway services, and prove one
> end-to-end delegated request. Follow the repository's security and recovery guidance. Ask before
> pushes, deployments, destructive deletion, authority expansion, secret disclosure, or network and
> firewall changes.

4. Repeat on additional computers when the coordinator asks you to install or register their local
   Device Agent.
5. Do not call setup complete until the Agent proves health, peer identity, delegation, result return,
   service persistence, and rollback.

See [Quick start](docs/QUICKSTART.md) for the detailed checklist.

## What the setup Agent should do

The canonical workflow is:

```text
discover → install → connect → verify → operate
```

### Discover

- identify OS, host role, existing Hermes install, profiles, services, and stable routes;
- verify required capabilities instead of inferring them from the OS name;
- choose one stable coordinator and treat sleeping portable computers as best-effort Workers.

### Install

- install or repair official Hermes Agent using its current official documentation;
- run `hermes doctor`;
- use native service management (`systemd`, `launchd`, or Windows login/service integration);
- keep profile state and credentials local to that Device.

### Connect

- select SSH, Hermes peer/API, or another owner-approved private route;
- authenticate above the network: reachability is not identity or authority;
- use stable Device IDs and roles;
- never commit real IP addresses, tokens, peer keys, or private paths to this repository.

### Verify

- probe deterministic health endpoints before spending an Agent turn;
- send a bounded request to the intended Device;
- require a complete result envelope and return it to the original conversation;
- verify restart behavior without interrupting active peer work;
- record rollback evidence.

### Operate

- delegate only when another Device is genuinely useful;
- keep the receiving Agent responsible for the owner's final answer;
- treat timeout as an observation boundary, not proof that a remote Worker failed;
- use durable orchestration for unknown-duration work.

## Repository contents

```text
.agents/skills/opendelegate-setup/  Agent-facing setup workflow
docs/QUICKSTART.md                 Owner and Agent checklist
docs/HERMES_SETUP_AGENT.md        Detailed setup-Agent procedure
docs/HERMES_FEDERATION_OPERATIONS.md
                                   Peer timeout, restart, and recovery guidance
docs/SECURITY_BOUNDARIES.md        Secret, authority, and state boundaries
templates/                         Device, Agent, peer request, and fleet templates
examples/four-device-fleet.md      Generic multi-Device example
```

## Important boundary

The practical path documented here uses **official Hermes Agent**. This kit does not claim that raw
`hermes peer dm` already provides exactly-once dispatch, durable request storage, or automatic recovery
for arbitrarily long work. For those guarantees, use a durable orchestration service. The historical
OpenDelegate application implementation remains available in Git history, but it is not part of the
current setup-kit tree.

## Safety

- Never synchronize an entire `HERMES_HOME` between Devices.
- Never place `.env`, auth files, sessions, databases, peer keys, or credentials in Git.
- Confirm pushes, deployments, external messages, purchases, destructive deletion, authority
  expansion, and private-data disclosure.
- Never disable SSH host-key verification or accept an unexpected key change.
- Do not expose an unsandboxed Hermes API server to an untrusted network.

Read [Security boundaries](docs/SECURITY_BOUNDARIES.md) before connecting a fleet.

## License

Apache License 2.0. See [LICENSE](LICENSE).
