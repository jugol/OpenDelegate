# ADR-0060: Worker failures lead with actionable diagnostics

Status: **Accepted**

Date: **2026-08-11**

Decision: **D-122**

## Context

A native provider process can emit a progress statement and then fail before it
produces a trustworthy result. The authoritative Worker event correctly carried a
closed diagnostic such as `PROCESS_FAILED` at the `execution` stage, but Task
projection used only the last public Worker report. Discord therefore presented a
sentence such as “I will continue” as though it explained the failure and hid the
actual code needed to inspect the Run.

## Decision

When an authoritative Worker Run fails, deterministic Main code builds the Task
failure explanation from the owner-safe diagnostic stage, code, and retryability.
A non-retryable process failure explicitly says that OpenDelegate did not replay an
outcome-uncertain process and directs the owner to Task Runs and Retry. A retryable
failure identifies itself before the existing resource-wait coordinator explains
automatic continuation.

The final public Worker report may follow under the label `Last Worker report (may
be incomplete)`, but it never replaces the diagnostic. Diagnostic labels use a
closed character and length grammar, and an oversized combined message drops the
report rather than exceeding the public-message boundary.

## Consequences

Discord and Admin Web expose the same concrete failure code and stage without
claiming that provider progress was a cause or completion. OpenDelegate does not
blindly replay an external process whose effects may be uncertain. Worker prose
remains useful as bounded context while deterministic orchestration owns the retry
instruction.

## Verification

- Executor tests prove a progress-like final report cannot hide a non-retryable
  `PROCESS_FAILED` diagnostic.
- Retryable failure tests prove the diagnostic remains visible before the bounded
  last Worker report.

## References

- [Product specification FR-20](../PRODUCT_SPEC.md#fr-20--audit-and-observability)
- [ADR-0059](0059-discord-sequential-approval-clarity.md)
