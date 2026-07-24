# Security policy

OpenDelegate is pre-release software and has no supported release line.

| Version                                      | Security support |
| -------------------------------------------- | ---------------- |
| Source checkout and internal-preview bundles | Not supported    |
| Public releases                              | None published   |

Internal-preview code includes security controls and negative-path tests, but it has not completed
the final implementation threat-model review, three-OS live matrix, provider and Discord integration
proof, service/restart proof, or real Computer Use acceptance. Do not expose an internal preview as
an unattended production control plane.

## Reporting a vulnerability

Use GitHub's private vulnerability-reporting form:
[**Report a vulnerability privately**](https://github.com/jugol/OpenDelegate/security/advisories/new).
The route was enabled and verified for this repository on 2026-07-24. A report submitted there is a
private draft security advisory visible to the reporter and repository maintainers, not a public
issue.

Do not use a GitHub issue, pull request, discussion, Discord message, or general contact channel for
a suspected vulnerability. Never post vulnerability details or exploit steps publicly. In
particular, do not disclose:

- affected identifiers, versions, endpoints, hostnames, or private network topology;
- diagnostic output, logs, screenshots, database content, or reproduction steps;
- credentials, Secret values, bot tokens, session cookies, enrollment grants, owner-claim data, or
  recovery codes;
- private Task content, generated Artifacts, or provider-native Agent Session data; or
- Device Knowledge filenames, titles, links, graph/index data, snippets, or content.

Include the smallest private reproduction that establishes impact, together with the affected commit
or bundle identifier and a safe contact method. This pre-release project does not currently promise
a response or remediation SLA.

## Security boundaries

Security-sensitive boundaries include:

- loopback-only initial owner claim, owner authentication, recovery, CSRF, and browser-session
  revocation;
- single-use Device enrollment, Device-scoped identity, revocation, and Main–Worker transport
  authentication;
- deterministic Policy enforcement immediately before protected execution;
- Device-local Secret storage and narrow credential injection;
- Task isolation, idempotency, leases, fencing, and one writer per native Agent Session;
- generated Artifact path handling, static-script suppression, isolated origin, and explicit
  exposure policy;
- runtime-home containment that rejects symlinks and Windows reparse points, verifies POSIX
  owner-only modes, and restricts Windows access to the current owner and `SYSTEM`;
- recovery prevalidation, recovery-specific rate limits, and bounded Argon2 concurrency so invalid
  public bearers cannot force memory-hard password hashing;
- the Device-wide `desktop-session` lock and exact authorization for Computer Use input; and
- the rule that Device Knowledge never leaves its Device.

Private-network membership, VPN reachability, source IP, or tunnel access is never application
identity. Workers must not receive database credentials, and SSH is not the control-plane protocol.

## Safe testing

- Use only systems, accounts, Discord servers, and Devices you own or are explicitly authorized to
  test.
- Keep runtime homes and generated bundles outside the source checkout.
- Use dedicated least-privilege test credentials and a dedicated Discord laboratory.
- Sanitize evidence before publication. Keep raw platform-lab diagnostics private.
- Do not test denial-of-service, persistence, credential theft, desktop input, or public Artifact
  exposure against third-party infrastructure without explicit authorization.

See [`docs/release/PLATFORM_LAB.md`](docs/release/PLATFORM_LAB.md) for the non-secret live-proof
checklist.
