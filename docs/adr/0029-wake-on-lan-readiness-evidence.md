# ADR-0029: Wake-on-LAN target evidence and automatic-wake readiness

Status: **Accepted**

Date: **2026-07-29**

## Context

An offline Worker cannot report its current network-adapter state, yet the owner needs
to know whether it was configured for Wake-on-LAN and whether OpenDelegate can
actually wake it. Those are different claims. Windows, macOS, and Linux expose a
target-side magic-packet setting, while delivery requires an online sender on the
target broadcast domain. Ordinary routed IP reachability, including Tailscale, does
not carry that Layer-2 packet.

Treating either an installed network adapter or VPN membership as proof of automatic
wake would make Device status operationally misleading. Sending raw probe output,
interface names, MAC addresses, or SecureOn values through the Device channel would
also disclose target material that Main Agents do not need.

## Decision

Each Worker runs one bounded, read-only platform probe and publishes only:

- target state: `enabled`, `disabled`, `unsupported`, or `unknown`;
- one platform probe-source enum; and
- the observation timestamp.

The versioned Worker heartbeat rejects extra fields, mismatched OS/source claims,
future timestamps, and raw target material. Main persists the last authenticated
observation and may display it while the Worker is offline.

Main projects a separate automatic-wake state. An enabled target is
`relay-required` until a future wake-path adapter verifies an online relay on the
same broadcast domain and owns a securely stored exact target. The current
implementation never emits `ready`. Admin Web shows both states and the observation
time on Worker Devices only. Main's bounded planning context may carry the same two
states but never a target, interface, credential, or raw probe result.

## Alternatives considered

### Infer readiness from VPN or route health

Rejected because IP reachability does not prove delivery of an Ethernet broadcast
magic packet.

### Store a MAC address in the shared Device summary

Rejected because the display and planning use cases need readiness, not the exact
wake target. Target material belongs behind a Device-local wake-path adapter and
Secret boundary.

### Probe only while the Device is offline

Rejected because an offline Worker cannot execute a probe. Main must retain the last
authenticated online observation and label it with its time.

## Consequences

Owners can distinguish “the Device was armed” from “OpenDelegate can wake it”
without guessing. A failed or permission-denied probe degrades only this observation
to `unknown`; one successful adapter result cannot conceal another adapter's failed
probe unless the successful result positively proves that some adapter is enabled.
Probe uncertainty cannot stop the Worker heartbeat. The first implementation is
truthful but intentionally cannot wake a Device until the separate relay lifecycle,
target storage, packet sender, Policy, audit, and retry boundaries are implemented.

## Verification

- Windows, macOS, and Linux probe fixtures reduce platform output to the bounded
  target state.
- Probe failure cannot block inventory or leak local diagnostics.
- The Worker and Device-channel contracts reject extra target data and mismatched
  platform evidence.
- Main retains the last authenticated target observation after restart while live
  scheduling remains offline.
- Admin Web distinguishes `enabled` from `relay required` in all six locales, shows
  explicit unknown state for an unassessed Worker, marks offline evidence as
  historical, hides the panel on Main, and passes desktop and mobile accessibility
  checks.
- Main planning context receives only the two bounded readiness states and time.

## References

- [`../PRODUCT_SPEC.md`](../PRODUCT_SPEC.md), FR-3 and FR-15
- [`../DECISIONS.md`](../DECISIONS.md), D-069
- [`../research/platform-capabilities.md`](../research/platform-capabilities.md),
  Wake-on-LAN
