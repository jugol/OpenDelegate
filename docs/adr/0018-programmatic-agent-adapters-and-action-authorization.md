# ADR 0018 — Programmatic agent adapters and exact action authorization

Status: Accepted

Date: 2026-07-25

## Context

OpenDelegate must preserve one provider-native session per Task workstream while
keeping policy, capability authority, and durable Run state outside the provider.
CLI JSON streams remain useful compatibility fallbacks, but they cannot reliably
mediate every provider-native permission callback. Ambient provider configuration
also creates an unacceptable path for unrelated MCP servers, skills, hooks, or
memory to enter a Task.

## Decision

1. Codex uses the tested `0.145.0` App Server JSONL protocol as its first-class
   adapter. It runs with an absolute OpenDelegate-controlled `CODEX_HOME`, strict
   configuration, an explicit MCP set, and unrelated dynamic integrations disabled.
2. Claude uses exact-pinned `@anthropic-ai/claude-agent-sdk` `0.3.205`, which embeds
   Claude Code `2.1.205`. It ignores ambient settings, skills, and plugins, requires
   strict MCP configuration, and starts a fail-closed filesystem and network
   sandbox.
3. Native Windows Claude SDK execution is unavailable until its required sandbox
   can be enforced. Windows may use Codex natively or an explicitly configured WSL2
   or container Worker. The Claude CLI remains a capability-reduced fallback.
4. Main coordinator and configuration turns run in reasoning-only `deny` mode.
   Provider-native tools are not exposed there; deterministic OpenDelegate brokers
   execute configuration operations.
5. Worker programmatic turns run in `allow-listed` mode. Immediately before a
   protected provider action, the Device computes a fingerprint over the complete
   exact callback input and sends only that fingerprint plus bounded
   presentation-safe metadata to Main. Main evaluates current Policy and a durable
   allow is consumed after a final Run lease/fencing check before the callback is
   released.
6. Device-local Knowledge MCP calls do not traverse Main's action-authorization
   channel. Their exact Task, Run, Device, lease, fence, expiry, tool, and budget
   authority is already owned by the one-use local capability broker. Knowledge
   arguments and results remain on the Device.
7. CLI fallbacks remain available but truthfully report no provider approval
   bridge. Their native tool surface is denied; explicitly composed OpenDelegate
   MCP capabilities retain their own independent execution authorization.
8. A startup-observed Approval in `running` state is marked failed with an unknown
   outcome. OpenDelegate never replays a protected side effect merely because its
   completion receipt was interrupted.

## Consequences

- Provider-native session IDs remain durable and resumable without treating a
  desktop UI transcript as the source of truth.
- The owner must authenticate the controlled Codex home during setup; OpenDelegate
  does not copy provider credentials.
- Adding another programmatic provider requires the same isolation, exact-action,
  cancellation, event-bounding, and native-session conformance tests.
- Paid live turns, real account authentication, and physical platform proof remain
  release evidence rather than unit-test assumptions.
