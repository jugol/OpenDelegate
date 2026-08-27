# ADR-0059: Hermes setup-Agent onboarding

Status: **Accepted**

Date: **2026-08-27**

## Context

OpenDelegate is installed and joined through Agent-facing skills, but the source skills lived under a repository-local `skills/` directory that Hermes does not discover as project skills. A newcomer using Hermes could clone the repository, start a session, and still miss the installer procedure because Hermes requires project skills under `.agents/skills/` or `.hermes/skills/` and requires explicit trust for a source checkout.

Release bundles have a different contract. They are not Git source checkouts, keep their Agent-facing skills under `skills/`, and include `AGENTS.md`. Treating a bundle like a trusted source project would give owners incorrect commands and break bundled skill references.

Hermes can safely guide setup without becoming an OpenDelegate runtime Agent Adapter. The runtime Adapter contract starts, observes, resumes, cancels, and policy-gates Worker Runs; documenting Hermes as a setup harness does not implement that product code or its conformance evidence.

## Decision

The source checkout keeps one canonical copy of each OpenDelegate setup skill under:

- `.agents/skills/opendelegate-init/SKILL.md`
- `.agents/skills/opendelegate-join/SKILL.md`

Source setup with Hermes requires `hermes skills trust` from the repository root followed by a fresh Hermes session. Codex and Claude remain able to follow the same skills through repository instructions.

Release assembly copies the canonical source skill directories into these bundle paths:

- `skills/opendelegate-init/SKILL.md`
- `skills/opendelegate-join/SKILL.md`

Intra-skill references are relative so they resolve in both layouts. The bundled `AGENTS.md` selects the bundle path; project-skill trust is not used for a bundle.

The documented preflight requires the effective `HERMES_HOME` and every OpenDelegate runtime home to resolve outside the source checkout and release bundle. Device-local credentials, auth files, sessions, databases, logs, provider homes, private keys, Knowledge, Artifacts, and grants remain outside repository content and Agent chat.

Hermes is a supported **setup Agent** for this onboarding path. It is not a first-class OpenDelegate runtime Agent Adapter. Runtime support remains limited to Adapter implementations and evidence accepted by the product specification.

## Consequences

- A newcomer can clone or update OpenDelegate, trust the project skills once, and ask Hermes to configure Main or join a Worker.
- Codex, Claude, and Hermes share the same source-of-truth procedures without duplicated SKILL.md files.
- Bundles remain self-contained and keep their established `skills/` contract.
- Release tests assemble the bundle skills and prove that every intra-skill path resolves.
- README, Admin Web grant prompts, release README generation, acceptance evidence, and repository maps must distinguish source and bundle paths.
- This ADR creates no Hermes runtime execution claim, provider login, credential migration, Device protocol change, or service authority.
