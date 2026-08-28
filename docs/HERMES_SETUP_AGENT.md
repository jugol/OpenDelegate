# Hermes setup Agent onboarding

Use this guide when the owner wants Hermes Agent to help install or join OpenDelegate from a source checkout or from a verified release bundle.

Hermes is a setup and configuration Agent for this guide. This document does not claim that Hermes is a first-class OpenDelegate runtime Agent Adapter, and it does not implement one. OpenDelegate runtime support remains the Agent Adapter contract described for Codex, Claude, and generic command runners. Hermes may read the repository, trust project skills, and drive the owner-facing setup checklist just like another capable local Agent.

## Happy path

1. Install Hermes on the Device where you want help.

   Windows PowerShell:

   ```powershell
   iex (irm https://hermes-agent.nousresearch.com/install.ps1)
   ```

   macOS or Linux terminal:

   ```sh
   curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
   ```

2. Run the Hermes health check:

   ```sh
   hermes doctor
   ```

   If this fails, fix the exact item reported by `hermes doctor`, then run it again before continuing.

3. Open a terminal in the OpenDelegate source checkout root or extracted bundle directory.

4. For a source checkout, trust the project skills and then start a fresh Hermes session:

   ```sh
   hermes skills trust
   hermes
   ```

   Trust only a checkout you intentionally obtained and reviewed. The canonical source project skills are:

   - `.agents/skills/opendelegate-init/SKILL.md`
   - `.agents/skills/opendelegate-join/SKILL.md`

   A release bundle continues to carry those same skills under `skills/opendelegate-init/SKILL.md` and `skills/opendelegate-join/SKILL.md` because bundle users should not need source-only layout knowledge.

5. Ask Hermes for the role you want.

## Main install prompt

Copy this into the fresh Hermes session from the source checkout root or bundle directory:

> Set up OpenDelegate on this computer as my fixed, always-on Main Device. First read AGENTS.md and the canonical OpenDelegate documents, then read the canonical init skill for this input type. If this is a source checkout, use `.agents/skills/opendelegate-init/SKILL.md`; if this is a release bundle, use `skills/opendelegate-init/SKILL.md`. Keep runtime state outside the checkout or bundle. Do not paste credentials, tokens, provider homes, sessions, databases, private keys, or Device Knowledge into chat. Guide me through provider-native authentication or OpenDelegate secure intake when a secret is required. Be honest about preview or release status and stop if a safety check fails.

## Worker join prompt

On the Main Device, create a short-lived single-use Device grant using the OpenDelegate UI or documented grant command. Move the unopened grant file to the Worker Device through an owner-approved local handoff. Do not open it in an editor and do not paste its contents into chat.

Copy this into a fresh Hermes session on the Worker Device from the source checkout root or bundle directory:

> Join this computer to my fixed OpenDelegate Main as an outbound-only Worker using the unopened single-use grant file at `<absolute-path-to-grant-file>`. First read AGENTS.md and the canonical OpenDelegate documents, then read the canonical join skill for this input type. If this is a source checkout, use `.agents/skills/opendelegate-join/SKILL.md`; if this is a release bundle, use `skills/opendelegate-join/SKILL.md`. Pass only the grant file path to OpenDelegate tooling. Never print, paste, log, summarize, or copy the grant contents. Keep Worker state outside the checkout or bundle and stop before any network, firewall, VPN, service, or privileged change that needs owner approval.

## Source checkout versus release bundle

A source checkout has `AGENTS.md`, `CONTEXT.md`, `package.json`, `pnpm-lock.yaml`, and `.agents/skills/...`. Hermes should read AGENTS.md, read the canonical documents it names, run the documented release-status checks, and build or use an explicitly marked preview outside the checkout when the product flow requires a bundle.

A release bundle has `release-metadata.json`, `SHA256SUMS`, `runtime`, a platform launcher, docs, and `skills/...`. Hermes should verify the checksums, read the bundle release docs, and use only bundled launchers. It should not use pnpm, source-only scripts, or a global Node runtime from inside a bundle.

## Operating a Hermes Device Agent fleet

A current Hermes fleet may use official Bot Mode, Messaging Gateway, Connections, and `hermes peer`
without turning Hermes into an OpenDelegate runtime adapter. Install Hermes separately on every
computer, run `hermes doctor`, and configure that Device's gateway locally. Keep the always-on
Discord representative on a stable Device; route GPU, Apple build, storage, and portable work to
Devices with those verified roles.

Use the platform-native gateway lifecycle:

- Linux: `hermes gateway install` for a user service, or the documented `--system` form for a
  boot-time service when the owner explicitly chooses it.
- macOS: `hermes gateway install` creates the launchd agent.
- Windows: `hermes gateway install` creates a logon Scheduled Task with the official Startup-folder
  fallback.

Register private peer connections locally and inspect them with `hermes peer list`. Send long or
structured peer requests through stdin, for example `hermes peer dm <device> < request.txt`, rather
than interpolating owner text into a shell argument. A sleeping portable computer is best-effort,
not an always-on coordinator. When exact placement matters, name the target Device explicitly.

