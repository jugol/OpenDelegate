# ADR-0025: Proactive Task and Discord Forum origin

- Status: Accepted
- Date: 2026-07-28
- Refines: D-023, D-062, FR-4, FR-5, FR-18, ADR-0004, ADR-0007

## Context

An owner may authorize deterministic monitors to turn incidents or improvement
signals into work. Creating an internal Task alone does not satisfy the product
surface: Discord projects only Tasks that already have a Forum binding. Conversely,
letting a monitor call an Agent or mutate a Device outside Task accounting would
bypass the normal coordinator, Policy, Approval, budget, lock, and audit boundaries.

Discord's Forum-create endpoint creates one public thread with a nested starter
message but exposes no dedicated idempotency-key parameter. A process can therefore
lose the HTTP response after Discord created the post but before Main stored the
binding.

FR-4 separately permits a bounded, read-only, Task-independent diagnostic Agent after
deterministic transport recovery is exhausted. This exception diagnoses an incident;
it does not authorize remedial mutation outside a Task.

## Decision

1. Every proactive category resolves to inherit, disabled, propose, or execute.
   Propose creates an ordinary manual-review Task; execute creates an ordinary auto
   Task. The signal identity produces the Task idempotency key.
2. The Task enters the normal Task service and execution coordinator. Monitors receive
   no separate mutation, Secret, Policy, Approval, budget, or resource-lock path.
3. When a Discord runtime is ready, Main asks it to present the new Task. The adapter
   chooses the first configured approved Forum, creates a bot-authored starter post
   with the intake workflow tag, stores the Task/thread binding, and then enqueues the
   ordinary Components v2 status projection.
4. The post name and starter content contain deterministic Task identity. Before
   retrying an unbound create, the adapter searches matching active and paginated
   archived bot-owned posts and binds the exact starter message. Multiple matches
   fail closed instead of creating another post.
5. Discord unavailability never rolls back or hides the authoritative Task in Main.
   Presentation is attempted when the configured runtime is ready; Admin remains the
   authoritative recovery surface.
6. FR-4's Task-independent diagnostic Agent remains read-only and tool-denied. Its
   bounded result may become the input signal for a subsequent ordinary recovery
   Task; all remedial work occurs inside that Task.

## Alternatives considered

### Direct monitor-to-Agent repair

Rejected because it creates hidden work outside Task accounting and policy seams.

### Create only an internal Task

Rejected because a configured Discord Forum is the primary task dashboard and cannot
project a Task without a durable external binding.

### Blindly retry Forum creation

Rejected because an uncertain HTTP response can create duplicate posts.

## Consequences

The same proactive Task is visible in Admin and, when Discord is ready, as a normal
Forum post with the same session and workflow semantics as owner-originated work.
Outbound reconciliation requires bounded active and archived Forum reads. The first
configured Forum is the deterministic default until a future explicit category-to-
Forum routing setting is approved.

## Verification

- Proactive originator tests cover disabled, manual-review, auto, stable signal
  idempotency, and presentation invocation.
- Discord adapter tests cover one bot-originated post, durable binding, restart
  reconciliation, and duplicate avoidance.
- Discord HTTP tests verify the API v10 Forum-create request and nested response.

## References

- `docs/PRODUCT_SPEC.md` FR-4, FR-5, and FR-18
- `docs/DECISIONS.md` D-023 and D-062
- `docs/research/platform-capabilities.md`
- [Discord Channel resource](https://docs.discord.com/developers/resources/channel)

