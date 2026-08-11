# ADR-0067: Windows owner Agent launcher path

- Status: Accepted
- Date: 2026-08-12
- Decision: D-140

## Context

The Windows core runs continuously under an instance-specific virtual-service
account. That identity correctly isolates OpenDelegate from the interactive owner,
but SCM supplies a system-oriented executable search path. Live service evidence
showed Claude installed under the owner's `.local\bin` and Codex installed by npm
under the owner's `AppData\Roaming\npm`; both were available in the owner terminal
while the persistent Worker reported an adapter probe failure.

Copying the owner's complete interactive `PATH` into a privileged service boundary
would admit unrelated, temporary, and owner-writable executable locations. Requiring
system-wide provider installs would contradict D-076's single owner-authenticated
provider home. Windows npm also exposes Codex through a `.cmd` shell wrapper, while
Agent adapters deliberately launch providers without a shell.

## Decision

The Windows native service document records the installing owner's profile directory
only when the owner process can derive it from the operating-system account record and
the normalized account name matches `whoami`. The path must be an absolute,
non-root Windows profile path. Service installation and guarded upgrade reject every
other value.

The core child environment prepends exactly these two locations to the existing
service `PATH`, with case-insensitive deduplication:

1. `<owner-home>\.local\bin`
2. `<owner-home>\AppData\Roaming\npm`

OpenDelegate does not inherit the owner's complete shell environment. Before an
Agent adapter receives the environment, Worker projects it onto the fixed non-secret
process-variable allowlist used by provider execution. The same projected environment
is used for readiness probes, model catalogs, immutable Run selection, provider
start, native-session resume or continuation, diagnostics, and provider upgrades.
Runtime service-mode evidence continues to use the unprojected service environment.

On Windows, the Codex adapters inspect the bounded `PATH` for npm's exact
`node_modules\@openai\codex\bin\codex.js` layout. When present, they invoke that
entry point through OpenDelegate's pinned Node executable. They never enable a shell
or execute the npm `.cmd` wrapper. An explicitly configured provider executable still
wins over discovery.

Upgrade accepts one exact predecessor runtime document whose sole difference is the
missing owner-home field. It writes the current document atomically while the service
is stopped. Any additional installed-definition drift remains a hard preflight
failure.

The service document also records the exact resolved Codex and Claude home directories
and the runtime configuration projects them as `CODEX_HOME` and `CLAUDE_CONFIG_DIR`.
The binding is mandatory for a persistent Windows service. Each home must be a strict
descendant of the verified owner profile or of that provider's exact managed state root;
the two homes must be disjoint and neither may overlap the bounded launcher trees,
source or bundle input, installed releases, service-owned roots, the owner-helper
vault, or the service Secret handoff and vault.
The elevated install, start, restart, and upgrade plans add the instance virtual-service
identity to those existing directories with inheritable recursive Modify access. They
add the same identity to the two launcher directories above with inheritable recursive
Read & Execute access. These are additive, identity-scoped grants: lifecycle execution
uses `icacls /grant:r` only for the OpenDelegate service principal and never uses
`/inheritance:r`, `/reset`, ownership transfer, or directory creation for these
owner/provider-managed paths. Recursive traversal uses `/L`, so descendant symbolic
links are modified as links rather than followed. Missing paths are skipped, while a
linked, special, or noncanonical declared root fails before mutation.

The Codex `.sandbox-bin` Full Control repair runs after the broader Codex-home Modify
grant so it cannot be downgraded. It has an exact existing-parent precondition: when
the declared Codex home is missing, lifecycle skips both the home grant and sandbox
child instead of recreating owner-managed provider state.

Because this decision adds a runtime field, the upgrade executor snapshots the exact
installed runtime-configuration bytes immediately before the atomic forward write.
Its rollback action restores that snapshot, not a newly rendered approximation of
the predecessor. An `alpha.70` host can therefore restart on the byte-identical
configuration it parsed before the attempted upgrade.