### Long-running peer work and restart recovery

A foreground wait timeout is not proof that the Worker failed. The remote API may have accepted the
turn and may continue after the Origin's terminal or tool guard stops waiting. Preserve the request
envelope and `request_id` before dispatch, and do not promise that a reply will arrive later unless a
durable completion handle owns both the remote call and the exact origin Task or Discord thread.

`hermes peer dm` does not provide a durable request ledger or idempotent dispatch. Its `request_id` is
operator-defined correlation data inside the message body, not a transport-enforced idempotency key.
A local pending record helps recovery but does not turn a second dispatch into an exactly-once retry.

Keep the timeout layers ordered. `terminal.timeout` bounds one foreground observation;
`timeouts.tools.sequential_call` and `timeouts.tools.concurrent_batch` must be longer than that
transport bound; `agent.gateway_timeout` must be longer than the complete tool cycle. A practical
Hermes-only coordinator baseline is 600 seconds for terminal work, 900 seconds for tool guards, and
3600 seconds for the Gateway turn. These are budgets, not evidence that work failed.

For unknown-duration work, prefer a durable OpenDelegate Worker Run. A one-shot Hermes cron is not a
durable collector for a peer wait that can outlive its run limit; the default cron interrupt is shorter
than the 600-second peer transport bound. A Hermes-only deployment needs an explicit OS-supervised
collector outside the Gateway cgroup, with its own persistent request state and exact delivery target.
If that service is not installed, do not claim durable automatic completion: keep work inside the bounded
foreground path or report that long-run collection is unavailable. Never use an untracked background
shell process. If a wait times out or a Gateway restart interrupts the collector, reuse the same
`request_id` only as a correlation key for a read-only inspection of the peer's canonical Bot Chat or
request record. Recover an existing `PEER_RESULT` without resending the objective. If no stored result is
visible, report `completion_unknown` and require an explicit decision before retry.

Before restarting a Gateway for an update, model change, or profile migration, inspect active peer
requests and background work. Always defer the restart while in-flight peer work exists; collect its
result first. When restart is unavoidable, persist pending IDs and origin bindings first and reconcile them
immediately after startup. See [Hermes Device Federation operations](HERMES_FEDERATION_OPERATIONS.md)
for the full timeout hierarchy, completion contract, and recovery playbook.

Do not commit private gateway URLs or copy peer keys between repositories. Do not synchronize one
Device's `HERMES_HOME` into another Device. Share only reviewed project files, human-readable
knowledge, and verified artifacts. The owner-facing Korean fleet guide and troubleshooting notes are
in [README.ko.md](../README.ko.md#hermes-device-agent-운영-가이드).

## State and credential boundaries

Never synchronize or commit any Device's `HERMES_HOME`, Hermes credentials, sessions, databases, logs, auth files, provider homes, private keys, peer keys, OpenDelegate runtime homes, Device Knowledge, generated Artifacts, or grant file contents.

The source checkout is for source code and project documentation only. Runtime state belongs in the platform default OpenDelegate home or an owner-selected absolute runtime path outside the checkout and outside the release bundle.

## Setup Agent versus runtime adapter

Hermes in this guide is allowed to act as a setup Agent: it reads documentation, follows project skills, explains choices, runs safe checks, and asks for owner approval before protected actions.

That is different from an OpenDelegate runtime Agent Adapter. A runtime adapter is product code that starts, observes, resumes, cancels, and policy-gates provider-native Worker Runs under OpenDelegate's Agent Adapter contract. This change does not add a Hermes adapter, does not advertise Hermes as a first-class runtime provider, and does not imply that the current Hermes harness automatically becomes an OpenDelegate Worker runtime.

## Preview and release wording

Say exactly what the evidence supports. If `supportStatus` begins with `internal-preview`, call it an unsupported internal preview. If a candidate is not externally promoted through the documented release channel, call it a release candidate, not a supported release. A successful local smoke test or build does not change release status.

## Rollback and troubleshooting

If Hermes setup fails before OpenDelegate changes system state, keep the checkout as-is and rerun `hermes doctor`, then start a new Hermes session from the same directory.

If an OpenDelegate preview was built, remove only the generated preview directory after confirming no runtime state or owner files are stored inside it. Do not delete the source checkout to roll back runtime state.

If Main init fails, ask Hermes to re-read `.agents/skills/opendelegate-init/SKILL.md` or the bundled `skills/opendelegate-init/SKILL.md`, inspect the recorded support status and exact launcher output, and report the failing step. Do not proceed to service installation when a required safety gate failed.

If Worker join fails, create a new single-use grant on Main. Treat the old grant as consumed or expired. Ask Hermes to re-read the join skill and retry with only the new unopened grant path.

If Hermes itself cannot see project skills after `hermes skills trust`, close the session, start a new one from the repository root, and ask it to list the trusted project skills before continuing.
