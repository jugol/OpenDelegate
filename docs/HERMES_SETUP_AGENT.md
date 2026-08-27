# Hermes setup Agent onboarding

Use this guide when the owner wants Hermes Agent to install, initialize, repair, or join OpenDelegate. Hermes is the local **setup Agent** in this workflow: it reads the repository instructions, follows the project skills, runs deterministic checks, and asks for owner approval at protected boundaries.

This guide does not add a Hermes runtime Agent Adapter to OpenDelegate. OpenDelegate runtime execution remains the separate Agent Adapter contract implemented for Codex, Claude, and generic command runners.

## Happy path

### 1. Install Hermes on each Device that needs local setup help

Windows PowerShell:

```powershell
iex (irm https://hermes-agent.nousresearch.com/install.ps1)
```

macOS or Linux terminal:

```sh
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
```

Open a new terminal after installation and run:

```sh
hermes doctor
```

Fix the exact item reported by `hermes doctor` and rerun it before continuing.

### 2. Obtain or update OpenDelegate

For a new source checkout:

```sh
git clone https://github.com/jugol/OpenDelegate.git
cd OpenDelegate
```

For an existing source checkout:

```sh
git pull --ff-only
```

A verified release bundle is a separate supported input. Extract it into an owner-controlled directory. Do not run `git pull`, pnpm, or source-only scripts inside a release bundle.

### 3. Keep state and credentials outside the project

Before starting setup, require the effective `HERMES_HOME` and the selected OpenDelegate runtime home to resolve outside both the checkout and release bundle. Stop if either path is inside the project tree.

Never synchronize, commit, attach, or paste the contents of `HERMES_HOME`, provider homes, OpenDelegate runtime homes, credentials, auth files, sessions, databases, logs, private keys, peer keys, Device Knowledge, generated Artifacts, or enrollment grants. Each Device keeps its own local state.

### 4. Start Hermes with the correct skill path

For a **source checkout**, run this once from the repository root:

```sh
hermes skills trust
```

Then close any existing conversation and start a fresh Hermes session from the same repository root:

```sh
hermes
```

Trust only a checkout you intentionally obtained and reviewed. Hermes discovers these project skills after trust:

- `.agents/skills/opendelegate-init/SKILL.md`
- `.agents/skills/opendelegate-join/SKILL.md`

For a **release bundle**, start Hermes from the extracted bundle directory:

```sh
hermes
```

The bundled `AGENTS.md` routes Main work to `skills/opendelegate-init/SKILL.md` and Worker work to `skills/opendelegate-join/SKILL.md`. Project-skill trust is source-only; do not pretend a bundle is a Git checkout.

## Main install prompt

Copy this into the fresh Hermes session:

> Set up OpenDelegate on this computer as my fixed, always-on Main Device. Identify whether this is a source checkout or a verified release bundle, read AGENTS.md and the canonical documents it names, then read the matching init skill. Keep Hermes and OpenDelegate state outside the checkout or bundle. Never ask me to paste credentials, tokens, provider homes, sessions, databases, private keys, Device Knowledge, or grant contents into chat. Use provider-native authentication or OpenDelegate secure intake when a secret is required. Report the exact preview or release status, ask only for decisions that change my intent, and stop if a required safety check fails.

## Worker join prompt

On Main, create a short-lived single-use Device grant. Transfer the unopened file to the Worker through an owner-controlled local or OS-secure handoff. Never open it in an editor or paste its contents into chat.

On the Worker Device, start a fresh Hermes session from its source checkout or verified bundle and send:

> Join this computer to my fixed OpenDelegate Main as an outbound-only Worker using the unopened single-use grant file at `<absolute-path-to-grant-file>`. Identify the installation input, read AGENTS.md and the matching join skill, and pass only the grant file path to OpenDelegate tooling. Never print, paste, log, summarize, or copy the grant contents. Keep all Hermes state, Worker state, credentials, sessions, databases, private keys, Device Knowledge, and generated Artifacts outside the checkout or bundle. Ask before any protected network, firewall, VPN, service, package-source, driver, kernel, or privileged change.

## Source checkout and bundle paths

| Input | Main skill | Worker skill |
| --- | --- | --- |
| Source checkout | `.agents/skills/opendelegate-init/SKILL.md` | `.agents/skills/opendelegate-join/SKILL.md` |
| Release bundle | `skills/opendelegate-init/SKILL.md` | `skills/opendelegate-join/SKILL.md` |

The source tree has one canonical copy of each skill under `.agents/skills`. Release assembly copies those files into `skills/` inside the bundle. Intra-skill references are relative so they remain valid in both layouts.

## Preview and release wording

Read `supportStatus` and say exactly what the evidence supports. A status beginning with `internal-preview` is an **unsupported internal preview**, even when local smoke tests pass. A release candidate is still unsupported until the documented external promotion and supported-channel chain makes those exact bytes effectively released.

Do not install an internal preview as an unattended production control plane. Do not infer service persistence, platform support, provider support, or Computer Use readiness from source code or fixture tests alone.

## Rollback and troubleshooting

- If Hermes cannot see the source project skills, confirm the terminal is at the Git repository root, rerun `hermes skills trust`, and start a new session.
- If `HERMES_HOME` or an OpenDelegate runtime path resolves inside the checkout or bundle, stop and select an external absolute path before setup.
- If Main initialization fails, reread the init skill and report the exact failing step, support status, and launcher output without secrets. Do not continue to persistent service installation after a failed gate.
- If Worker join fails or the grant may have been consumed, inspect Main first and issue a new single-use grant. Never edit or replay the old grant.
- Remove only a generated preview directory after confirming it contains no owner files or runtime state. Deleting the source checkout is not a runtime rollback.
- Use the repository's service lifecycle and backup/restore guides for an installed release. Never replace their health check, journal, or rollback path with an improvised shell supervisor.
