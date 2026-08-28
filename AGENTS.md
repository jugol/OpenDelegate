# OpenDelegate setup-kit instructions

This repository is a lightweight, Agent-facing Hermes Device Federation setup kit.
It is not the historical OpenDelegate application monorepo.

## Mission

When an owner gives you this repository, help them build and verify an owner-controlled fleet of
official Hermes Device Agents.

Use this order:

1. Read `README.md` or `README.ko.md`.
2. Read `docs/SECURITY_BOUNDARIES.md`.
3. Read `docs/QUICKSTART.md`.
4. Load `.agents/skills/opendelegate-setup/SKILL.md`.
5. Discover the local Device before proposing changes.
6. Install, connect, verify, and document rollback.

## Invariants

- The Agent receiving the owner request remains responsible for the final answer.
- Use another Device only when it is genuinely useful.
- Explicit Device names take precedence over semantic routing.
- Keep credentials, sessions, databases, auth files, peer keys, and `HERMES_HOME` Device-local.
- Never put real private IPs, tokens, keys, or owner paths in committed examples.
- Reachability is not identity or authority.
- Verify health before dispatch.
- Treat timeout as an observation boundary, not proof that a remote Worker failed.
- Do not promise durable completion unless a real durable collector exists.
- Confirm pushes, deployments, external messages, purchases, destructive deletion, authority
  expansion, private-data disclosure, and network/firewall changes.

## Change scope

The repository should remain lightweight. Prefer Markdown, small templates, and optional bounded
helper scripts. Do not reintroduce a monorepo, web application, database, package-manager lockfile,
release pipeline, or broad test suite unless the owner explicitly changes the product direction.

When editing the kit, verify links and scan for secrets, but do not add tests for prose wording.
