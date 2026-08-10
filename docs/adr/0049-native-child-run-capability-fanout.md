# ADR-0049: Bound Run-capability fan-out for native child Agents

Status: **Accepted**

Date: **2026-08-09**

- Decision: D-097

## Context

OpenDelegate gives a Worker Run local MCP tools through an owner-protected opaque
descriptor and a platform-local authenticated broker. The original broker deleted
that descriptor after one MCP client claimed it. This was correct for one provider
session, but provider-native Agent teams initialize inherited MCP configuration in
each child session.

Packaged NAS verification demonstrated the mismatch: the root Codex App Server
session claimed the Artifact and Knowledge descriptors successfully, while three
native child starts failed during MCP initialization because both descriptors had
already been consumed. No child turn ran. The provider, model, session persistence,
lease, and sandbox were otherwise healthy.

## Decision

Single-connection capability descriptors remain the default. The Worker execution
plan may request a five-connection limit only when all of these are true:

- the adapter is bridged Codex App Server or Claude Agent SDK;
- its allow-list enables `Agent` or `Task`; and
- the sessions remain inside the same exact Worker Run.

Five is the root provider session plus the product limit of four native children.
The broker reserves a connection slot before asynchronous authority checks so
simultaneous claims cannot race past the bound. Each claim authenticates the same
opaque token and receives the same immutable Run binding. The broker continues to
check current execution, lease, fence, and expiry before every request. Run
disposal, cancellation, replacement, expiry, or broker restart removes the
descriptor and closes every client.

The reusable descriptor does not contain a resource path, content, credential, or
new executable authority. It remains outside the source checkout and owner-only on
Unix. A process able to read it already has the parent Run's bearer authority;
another connection changes concurrency, not scope.

## Consequences

- Provider-native children can initialize inherited OpenDelegate MCP servers.
- Ordinary and CLI-fallback Runs retain single-use descriptor behavior.
- Up to five simultaneous clients can use a Run tool, but all share its existing
  request bounds, domain budgets, exact-action Policy, and revocation boundary.
- An excess simultaneous claim fails closed without evicting a valid client.

## Verification

- A default descriptor is deleted on its first claim and rejects a copied replay.
- A native-Agent descriptor accepts the configured bounded client count, rejects an
  excess simultaneous claim, and accepts a replacement only after a slot closes.
- Execution-plan tests prove that only supported bridged adapters with Agent
  delegation receive the root-plus-four limit.
- Packaged Linux and Windows Worker Runs each complete a provider-native child turn
  with inherited Run-scoped MCP configuration before release promotion.

## References

- [`0045-bounded-provider-native-child-agents.md`](0045-bounded-provider-native-child-agents.md)
- [`0018-programmatic-agent-adapters-and-action-authorization.md`](0018-programmatic-agent-adapters-and-action-authorization.md)
- [`../PRODUCT_SPEC.md`](../PRODUCT_SPEC.md), FR-9
- [`../IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md), Phase 6
