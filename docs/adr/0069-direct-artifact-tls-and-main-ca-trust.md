# ADR-0069: Direct Artifact TLS reuses the pinned Main identity

- Status: Accepted
- Date: 2026-08-13

## Context

ADR-0065 made Artifact delivery part of ordinary Main initialization but intentionally
left remote Worker ingress explicit. Live Discord-to-Windows QA then committed a valid
Run Artifact on the remote Worker while Main advertised its default loopback upload URL.
The Worker consequently addressed its own `localhost`, exhausted bounded upload recovery,
and could not promote the result.

A verified reverse proxy remains valid, but requiring a second TLS terminator for a
private Main-to-Worker route adds an unnecessary deployment dependency. Every enrolled
Worker already stores the instance CA and its pinned CA SPKI, and Main already owns a
CA-chained server identity for its Device listeners.

## Decision

1. An explicit Artifact listener may select either loopback HTTP, a verified HTTPS
   reverse proxy, or direct HTTPS. Direct HTTPS configuration carries absolute certificate
   and private-key paths, a matching exact HTTPS origin and port, and no reverse-proxy
   declaration.
2. Main reads those files as stable regular non-links outside the source checkout. It
   verifies certificate/key equality, current validity, and coverage of the advertised
   origin hostname before binding a TLS 1.3-only listener. Static and interactive planes
   remain distinct origins and listener instances.
3. A Worker validates its stored Main CA against the enrollment-time SPKI pin before
   making Artifact requests. HTTPS uploads use the normal public roots plus that exact
   private CA, retain hostname verification, reject redirects, and never disable certificate
   validation. Thus a public reverse proxy and a private CA-chained Main listener both work.
4. The configured Artifact origin remains the sole source of upload-grant URLs. Enabling
   direct TLS is an explicit owner deployment choice; no existing loopback installation is
   silently exposed or migrated.

## Consequences

Remote Workers on an owner-selected private route can upload directly to Main without a
separate proxy or machine-wide trust-store change. A wrong CA pin, wrong hostname,
mismatched key, expired certificate, source-checkout key path, cleartext remote origin, or
mixed direct/proxy configuration fails before Artifact bytes cross the boundary.

Browser trust remains a client concern: an owner-facing direct link needs either a
client-trusted certificate or a native channel presentation. Worker trust in the instance
CA does not install that CA into the operating system or browser.
