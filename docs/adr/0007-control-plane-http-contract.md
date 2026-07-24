# ADR-0007: Control Plane HTTP contract

Status: **Accepted**

Date: **2026-07-24**

## Context

Main must host Admin Web, expose an authenticated local Control Plane API, provide
minimal supervisor health, and later accept Device and Discord integration traffic.
Those surfaces have different principals and must not share a generic bearer or
accidentally serialize internal fields. The API also needs one runtime schema source
for validation, TypeScript types, response filtering, and an auditable OpenAPI
artifact.

The first milestone is a self-hosted Node.js service with native SQLite and Argon2
dependencies. Edge-runtime portability is not a goal. Fastify's schema lifecycle,
encapsulation, injection-based test seam, and explicit plugin support fit that
boundary without moving HTTP behavior into the domain.

## Decision

### Libraries and module boundary

1. Use `fastify@5.10.0` as Main's HTTP server with:
   - `@fastify/type-provider-typebox@6.1.0`;
   - `typebox@1.3.7`;
   - `@fastify/cookie@11.1.2`;
   - `@fastify/helmet@13.1.0`;
   - `@fastify/rate-limit@11.1.0`; and
   - `@fastify/swagger@9.8.1`.
2. Pin exact versions. The selected provider uses the current `typebox` package, not
   legacy `@sinclair/typebox`.
3. Put transport-neutral HTTP v1 schemas in `packages/protocol/src/http/v1`.
   Protocol may depend on TypeBox but never imports Fastify.
4. Put server plugins, handlers, lifecycle, configuration, and the composition root
   in the Main application. Handlers call application services; they contain no SQL,
   domain transition, Policy, or provider logic.

### Contract and error behavior

1. Mount the owner API under `/api/v1`. Every route declares request and response
   schemas with unknown properties rejected. Response schemas are mandatory and are
   the final field-disclosure boundary.
2. Unsafe create or command routes require a normalized `Idempotency-Key`. Durable
   application services store a canonical request fingerprint and exact response;
   conflicting reuse returns HTTP 409.
3. Return sanitized RFC 9457 problem documents with a stable OpenDelegate error code
   and correlation ID. Never return raw Ajv, SQL, filesystem, network URI, provider,
   stack, credential, or authentication details.
4. Generate a deterministic OpenAPI JSON artifact in CI from the same route schemas.
   Interactive documentation is not exposed on a production listener by default.
5. Apply a 256 KiB default JSON body limit. Artifact bytes and attachments use
   dedicated streaming flows with their own limits; they never transit an ordinary
   JSON command route.

### Listener and principal separation

1. The normal Main listener serves the built Admin assets and owner API on one
   origin. Production enables no CORS.
2. Development may allow one or more exact configured origins, sets
   `Vary: Origin`, and never combines credentials with `*`.
3. Owner cookie authentication, Device mutual authentication, Discord webhooks, and
   Artifact access use distinct encapsulated plugins and principal types. A
   credential accepted by one plugin cannot authorize another route tree.
4. Initial owner claim runs on the separate temporary loopback listener defined by
   ADR-0006. The normal listener does not register or forward that route.
5. `/health/live` is unauthenticated and reports only process liveness plus a stable
   build identifier. Detailed readiness and diagnostics require owner
   authentication or the local supervisor channel.
6. Artifact Gateway uses the separate origin and authorization boundary required by
   the product specification; it does not inherit Admin cookies, plugins, or
   storage.

### Browser and proxy security

1. Apply Helmet security headers and an explicit Admin Content Security Policy.
   Admin assets do not use inline script exceptions in production.
2. Non-loopback Admin traffic requires HTTPS. Cleartext external listeners fail
   configuration validation rather than weaken cookie flags.
3. Trust `Forwarded` and `X-Forwarded-*` only from exact configured proxy peer
   addresses. An untrusted peer cannot change scheme, client address, host, or
   owner-origin evaluation.
4. Validate allowed hosts and configured canonical origins before auth or command
   handling. Origin and CSRF enforcement follow ADR-0006.
5. Request logging is structured and allowlisted. Cookies, authorization,
   idempotency secrets, claim values, recovery codes, passwords, database URIs,
   request bodies on auth routes, and configured secret headers are always redacted.

### Lifecycle and observability

1. Assign or validate one correlation ID at ingress and carry it through application
   events, audit, outbox, Worker messages, and sanitized errors.
2. Start external listeners only after configuration validation, migration
   compatibility, persistence-generation validation, and singleton Main ownership
   succeed.
3. On shutdown, stop intake, mark readiness false, drain bounded in-flight requests,
   release claimed outbox work safely, close listeners, and then close storage.
4. Rate limiting at HTTP ingress is defense in depth. Durable authentication
   cooldown and finite Task budgets remain effective across restart.

## Alternatives considered

### Express

Rejected because schema validation, response serialization, encapsulation, and
in-process injection would require assembling a larger custom framework surface.

### Hono

Rejected because edge-runtime portability has no value for a Main process that ships
native database and password-hashing modules. Fastify provides the stronger
server-side schema lifecycle for this deployment.

### GraphQL

Rejected for the first milestone because typed command routes, idempotency, explicit
authorization, and small bounded projections are easier to audit as a versioned HTTP
API.

### Reuse application protocol envelopes directly as HTTP bodies

Rejected because browser requests, Device messages, and durable domain events have
different authentication and replay boundaries. They may share identifiers and
inner schemas without becoming interchangeable principals.

### Expose Swagger UI in production

Rejected because the OpenAPI artifact is useful for development and compatibility
review without adding a public interactive surface.

## Consequences

- Admin and API evolve from one runtime-validated contract and cannot accidentally
  serialize Worker Knowledge or Secret fields omitted by response schemas.
- Fastify and TypeBox versions must move as a tested compatibility set.
- Same-origin production deployment simplifies browser security; multiple owner
  hostnames may create separate host-scoped sessions.
- Reverse-proxy deployments require explicit peer and origin configuration.
- Artifact and Device endpoints remain separate security modules even when one Main
  process supervises them.

## Verification

- Fastify injection tests cover every status, request, header, response, auth, CSRF,
  idempotency, body-limit, and sanitized-error branch.
- The external app returns 404 for the owner claim path.
- Unknown fields are rejected, and response fixtures containing Secret or Knowledge
  fields cannot cross response serialization.
- Host, origin, proxy-header, cleartext, CORS, CSP, cookie, and log-redaction
  adversarial tests pass.
- Generated OpenAPI is deterministic and checked for drift in CI.
- Startup does not bind an external socket before migration, singleton, and
  generation gates pass.

## References

- `docs/PRODUCT_SPEC.md`, FR-15 and Main deployment
- `docs/IMPLEMENTATION_PLAN.md`, Phase 2
- [`ADR-0005`](0005-sql-portability-and-transaction-semantics.md)
- [`ADR-0006`](0006-owner-authentication-and-local-claim.md)
- [Fastify validation and serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)
- [Fastify type providers](https://fastify.dev/docs/latest/Reference/Type-Providers/)
- [RFC 9457: Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457.html)
- [Fetch Metadata](https://www.w3.org/TR/fetch-metadata/)
