# `@opendelegate/device-identity`

This package owns the persistence-neutral Device identity and enrollment core
defined by ADR-0008.

## Trust boundaries

- Main creates one ECDSA P-256 instance CA. `DeviceIdentityRepository` persists
  only its public certificate and lifecycle metadata.
- `DeviceIdentitySecretStore` is the Main or Worker local key boundary. The
  included in-memory implementation creates non-exportable private keys and exists
  for tests; production adapters must use the platform Secret Store outside the
  source checkout.
- Enrollment Grant tokens contain 256 random bits. Main persists only their
  SHA-256 digests. `EnrollmentGrantSecret` redacts string, JSON, and Node
  inspection; transferring a token requires an explicit `reveal()` call.
- Workers generate their key and signed CSR locally. Main issues short-lived,
  client-auth-only certificates whose URI SAN is
  `urn:opendelegate:device:<DeviceId>`.
- Rotation issues a pending higher generation. The Worker proves possession of
  the new private key before Main activates it and starts the bounded overlap for
  the previous certificate.
- Revocation and certificate-generation status are checked by
  `validatePeerIdentity` in addition to the TLS stack's chain and
  proof-of-possession checks. A protocol envelope's claimed Device ID must match
  the certificate identity.

Network reachability, mTLS socket construction, active-channel closure, and
versioned WebSocket messages belong to the transport and Worker-channel layers.
This package supplies the identity decisions those layers must enforce.
