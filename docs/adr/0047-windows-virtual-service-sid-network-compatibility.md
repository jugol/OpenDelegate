# ADR-0047: Windows virtual-service SID network compatibility

- Status: Accepted
- Date: 2026-08-09
- Decision: D-095

## Context

The Windows core runs as a dedicated `NT SERVICE\OpenDelegate-<instance>`
virtual account rather than `LocalSystem`. The original service renderer selected
SCM SID type `RESTRICTED`, which adds the virtual-service SID to both the normal and
restricted SID lists in the process token.

Live multi-Device testing showed that this token could reach Main's fixed IP Worker
channel but a provider process launched by the service could not use ordinary
DNS/HTTPS to reach its authenticated API. The same executable, controlled provider
home, request, model, and environment succeeded in the owner's normal token. The
service did not have a Windows Service Hardening network restriction or an outbound
Firewall block. Microsoft documents `RESTRICTED` as a compatibility-sensitive SID
type and recommends `UNRESTRICTED` for services that need a service SID unless the
installer also owns the complete restricted-resource policy.

`UNRESTRICTED` is an SCM token term. It does not mean unrestricted network policy,
administrator rights, `LocalSystem`, or a Firewall bypass.

## Decision

Windows OpenDelegate core services use the same dedicated virtual-service account
with SCM SID type `UNRESTRICTED` and the existing explicit required-privilege list.
Release and state ACLs, exact service-SID Secret binding, owner/helper separation,
Windows Firewall, OpenDelegate Action Policy, and the provider sandbox remain
independent enforcement layers.

Install and upgrade plans always set the declared SID type, so an existing
`RESTRICTED` installation is repaired deterministically during its next privileged
upgrade. Health checks run only after the service has restarted with the new token.

## Consequences

- Headless Windows Workers can use authenticated provider DNS/HTTPS without moving
  Agent execution into the interactive session.
- The core remains a non-admin, instance-specific service identity and receives only
  its declared Windows privileges and ACL grants.
- Operators can still add service-scoped Firewall rules. Firewall, VPN, proxy, and
  route mutations remain protected OpenDelegate actions.
- A Windows lab gate must exercise provider traffic from the installed service, not
  merely from the installing user's terminal.

## References

- [Microsoft: SERVICE_SID_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winsvc/ns-winsvc-service_sid_info)
- [Microsoft: Configure Firewall Rules](https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/configure)
