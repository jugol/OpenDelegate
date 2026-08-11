# ADR-0066: Post-turn Artifact evidence is deterministic

- Status: Accepted
- Date: 2026-08-11

## Context

The Worker Agent can write Artifact bytes and commit its bounded Run manifest, but
success-only promotion runs in deterministic Worker code after the provider-native
turn returns. This ordering prevents an Agent from claiming a file that was never
accepted by Main's durable store.

During live alpha.58 QA, Main durably stored a 188-byte Artifact with the expected
SHA-256 and provenance. The successful authenticated Worker terminal event carried
that Artifact ID, and Discord reconciled an `Open report` action. The Worker Agent's
earlier prose correctly said that it could not observe the later promotion step.
Because the verification prompt did not describe this temporal boundary, the Main
Agent treated that prose as a missing completion criterion and left the Task waiting.

## Decision

1. The Worker Artifact prompt says that `artifact_commit` seals the Run manifest,
   that promotion happens after the native turn succeeds, and that the Agent must
   finish normally without claiming or denying the later promotion or Discord UI.
2. Planning must not assign a Worker Agent the impossible duty of attesting
   post-turn promotion or adapter presentation. It plans file production and
   manifest commit instead.
3. Task verification projects each Artifact ID from an accepted successful Worker
   terminal event as explicit `promoted-to-main-durable-store` evidence. This
   deterministic evidence outranks conflicting uncertainty in the earlier
   Worker-authored report.
4. When the requested outcome is to return a file in the current Task, promoted
   Artifact evidence satisfies the delivery boundary. Discord reconciliation owns
   the later owner-visible link or native presentation.
5. Artifact evidence grants no access authority. Exposure Policy, browser grants,
   Discord delivery, and Artifact availability remain independently enforced and
   auditable.

## Consequences

A successful Artifact Run no longer waits for an observation the Agent cannot make.
The Main Agent still receives bounded report text for synthesis, but it can
distinguish provider-authored claims from the deterministic post-turn result. A
failed promotion still prevents Worker success and keeps its allowlisted Artifact
diagnostic and retry decision.

Discord reconciliation remains independently retryable. A Task may be complete
while Discord is transiently unavailable, but the durable Artifact and Task state
allow later repair without replaying the Worker action.
