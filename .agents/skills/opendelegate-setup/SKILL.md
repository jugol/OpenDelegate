---
name: opendelegate-setup
description: Use when configuring a Hermes multi-Device fleet.
version: 1.0.0
platforms: [linux, macos, windows]
---

# OpenDelegate setup

Use this skill when an owner gives you this repository and asks you to configure official Hermes Agent
across multiple computers.

## Read first

1. `AGENTS.md`
2. `docs/SECURITY_BOUNDARIES.md`
3. `docs/QUICKSTART.md`
4. `docs/HERMES_SETUP_AGENT.md`
5. `docs/HERMES_FEDERATION_OPERATIONS.md`

## Own the request

The Agent receiving the owner request remains responsible for the final answer. Delegate only when
another Device is useful. Explicit Device names override semantic routing.

## Workflow

### 1. Discover

Inspect the local Device before changing it:

- OS and stable Device ID;
- Hermes executable, version, home, profiles, and Gateway state;
- verified capabilities;
- stable private routes;
- whether the Device sleeps;
- approvals required for the next step.

Probe a remote `/health` endpoint before dispatching an Agent turn. Treat the response as liveness
only; verify the authenticated peer identity and authorization separately.

### 2. Install

Use current official Hermes documentation. Run:

```sh
hermes --version
hermes doctor
hermes profile list
hermes gateway status
```

Prefer one code installation with named Profiles over duplicate Hermes installations on one Device.
Use the platform-native persistent Gateway mechanism.

### 3. Connect

Choose an owner-approved authenticated route such as SSH or Hermes peer/API. Never disable SSH
host-key verification. Reachability is not identity or authority.

Populate local copies of:

- `templates/DEVICE.md`
- `templates/AGENTS.md`
- `templates/fleet.example.yaml`

Do not commit populated private copies.

### 4. Verify

Send one bounded read-only request with `templates/PEER_REQUEST.txt`. Validate the complete
`PEER_RESULT`, then prove it reaches the original owner conversation.

Verify services after restart, but defer restarts while peer work is active.

### 5. Operate

- Health before dispatch
- Origin owns completion
- Device roles guide placement but grant no authority
- Timeout is not Worker failure
- Unknown-duration work requires durable orchestration
- Credentials and runtime state remain Device-local

## Safety

Confirm pushes, deployments, external messages, purchases, destructive deletion, authority expansion,
private-data disclosure, and network/firewall changes.

Never print or copy credentials, peer keys, auth files, sessions, databases, or full `HERMES_HOME`
contents into messages or Git.

## Completion

Report the configured Devices, roles, service states, sanitized route evidence, acceptance request,
result-return proof, limitations, and rollback locations. Never present a plan or partial install as a
completed fleet.
