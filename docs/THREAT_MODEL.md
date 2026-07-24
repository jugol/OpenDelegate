# OpenDelegate Threat Model

Status: **Initial approved-spec baseline**

Date: **2026-07-24**

This threat model is updated as implementation ADRs select concrete protocols and
libraries. It treats every Task input, Artifact, provider response, Device, network,
and browser as potentially fallible. A private LAN or VPN is not automatically
trusted.

## Security objectives

1. Only the Owner and explicitly allowlisted identities can create or control work.
2. A compromised Worker cannot obtain database access or Secrets from other Devices.
3. An Agent cannot exceed executable Policy through prompting or tool indirection.
4. A stale or duplicate process cannot repeat protected side effects.
5. Generated content cannot inherit Admin Web authority.
6. Task context cannot cross Task boundaries implicitly.
7. Device-local Knowledge cannot be queried or copied by Main.
8. Operational evidence remains useful without leaking credentials.
9. Main cannot be claimed remotely before local owner initialization.
10. Automatic work cannot run or spend without a finite bound.

## Protected assets

- Owner identity, recovery credentials, and Admin sessions.
- Device identities and enrollment grants.
- Main database and audit history.
- Device-local Secret values.
- Device-local Knowledge Markdown and indexes.
- Task instructions, attachments, reports, and screenshots.
- Source repositories, workspaces, and uncommitted changes.
- Native Codex and Claude sessions.
- Artifact content and exposure credentials.
- Desktop input authority.

## Trust boundaries

### Owner to Main

Admin Web and Discord are distinct authentication paths. Discord authorization is
based on configured identity, not message text. Admin authentication is enforced even
on private networks.

### Main to Worker

All protocol traffic requires a Device-scoped application identity over an encrypted
channel. Tailscale, Omada, source IP, or tunnel membership is not identity.

### Worker Core to User Session Helper

Local IPC grants only declared graphical operations and status. The helper cannot
read Main database credentials, change Policy, or impersonate another Device.

### Worker to Agent provider

Only bounded Task context, selected local Knowledge, and narrowly scoped credentials
enter the agent process. Provider output is untrusted until normalized and checked by
Policy.

### Artifact to browser

Generated HTML is hostile content. Static output has scripts disabled. Interactive
output uses a separate origin and cannot receive Admin cookies or storage.

### Discord to Task

Forum content, attachments, component interactions, duplicate events, and event order
are untrusted. Author identity and external IDs are validated before Task ingestion.

### Local host account and filesystem

The operating-system account running a Worker and host administrators are inside the
Device trust boundary. Path validation and no-symlink checks protect against Task
input, accidental traversal, and ordinary unsafe files; they do not claim to defeat
a hostile same-privilege process or administrator racing filesystem namespace
changes between OS calls. Such access already permits replacement of the Worker
binary, Agent configuration, and local Secret Store and is treated as Device
compromise. Production service guidance must use a dedicated account and restrictive
permissions where other local users are not trusted.

## Primary threats and required controls

| Threat | Required controls | Required proof |
| --- | --- | --- |
| Enrollment token replay | Short lifetime, one use, Main identity verification, audit | Replayed and expired grants fail |
| Stolen Worker credential | Rotation, revocation, Device scope, no DB permission | Revoked Device cannot reconnect or claim |
| Prompt injection requests a dangerous action | Typed action request, Policy Engine, normalized approval | Malicious input cannot bypass denial |
| Approval scope is widened by free text | Machine-readable exact target and expiry | Executor rejects a broader command |
| Once approval is replayed or raced | Atomic grant consumption before execution, durable consumption record | Exactly one matching execution is authorized across restart |
| Duplicate dispatch repeats a side effect | Durable idempotency outcome, Run lease, fencing | Duplicate events produce one effect before and after restart |
| Corrupt Resource Lock history restores stale authority | Complete acquire and renewal histories, token-ordered clock and capacity checks, exact active-outcome cross-check | Missing, discontinuous, clock-regressing, stale-fence, or mismatched snapshots fail closed while valid renewals restore |
| Delayed duplicate renewal extends authority twice | Durable renewal command identity and replay outcome | Live and post-restart replay returns the first result; conflicting reuse fails closed |
| Coherent rollback restores an older controller and fencing prefix | Transactional generation CAS, exclusive Device service, helper or Main-side monotonic high-watermark outside the snapshot | Stale coherent restore cannot accept input; unavailable authority fails closed into explicit recovery |
| Stale Worker continues or reports after reassignment/expiry | Full completion envelope, fencing, monotonic journal acceptance time | Old or expired Run result is rejected live and on replay |
| Expired or ineligible durable Run blocks all retries | Explicit failed-Run retirement, higher fencing on replacement, fail-closed corruption handling | Restart and route-change fixtures retire the old Run before a new attempt |
| Secret appears in prompt or logs | Local Secret Store, narrow process injection, redaction | Adversarial Secret fixtures never persist |
| Worker queries another Device's Knowledge | No protocol or Main schema for Knowledge content | Packet and database inspection remain empty |
| Cross-Task context contamination | Immutable Task IDs, explicit input selection | Two Forum posts stay isolated |
| Native session transcript interleaves | Single-writer session lease | Concurrent resume serializes or fails |
| Wrong workspace is modified on resume | Device and Workspace binding, cwd verification | Mismatch creates continuation instead |
| Generated HTML steals Admin session | Separate origin, CSP, no-script default, cookie isolation | XSS fixture has no Admin authority |
| Public Artifact is exposed accidentally | Explicit Exposure Policy, audit, no inferred public fallback | Route failure never changes exposure |
| Remote attacker claims uninitialized Admin | Local-only initial claim and recovery bootstrap | Remote claim is impossible |
| Discord outage blocks recovery | Independent Admin authentication | Owner controls Tasks without Discord |
| Computer Use conflicts or persists after cancel | Exclusive lock, emergency stop, helper liveness | Second Run waits and cancellation stops input |
| Duplicate Computer Use start or authorization race creates a stale controller | Durable start-command history, post-authorization lease/fence revalidation | Duplicate handles share one execution or fail closed, and lease expiry or replacement blocks input |
| Computer Use input inherits read-only authority | Distinct action category, exact Task or configured Policy grant | No click or keystroke executes under an observation allowance |
| Agent creates unbounded child work | Hierarchical finite budgets | Runaway fake Agent hits a hard stop |
| Malicious package source is installed automatically | Existing-source classification, approval for new sources/scripts/drivers | Protected installer prompts |
| Diagnostic bundle leaks topology or Secrets | Structured allowlist, redaction, explicit export | Security fixture remains redacted |
| Main restart loses external events | Durable inbox/outbox, Discord reconciliation | Restart journey reaches one valid result |

## Security review gates

- No protocol implementation merges without authentication, authorization,
  idempotency, and redaction tests.
- No executable adapter merges without Policy conformance tests.
- No HTML viewer merges without hostile-content tests.
- No OS helper merges without least-authority IPC review.
- No persisted field merges before confirming its source-of-truth boundary.
- No Computer Use persistence is release-ready until coherent rollback is tested
  against the external monotonic authority; the in-memory seam alone is insufficient.
- No release is accepted with waived cross-platform security tests.
