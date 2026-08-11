# ADR-0052: Windows Codex service sandbox directory

- Status: Superseded by ADR-0068
- Date: 2026-08-10
- Decision: D-100

## Context

The Windows Worker runs under a non-admin virtual-service identity while reusing the
owner's already authenticated Codex home. Live service execution reached that home
and the network, but Codex sandbox initialization failed while locking
`.sandbox-bin`: the helper must update that directory's security descriptor, which
requires more than inherited Modify access. The provider then requested a sandbox
escalation for an otherwise read-only Task.

Granting the service Full Control over the complete Codex home would expose session
and configuration material unnecessarily. Running the Worker as the interactive
owner would also erase the service identity boundary.

## Decision

The Windows Worker service document declares only the resolved Codex
`<codex-home>\.sandbox-bin` directory when its Agent selection may use Codex. The
service configuration accepts only an absolute path whose final component is
exactly `.sandbox-bin` and which remains outside the source checkout.

Install, start, restart, and upgrade ensure that directory before starting core and
apply an inheritance-free ACL granting Full Control to Administrators, SYSTEM, the
owner SID, and `NT SERVICE\OpenDelegate-<instance>`. Native service execution uses
the same guarded directory mutation and exact service-plan allowlist as every other
service-owned path.

After startup, Codex may add the exact local `CodexSandboxUsers` group so its
provider-created child sandbox identities can traverse and execute the helper. A
post-start verifier may accept that one additional explicit ACE only when its rights
are exactly Read & Execute plus Synchronize. OpenDelegate never grants that group
write, delete, ownership, or ACL-control rights, and every other identity remains
invalid.

## Consequences

Codex can initialize its Windows sandbox under the installed Worker identity while
the rest of the provider home retains its existing boundary. Re-running lifecycle
commands repairs a deleted or recreated helper directory. Claude-only Workers do
not add the Codex directory action. An invalid path fails before host mutation. A
provider-managed child-sandbox group remains useful without widening the provider
home or granting it authority to mutate the helper directory.

## Verification

- Configuration rejects a broader provider directory and a checkout-local helper.
- Worker service-document composition resolves the selected owner Codex home.
- Install, start, restart, and upgrade place the ACL step before core start.
- Native execution emits an exact service Full-Control ACE for `.sandbox-bin` and no
  recursive grant.
- Post-start verification accepts at most one exact `CodexSandboxUsers` Read &
  Execute plus Synchronize ACE and rejects broader rights or another identity.

## References

- [`../PRODUCT_SPEC.md`](../PRODUCT_SPEC.md), FR-3 and FR-16
- [`../IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md), Phase 4
- [`0047-windows-virtual-service-sid-network-compatibility.md`](0047-windows-virtual-service-sid-network-compatibility.md)
