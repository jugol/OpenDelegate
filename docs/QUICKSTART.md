# Quick start

This checklist is for an owner or an Agent setting up a small Hermes Device Agent fleet.

## 1. Choose the coordinator

Pick a computer that is normally online and reachable from the other Devices. A NAS, home server, or
always-on desktop is usually better than a laptop that sleeps.

The coordinator should own:

- the primary messaging entry point;
- the final response to the owner;
- peer health and routing decisions;
- durable logs or task state when available.

## 2. Give this repository to the Agent

Use the prompt from [README.md](../README.md#quick-start) or [README.ko.md](../README.ko.md#가장-짧은-시작-방법).

The Agent should first produce a non-secret inventory:

- Device ID and role;
- operating system;
- Hermes version and `HERMES_HOME` location;
- Gateway service state;
- reachable private routes;
- capabilities that were actually verified;
- changes that require owner approval.

## 3. Install or repair official Hermes

Follow the current official Hermes documentation rather than copying stale commands from this kit.
At minimum:

```sh
hermes --version
hermes doctor
hermes profile list
hermes gateway status
```

Use `hermes gateway install` for the platform-native service path. Verify the resulting service after
reboot or login when persistent operation matters.

## 4. Assign Device roles

Example roles:

| Device class | Typical role |
| --- | --- |
| Always-on Linux/NAS | coordinator, messaging, storage, downloads, long-running work |
| Mac Studio | Xcode, Apple build/signing, Metal, macOS applications |
| Windows workstation | CUDA/GPU, Windows applications, local project work |
| Laptop | owner interaction and short portable work; not the only long-task target |

Roles guide scheduling; they do not grant authority.

## 5. Select a connection

Choose the least-complex owner-approved route that is stable for the Device pair:

- Hermes peer/API over a trusted private network;
- SSH with pinned host identity;
- another authenticated private transport.

Do not disable host-key verification. Do not assume VPN membership or IP reachability proves Device
identity. Store real endpoints and keys only in Device-local configuration.

## 6. Create local Device metadata

Create ignored local copies with these names:

- `templates/DEVICE.md` → `DEVICE.local.md`
- `templates/AGENTS.md` → `AGENTS.local.md`
- `templates/fleet.example.yaml` → `fleet.local.yaml`

Replace placeholders locally. Do not commit the populated private files.

## 7. Register peers

Use the current Hermes CLI documentation. For the peer CLI, the pattern is:

```sh
hermes peer list
hermes peer add <name> --url <private-api-url> --key <peer-api-key>
hermes peer dm <name> < request.txt
```

Keep peer keys in the local secret store or `.env`; never in this repository.

## 8. Configure messaging

If Discord is the entry point:

- enable required intents;
- allow only intended users;
- grant only required channel permissions;
- decide whether a mention is required;
- designate a normal text home channel for proactive results;
- verify the live Gateway WebSocket, not only REST access.

## 9. Run acceptance checks

Do not stop at “the bot is online.” Prove all of these:

- coordinator health succeeds;
- each Worker health succeeds;
- peer identity and route are correct;
- a read-only request reaches an explicitly named Worker;
- the Worker returns a complete result;
- the coordinator relays the result to the original conversation;
- Gateway restart is deferred or fenced while peer work is active, and an idle restart proves service persistence;
- a stopped or sleeping Device is reported honestly;
- rollback instructions work.

Use [`templates/PEER_REQUEST.txt`](../templates/PEER_REQUEST.txt) for a bounded smoke request.

## 10. Operate safely

- Probe health before dispatch.
- Delegate only when another Device is useful.
- Keep the Origin responsible for completion.
- Treat timeout as unknown observation, not automatic Worker failure.
- Defer Gateway restarts while peer work is active.
- Use durable orchestration for unknown-duration work.

See [Federation operations](HERMES_FEDERATION_OPERATIONS.md) and
[Security boundaries](SECURITY_BOUNDARIES.md).