## Alternatives considered

### Inherit the owner's complete interactive environment

Rejected because it would make service execution depend on mutable shell state and
admit executable directories unrelated to OpenDelegate's supported provider installs.

### Execute npm command wrappers through a shell

Rejected because shell lookup and metacharacter interpretation would weaken the
explicit executable boundary shared by every Agent adapter.

### Copy provider launchers or authentication into service-owned storage

Rejected because copied provider state would drift from the owner's SSOT
authentication and unnecessarily duplicate credentials or provider-managed files.

### Require system-wide Codex and Claude installation

Rejected because a personal-first installation should reuse the provider tools the
owner already installed and authenticated without requiring a second machine-wide
installation.

## Consequences

- Owner-installed Codex and Claude launchers in the two declared Windows locations
  remain discoverable after boot and without an interactive terminal.
- Main's local Worker, remote Workers, diagnostics, scheduling inventory, model
  validation, and actual native sessions use one executable-discovery boundary.
- The two provider launcher directories are owner-writable by design. The provider
  sandbox, virtual-service identity, exact-action authorization, service ACLs, and
  Secret Store remain separate enforcement layers; no broader owner path is admitted.
- The exact Codex and Claude homes keep their existing owner- and provider-managed ACLs;
  only the current OpenDelegate instance service principal receives recursive Modify.
  The exact two launcher directories receive only recursive Read & Execute.
- The service runtime uses the same two paths for every probe and native session; an
  ACL target can never drift from the provider's effective home.
- Install and upgrade persist one additional non-secret owner profile path and must
  preserve the exact legacy-document migration.
- A provider installed elsewhere requires an explicit executable configuration or a
  future ADR extending the bounded discovery policy.

## Verification

- Windows owner-home parsing rejects roots, relative paths, trailing separators,
  device paths, and account mismatches.
- Service-host tests prove the two ordered launcher paths, case-insensitive
  deduplication, input immutability, and `system-service` reporting.
- Worker inventory tests prove that provider probes and model inspection receive the
  bounded allowlist while secret-like variables and service markers do not.
- A Windows composition test creates the real npm Codex package layout and proves
  both `codex-app-server` and `codex-cli` report tested, authenticated readiness.
- Service-plan and native-executor tests prove that provider-home and launcher grants
  precede core start, skip missing paths, reject links, preserve inheritance and all
  unrelated ACL entries, replace only the declared service principal's ACE, reject
  protected-root overlap, and do not recreate a missing provider home through its
  sandbox child.
- Run-selection tests prove the same projected environment reaches immutable model
  validation; the Worker execution plan carries it into start and resume handling.
- Guarded upgrade tests accept only an exact predecessor missing the owner-home field,
  the provider-home binding, or both, and reject any second runtime-document difference.
- A failed-health upgrade test proves rollback restores the exact legacy runtime bytes,
  including the continued absence of the provider-home field.

## References

- [`../PRODUCT_SPEC.md`](../PRODUCT_SPEC.md), FR-3 and FR-16
- [`../IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md), Phase 4
- [`../DECISIONS.md`](../DECISIONS.md), D-076, D-134, D-139, and D-140
- [`0010-reproducible-platform-bundles-and-provenance.md`](0010-reproducible-platform-bundles-and-provenance.md)
- [`0011-native-two-plane-service-supervision-and-authenticated-ipc.md`](0011-native-two-plane-service-supervision-and-authenticated-ipc.md)
- [`0018-programmatic-agent-adapters-and-action-authorization.md`](0018-programmatic-agent-adapters-and-action-authorization.md)
- [`0040-windows-worker-service-preparation-binding.md`](0040-windows-worker-service-preparation-binding.md)
- [`0047-windows-virtual-service-sid-network-compatibility.md`](0047-windows-virtual-service-sid-network-compatibility.md)
- [`0052-windows-codex-service-sandbox-directory.md`](0052-windows-codex-service-sandbox-directory.md)
