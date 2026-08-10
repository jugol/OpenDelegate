# ADR-0048: Linux Claude nested-sandbox readiness

- Status: Accepted
- Date: 2026-08-09
- Decision: D-096

## Context

Claude Agent SDK uses `bubblewrap` and `socat` for its fail-closed Linux Bash
sandbox. OpenDelegate originally treated executable presence as sufficient readiness
evidence.

During an installed NAS Worker run, the primary Claude turn started and invoked a
provider-native child Agent, but Bash could not apply the sandbox's seccomp policy.
The host's packaged AppArmor `unpriv_bwrap` profile allowed one user namespace and
intentionally stripped the capability needed by the nested namespace. A single
`bubblewrap` smoke succeeded while an equivalent nested smoke failed. The provider
turn then remained alive instead of producing useful work.

Claude exposes a weaker nested-sandbox option, but enabling it reduces isolation.
OpenDelegate cannot infer owner consent to weaken a Device security boundary merely
because a preferred Agent would otherwise be unavailable.

## Decision

The Linux Claude Agent SDK probe performs two independent checks:

1. `bwrap` and `socat` must be executable through the service's effective `PATH`.
2. A three-second, read-only nested `bubblewrap` command must create both user
   namespaces and exit successfully.

The command binds the host root read-only, performs no network access, and writes no
runtime state. Timeout, spawn failure, signal exit, or a non-zero status marks the
adapter `incompatible` with diagnostic code
`CLAUDE_SANDBOX_RUNTIME_UNAVAILABLE`. Worker inventory projects that as
`platform-incompatible`.

The SDK remains configured with `failIfUnavailable: true`,
`allowUnsandboxedCommands: false`, and `enableWeakerNestedSandbox: false`.
OpenDelegate does not edit AppArmor, kernel, or container policy as part of adapter
probing or routine package repair. Main may choose the next binding only when the
Device profile explicitly uses Prefer mode and declares that fallback.

## Consequences

- A Linux Worker no longer advertises native Claude child Agents when its actual
  sandbox primitive cannot run.
- The first user Task does not become the sandbox compatibility probe or wait on a
  provider process that cannot complete useful tools.
- A pinned Claude binding still fails closed. A Prefer profile can route to its exact
  configured Codex or other fallback and records that effective binding in the Run.
- Supporting Claude on a policy-restricted host requires a separate, explicit,
  auditable owner decision about the host boundary.

## References

- [Anthropic Claude Agent SDK types](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/types.py)
- [Anthropic SDK sandbox availability issue](https://github.com/anthropics/claude-agent-sdk-typescript/issues/239)
