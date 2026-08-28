# Hermes setup Agent procedure

Use this document when an Agent is asked to configure a multi-computer Hermes environment from this
repository.

## Contract

You are a setup and operations Agent. Use official Hermes Agent as the runtime. This repository supplies
workflow, templates, safety boundaries, and field-tested troubleshooting; it does not replace Hermes.

The workflow is:

```text
discover → install → connect → verify → operate
```

Do not mark setup complete after installation alone.

## Phase 1 — Discover

Read:

1. `AGENTS.md`
2. `docs/SECURITY_BOUNDARIES.md`
3. `docs/QUICKSTART.md`
4. `.agents/skills/opendelegate-setup/SKILL.md`

Then inspect only the local Device and owner-approved peers. Record non-secret facts:

- stable Device ID;
- OS and role;
- Hermes executable, version, home, profiles, and services;
- verified capabilities;
- candidate private routes;
- whether the Device may sleep;
- blocked prerequisites and required approvals.

Do not infer CUDA, Xcode, Computer Use, Docker, or another capability from the OS name.

## Phase 2 — Install

Use the current official Hermes documentation for installation and service management.

Required verification:

```sh
hermes --version
hermes doctor
hermes profile list
hermes gateway status
```

Prefer one Hermes code installation with named Profiles over duplicate installations on one Device.
Give each independently running bot/Profile its own credentials and state.

Use native service management:

- Linux: the documented user or system service;
- macOS: launchd;
- Windows: the current official persistent Gateway path.

Record a rollback before replacing a working service definition or profile.

## Phase 3 — Connect

### Route selection

Use an owner-approved route in this order of concern:

1. identity and authentication;
2. stable reachability;
3. least authority;
4. operational simplicity;
5. fallback cost.

Possible transports include SSH and Hermes peer/API. Never treat reachability as identity or authority.
Never disable SSH host-key checking or accept an unexpected key change.

### Local boundaries

Keep these on the Device that uses them:

- `.env` and API keys;
- auth files and provider homes;
- sessions and databases;
- Gateway locks and process state;
- peer keys;
- private Device metadata.

Only generic templates and reviewed, non-secret documentation belong in Git.

### Device files

Create ignored local copies:

- `templates/DEVICE.md` → `DEVICE.local.md`
- `templates/AGENTS.md` → `AGENTS.local.md`
- `templates/fleet.example.yaml` → `fleet.local.yaml`

Populate private endpoints only in those local files.

## Phase 4 — Verify

Run a deterministic `/health` probe before Agent turns. Treat it as liveness evidence only; verify the
authenticated peer identity and authorization separately. Then send one bounded, read-only request to an
explicit Worker using `templates/PEER_REQUEST.txt`.

A valid result must carry:

- the matching request ID;
- the expected Device ID;
- an allowed status;
- a concise observable summary;
- shared outputs or an empty list;
- unresolved issues or `none`.

Verify that the result reaches the original owner conversation. A remote result stored only in the
Worker's Bot Chat is not end-to-end completion.

## Phase 5 — Operate

- The Agent receiving the owner request stays responsible for the final result.
- Delegate only when another Device is useful.
- Honor explicit Device names.
- Treat laptops that sleep as best-effort Workers.
- Keep unknown-duration work on a durable orchestration path.
- Defer Gateway restart while peer work is active.
- Reconcile interrupted work before accepting unrelated completion claims.

## Reasonable timeout layers

Timeouts have different responsibilities:

| Layer | Example bound |
| --- | --- |
| Health probe | 5–10 seconds |
| Foreground peer observation | up to 600 seconds |
| Agent tool guard | longer than peer observation, for example 900 seconds |
| Whole Gateway turn | longer than tool guard, for example 3600 seconds |

These values are examples, not universal defaults. Increasing a timeout does not create durable
execution. `hermes peer dm` is synchronous and does not provide transport-level exactly-once dispatch.

## Restart fencing

Before an update, model change, profile migration, or Gateway restart:

1. list active Agent turns and background processes;
2. identify in-flight peer requests;
3. defer restart until bounded work completes;
4. if restart is unavoidable, persist the pending correlation IDs and origin routes;
5. reconcile after startup before claiming completion.

## Completion report

Report:

- Devices configured;
- Profiles and service states;
- routes and identity checks, without secret values;
- verified capabilities;
- acceptance requests and results;
- known limitations;
- rollback locations;
- protected actions that remain pending.
