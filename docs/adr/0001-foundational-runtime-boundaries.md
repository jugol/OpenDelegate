# ADR-0001: Foundational runtime boundaries

Status: **Accepted**

Date: **2026-07-24**

## Context

OpenDelegate coordinates one owner's Devices across different operating systems and
networks. A pairwise SSH mesh, shared database credentials, a moving Main role, or
direct dependence on one agent provider would conflict with the approved product
invariants.

The first milestone also requires Computer Use. Native OS service models separate
boot-time daemons from logged-in graphical sessions, so one undifferentiated Device
process cannot correctly represent both always-on orchestration and desktop control.

## Decision

OpenDelegate uses these runtime boundaries:

1. One fixed Main Control Plane owns orchestration and database access.
2. Every Device runs an always-on Worker Core; Main may also execute the Worker role.
3. Every graphical Device may run a logged-in User Session Helper with narrowly
   scoped local IPC to its Worker Core.
4. Workers establish authenticated logical connections to Main and never form an
   OpenDelegate-managed NxN remote-shell mesh.
5. Agent providers, Discord, networking methods, databases, Artifact stores, Secret
   stores, and Computer Use backends remain adapters around domain contracts.

## Alternatives considered

### Pairwise SSH

Rejected because credentials and access policy scale quadratically and expose a
general shell where the product needs typed, auditable work dispatch.

### Automatic Main failover

Rejected for the first release because the owner selected a fixed Main and does not
want split-brain risk.

### One service process per Device

Rejected because a system daemon cannot safely or reliably impersonate a logged-in
desktop on the target operating systems.

## Consequences

- Main outage pauses new orchestration by design.
- Worker protocol and local helper IPC need independent identity and authorization.
- Device health and desktop readiness are separate state.
- Headless Linux remains a full non-graphical Worker.
- New providers and transports cannot leak vendor state into core Task identity.

## Verification

- The canonical Task journey runs across three authenticated Workers without SSH or
  Worker database credentials.
- Main restart reconciles state without electing another Main.
- Logging out removes Computer Use readiness while the Worker remains online.
- Two Computer Use Runs cannot hold the same desktop-session lock.

## References

- `CONTEXT.md`
- `docs/PRODUCT_SPEC.md`
- `docs/DECISIONS.md`
- `docs/research/platform-capabilities.md`
