import assert from "node:assert/strict";
import test from "node:test";

import {
  TransportConfigurationError,
  TransportRoutesExhaustedError,
  createTransportResolver,
  type TransportProfile,
} from "../src/index.ts";

test("ordered routing connects through the first healthy authenticated endpoint", async () => {
  const probed: string[] = [];
  const connected: string[] = [];
  const resolver = createTransportResolver<string>({
    probeTtlMs: 5_000,
    clock: { now: () => 1_000 },
    probe: async ({ deviceId, endpoint }) => {
      probed.push(`${deviceId}:${endpoint.endpointId}`);
      return {
        healthy: true,
        authenticated: true,
        peerDeviceId: deviceId,
      };
    },
    connect: async ({ deviceId, endpoint }) => {
      connected.push(`${deviceId}:${endpoint.endpointId}`);
      return {
        connected: true,
        authenticated: true,
        peerDeviceId: deviceId,
        connection: `connection:${endpoint.endpointId}`,
      };
    },
  });
  const profile: TransportProfile = {
    deviceId: "device-studio",
    endpoints: [
      {
        endpointId: "route-private-wss",
        label: "Preferred private route",
        kind: "wss",
        url: "wss://studio.private.test/control",
        credentialRef: "secret://transport/studio",
      },
      {
        endpointId: "route-lan-https",
        label: "LAN fallback",
        kind: "https",
        url: "https://studio.lan.test/control",
        credentialRef: "secret://transport/studio",
      },
    ],
  };

  const result = await resolver.connect(profile);

  assert.deepEqual(probed, ["device-studio:route-private-wss"]);
  assert.deepEqual(connected, ["device-studio:route-private-wss"]);
  assert.deepEqual(result, {
    deviceId: "device-studio",
    endpointId: "route-private-wss",
    kind: "wss",
    connection: "connection:route-private-wss",
    attemptTrace: [
      {
        endpointId: "route-private-wss",
        label: "Preferred private route",
        kind: "wss",
        probeSource: "live",
        outcome: "connected",
      },
    ],
  });
});

test("routing skips incompatible endpoint kinds without probing them", async () => {
  const probed: string[] = [];
  const resolver = createTransportResolver<string>({
    probeTtlMs: 5_000,
    clock: { now: () => 1_000 },
    probe: async ({ deviceId, endpoint }) => {
      probed.push(endpoint.endpointId);
      return {
        healthy: true,
        authenticated: true,
        peerDeviceId: deviceId,
      };
    },
    connect: async ({ deviceId, endpoint }) => ({
      connected: true,
      authenticated: true,
      peerDeviceId: deviceId,
      connection: `connection:${endpoint.endpointId}`,
    }),
  });
  const profile: TransportProfile = {
    deviceId: "device-nas",
    endpoints: [
      {
        endpointId: "route-wss",
        label: "Persistent WSS",
        kind: "wss",
        url: "wss://nas.private.test/control",
        credentialRef: "secret://transport/nas",
      },
      {
        endpointId: "route-https",
        label: "HTTPS polling",
        kind: "https",
        url: "https://nas.private.test/control",
        credentialRef: "secret://transport/nas",
      },
    ],
  };

  const result = await resolver.connect(profile, {
    acceptedKinds: ["https"],
  });

  assert.deepEqual(probed, ["route-https"]);
  assert.deepEqual(result.attemptTrace, [
    {
      endpointId: "route-wss",
      label: "Persistent WSS",
      kind: "wss",
      probeSource: "not-run",
      outcome: "skipped-incompatible",
    },
    {
      endpointId: "route-https",
      label: "HTTPS polling",
      kind: "https",
      probeSource: "live",
      outcome: "connected",
    },
  ]);
});

test("healthy probe results are reused only within their TTL", async () => {
  let now = 1_000;
  let probeCount = 0;
  let connectCount = 0;
  const resolver = createTransportResolver<string>({
    probeTtlMs: 5_000,
    clock: { now: () => now },
    probe: async ({ deviceId }) => {
      probeCount += 1;
      return {
        healthy: true,
        authenticated: true,
        peerDeviceId: deviceId,
      };
    },
    connect: async ({ deviceId, endpoint }) => {
      connectCount += 1;
      return {
        connected: true,
        authenticated: true,
        peerDeviceId: deviceId,
        connection: `connection:${endpoint.endpointId}:${connectCount}`,
      };
    },
  });
  const profile: TransportProfile = {
    deviceId: "device-laptop",
    endpoints: [
      {
        endpointId: "route-https",
        label: "Private HTTPS",
        kind: "https",
        url: "https://laptop.private.test/control",
        credentialRef: "secret://transport/laptop",
      },
    ],
  };

  const first = await resolver.connect(profile);
  now = 5_999;
  const cached = await resolver.connect(profile);
  now = 6_000;
  const expired = await resolver.connect(profile);

  assert.equal(probeCount, 2);
  assert.equal(connectCount, 3);
  assert.equal(first.attemptTrace[0]?.probeSource, "live");
  assert.equal(cached.attemptTrace[0]?.probeSource, "cache");
  assert.equal(expired.attemptTrace[0]?.probeSource, "live");
});

test("probe caches and profiles remain independent per Device", async () => {
  const probes: string[] = [];
  const resolver = createTransportResolver<string>({
    probeTtlMs: 60_000,
    clock: { now: () => 10_000 },
    probe: async ({ deviceId }) => {
      probes.push(deviceId);
      return {
        healthy: true,
        authenticated: true,
        peerDeviceId: deviceId,
      };
    },
    connect: async ({ deviceId }) => ({
      connected: true,
      authenticated: true,
      peerDeviceId: deviceId,
      connection: `connection:${deviceId}`,
    }),
  });
  const endpoint = {
    endpointId: "preferred",
    label: "Owner-configured private path",
    kind: "https" as const,
    url: "https://main.private.test/control",
    credentialRef: "secret://transport/device",
  };

  const studio = await resolver.connect({
    deviceId: "device-studio",
    endpoints: [endpoint],
  });
  const nas = await resolver.connect({
    deviceId: "device-nas",
    endpoints: [endpoint],
  });

  assert.deepEqual(probes, ["device-studio", "device-nas"]);
  assert.equal(studio.connection, "connection:device-studio");
  assert.equal(nas.connection, "connection:device-nas");
});

test("a connect failure falls through to the next ordered route", async () => {
  const resolver = createTransportResolver<string>({
    probeTtlMs: 5_000,
    clock: { now: () => 1_000 },
    probe: async ({ deviceId }) => ({
      healthy: true,
      authenticated: true,
      peerDeviceId: deviceId,
    }),
    connect: async ({ deviceId, endpoint }) => {
      if (endpoint.endpointId === "route-primary") {
        return {
          connected: false,
          diagnostic: { reason: "connection refused" },
        };
      }
      return {
        connected: true,
        authenticated: true,
        peerDeviceId: deviceId,
        connection: `connection:${endpoint.endpointId}`,
      };
    },
  });
  const profile: TransportProfile = {
    deviceId: "device-render",
    endpoints: [
      {
        endpointId: "route-primary",
        label: "Primary private route",
        kind: "wss",
        url: "wss://render.primary.test/control",
        credentialRef: "secret://transport/render",
      },
      {
        endpointId: "route-fallback",
        label: "Fallback private route",
        kind: "https",
        url: "https://render.fallback.test/control",
        credentialRef: "secret://transport/render",
      },
    ],
  };

  const result = await resolver.connect(profile);

  assert.equal(result.endpointId, "route-fallback");
  assert.deepEqual(result.attemptTrace, [
    {
      endpointId: "route-primary",
      label: "Primary private route",
      kind: "wss",
      probeSource: "live",
      outcome: "connect-failed",
      diagnostic: { code: "TRANSPORT_BOUNDARY_ERROR" },
    },
    {
      endpointId: "route-fallback",
      label: "Fallback private route",
      kind: "https",
      probeSource: "live",
      outcome: "connected",
    },
  ]);
});

test("full route exhaustion returns typed redacted diagnostics for Agent escalation", async () => {
  const resolver = createTransportResolver<string>({
    probeTtlMs: 5_000,
    clock: { now: () => 1_000 },
    probe: async ({ deviceId, endpoint }) =>
      endpoint.endpointId === "route-probe-fails"
        ? {
            healthy: false,
            authenticated: false,
            diagnostic: {
              reason: "timeout",
              token: "probe-token-value",
              nested: { password: "probe-password-value" },
              endpoint:
                "https://probe-user:probe-pass@probe.test/status?token=url-token-value&region=kr",
            },
          }
        : {
            healthy: true,
            authenticated: true,
            peerDeviceId: deviceId,
          },
    connect: async () => ({
      connected: false,
      diagnostic: {
        reason: "connection refused",
        authorization: "Bearer connector-token-value",
      },
    }),
  });
  const profile: TransportProfile = {
    deviceId: "device-offline",
    endpoints: [
      {
        endpointId: "route-probe-fails",
        label: "Preferred private route",
        kind: "wss",
        url: "wss://offline.primary.test/control",
        credentialRef: "secret://transport/offline",
      },
      {
        endpointId: "route-connect-fails",
        label: "Fallback private route",
        kind: "https",
        url: "https://offline.fallback.test/control",
        credentialRef: "secret://transport/offline",
      },
    ],
  };

  await assert.rejects(
    () => resolver.connect(profile),
    (error: unknown) => {
      assert.equal(error instanceof TransportRoutesExhaustedError, true);
      const exhausted = error as TransportRoutesExhaustedError;
      assert.equal(exhausted.code, "TRANSPORT_ROUTES_EXHAUSTED");
      assert.equal(exhausted.deviceId, "device-offline");
      assert.equal(exhausted.agentEscalationRecommended, true);
      assert.deepEqual(exhausted.diagnostics, {
        deviceId: "device-offline",
        attempts: [
          {
            endpointId: "route-probe-fails",
            label: "Preferred private route",
            kind: "wss",
            probeSource: "live",
            outcome: "probe-unhealthy",
            diagnostic: {
              code: "TRANSPORT_BOUNDARY_ERROR",
            },
          },
          {
            endpointId: "route-connect-fails",
            label: "Fallback private route",
            kind: "https",
            probeSource: "live",
            outcome: "connect-failed",
            diagnostic: {
              code: "TRANSPORT_BOUNDARY_ERROR",
            },
          },
        ],
      });
      const serialized = JSON.stringify(exhausted.diagnostics);
      assert.equal(serialized.includes("probe-token-value"), false);
      assert.equal(serialized.includes("probe-password-value"), false);
      assert.equal(serialized.includes("connector-token-value"), false);
      assert.equal(serialized.includes("probe-user"), false);
      assert.equal(serialized.includes("probe-pass"), false);
      assert.equal(serialized.includes("url-token-value"), false);
      return true;
    },
  );
});

test("identity and authentication rejection never select an unauthenticated route", async () => {
  const connectCalls: string[] = [];
  const resolver = createTransportResolver<string>({
    probeTtlMs: 5_000,
    clock: { now: () => 1_000 },
    probe: async ({ deviceId, endpoint }) => {
      if (endpoint.endpointId === "route-probe-unauthenticated") {
        return {
          healthy: true,
          authenticated: false,
          diagnostic: {
            reason: "device credential rejected",
            authorization: "Bearer rejected-probe-token",
          },
        };
      }
      if (endpoint.endpointId === "route-wrong-identity") {
        return {
          healthy: true,
          authenticated: true,
          peerDeviceId: "device-imposter",
        };
      }
      return {
        healthy: true,
        authenticated: true,
        peerDeviceId: deviceId,
      };
    },
    connect: async ({ endpoint }) => {
      connectCalls.push(endpoint.endpointId);
      return {
        connected: true,
        authenticated: false,
        connection: "must-not-be-selected",
      };
    },
  });
  const profile: TransportProfile = {
    deviceId: "device-secure",
    endpoints: [
      {
        endpointId: "route-probe-unauthenticated",
        label: "Rejected credential",
        kind: "wss",
        url: "wss://secure.primary.test/control",
        credentialRef: "secret://transport/secure",
      },
      {
        endpointId: "route-wrong-identity",
        label: "Unexpected peer",
        kind: "https",
        url: "https://secure.secondary.test/control",
        credentialRef: "secret://transport/secure",
      },
      {
        endpointId: "route-connect-unauthenticated",
        label: "Unauthenticated connector",
        kind: "https",
        url: "https://secure.fallback.test/control",
        credentialRef: "secret://transport/secure",
      },
    ],
  };

  await assert.rejects(
    () => resolver.connect(profile),
    (error: unknown) => {
      assert.equal(error instanceof TransportRoutesExhaustedError, true);
      const exhausted = error as TransportRoutesExhaustedError;
      assert.deepEqual(exhausted.diagnostics.attempts, [
        {
          endpointId: "route-probe-unauthenticated",
          label: "Rejected credential",
          kind: "wss",
          probeSource: "live",
          outcome: "authentication-rejected",
          failureStage: "probe",
          diagnostic: {
            code: "TRANSPORT_BOUNDARY_ERROR",
          },
        },
        {
          endpointId: "route-wrong-identity",
          label: "Unexpected peer",
          kind: "https",
          probeSource: "live",
          outcome: "identity-rejected",
          failureStage: "probe",
          diagnostic: {
            code: "PEER_IDENTITY_MISMATCH",
            reason: "Authenticated peer identity did not match the target Device.",
          },
        },
        {
          endpointId: "route-connect-unauthenticated",
          label: "Unauthenticated connector",
          kind: "https",
          probeSource: "live",
          outcome: "authentication-rejected",
          failureStage: "connect",
        },
      ]);
      return true;
    },
  );
  assert.deepEqual(connectCalls, ["route-connect-unauthenticated"]);
});

test("a thrown connector failure exposes only a stable generic diagnostic and fails over", async () => {
  const resolver = createTransportResolver<string>({
    probeTtlMs: 5_000,
    clock: { now: () => 1_000 },
    probe: async ({ deviceId }) => ({
      healthy: true,
      authenticated: true,
      peerDeviceId: deviceId,
    }),
    connect: async ({ deviceId, endpoint }) => {
      if (endpoint.endpointId === "route-throws") {
        throw new Error("socket failed token=connector-secret");
      }
      return {
        connected: true,
        authenticated: true,
        peerDeviceId: deviceId,
        connection: "fallback-connection",
      };
    },
  });
  const profile: TransportProfile = {
    deviceId: "device-failover",
    endpoints: [
      {
        endpointId: "route-throws",
        label: "Throwing route",
        kind: "wss",
        url: "wss://failover.primary.test/control",
        credentialRef: "secret://transport/failover",
      },
      {
        endpointId: "route-works",
        label: "Working fallback",
        kind: "https",
        url: "https://failover.secondary.test/control",
        credentialRef: "secret://transport/failover",
      },
    ],
  };

  const result = await resolver.connect(profile);

  assert.equal(result.endpointId, "route-works");
  assert.deepEqual(result.attemptTrace[0], {
    endpointId: "route-throws",
    label: "Throwing route",
    kind: "wss",
    probeSource: "live",
    outcome: "connect-failed",
    diagnostic: {
      code: "TRANSPORT_BOUNDARY_ERROR",
    },
  });
  assert.equal(JSON.stringify(result.attemptTrace).includes("socket failed"), false);
});

test("a thrown probe exposes only a stable generic diagnostic and fails over", async () => {
  const resolver = createTransportResolver<string>({
    probeTtlMs: 5_000,
    clock: { now: () => 1_000 },
    probe: async ({ deviceId, endpoint }) => {
      if (endpoint.endpointId === "route-probe-throws") {
        throw new Error("probe failed password=probe-secret");
      }
      return {
        healthy: true,
        authenticated: true,
        peerDeviceId: deviceId,
      };
    },
    connect: async ({ deviceId }) => ({
      connected: true,
      authenticated: true,
      peerDeviceId: deviceId,
      connection: "fallback-connection",
    }),
  });
  const profile: TransportProfile = {
    deviceId: "device-probe-failover",
    endpoints: [
      {
        endpointId: "route-probe-throws",
        label: "Throwing probe",
        kind: "wss",
        url: "wss://probe.primary.test/control",
        credentialRef: "secret://transport/probe-failover",
      },
      {
        endpointId: "route-probe-works",
        label: "Healthy fallback",
        kind: "https",
        url: "https://probe.secondary.test/control",
        credentialRef: "secret://transport/probe-failover",
      },
    ],
  };

  const result = await resolver.connect(profile);

  assert.equal(result.endpointId, "route-probe-works");
  assert.deepEqual(result.attemptTrace[0], {
    endpointId: "route-probe-throws",
    label: "Throwing probe",
    kind: "wss",
    probeSource: "live",
    outcome: "probe-unhealthy",
    diagnostic: {
      code: "TRANSPORT_BOUNDARY_ERROR",
    },
  });
  assert.equal(JSON.stringify(result.attemptTrace).includes("probe failed"), false);
});

test("diagnostics retain only allowlisted structured fields and never provider free text", async () => {
  const resolver = createTransportResolver<string>({
    probeTtlMs: 5_000,
    clock: { now: () => 1_000 },
    probe: async () => ({
      healthy: false,
      authenticated: false,
      diagnostic: {
        reason: "timeout token=reason-secret",
        code: "ETIMEDOUT",
        status: 504,
        retryable: true,
        path: "C:\\Users\\owner\\private\\transport.json",
        topology: {
          host: "nas.internal.example",
          peers: ["device-main", "device-worker"],
        },
        sparkle: "oddly-named-credential-value",
        unknown: "must-not-escape",
        endpoint: "https://owner:password@private.example/control",
        nested: {
          reason: "nested details are not an approved top-level diagnostic field",
        },
      },
    }),
    connect: async () => {
      throw new Error("connect must not run");
    },
  });
  const profile: TransportProfile = {
    deviceId: "device-diagnostic-boundary",
    endpoints: [
      {
        endpointId: "route-private",
        label: "Private route",
        kind: "https",
        url: "https://private.example/control",
        credentialRef: "secret://transport/private",
      },
    ],
  };

  await assert.rejects(
    () => resolver.connect(profile),
    (error: unknown) => {
      assert.equal(error instanceof TransportRoutesExhaustedError, true);
      const exhausted = error as TransportRoutesExhaustedError;
      assert.deepEqual(exhausted.diagnostics.attempts[0]?.diagnostic, {
        code: "ETIMEDOUT",
        retryable: true,
        status: 504,
      });

      const serialized = JSON.stringify(exhausted.diagnostics);
      for (const forbidden of [
        "C:\\\\Users\\\\owner",
        "nas.internal.example",
        "device-worker",
        "oddly-named-credential-value",
        "must-not-escape",
        "private.example",
        "nested details",
        "timeout token",
      ]) {
        assert.equal(serialized.includes(forbidden), false);
      }
      return true;
    },
  );
});

test("rejects invalid probe TTL configuration when the resolver is created", () => {
  for (const probeTtlMs of [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(
      () =>
        createTransportResolver({
          probeTtlMs,
          clock: { now: () => 1_000 },
          probe: async () => ({
            healthy: true,
            authenticated: true,
          }),
          connect: async () => ({ connected: false }),
        }),
      (error: unknown) => {
        assert.ok(error instanceof TransportConfigurationError);
        assert.equal(error.code, "TRANSPORT_PROBE_TTL_INVALID");
        return true;
      },
    );
  }
});

test("rejects an invalid clock before probing or connecting", async () => {
  let probeCalls = 0;
  let connectCalls = 0;
  const resolver = createTransportResolver({
    probeTtlMs: 5_000,
    clock: { now: () => Number.NaN },
    probe: async () => {
      probeCalls += 1;
      return { healthy: true, authenticated: true };
    },
    connect: async () => {
      connectCalls += 1;
      return { connected: false };
    },
  });

  await assert.rejects(
    () =>
      resolver.connect({
        deviceId: "device-clock",
        endpoints: [
          {
            endpointId: "route-clock",
            label: "Clock route",
            kind: "https",
            url: "https://clock.private.test/control",
            credentialRef: "secret://transport/clock",
          },
        ],
      }),
    (error: unknown) => {
      assert.ok(error instanceof TransportConfigurationError);
      assert.equal(error.code, "TRANSPORT_CLOCK_INVALID");
      return true;
    },
  );
  assert.equal(probeCalls, 0);
  assert.equal(connectCalls, 0);
});

test("rejects invalid profile identifiers, duplicate endpoints, and unsafe URLs before I/O", async () => {
  let boundaryCalls = 0;
  const resolver = createTransportResolver({
    probeTtlMs: 5_000,
    clock: { now: () => 1_000 },
    probe: async () => {
      boundaryCalls += 1;
      return { healthy: true, authenticated: true };
    },
    connect: async () => {
      boundaryCalls += 1;
      return { connected: false };
    },
  });
  const validEndpoint = {
    endpointId: "route-private",
    label: "Private route",
    kind: "https" as const,
    url: "https://device.private.test/control",
    credentialRef: "secret://transport/device",
  };
  const invalidProfiles: TransportProfile[] = [
    { deviceId: " ", endpoints: [validEndpoint] },
    {
      deviceId: "device-profile",
      endpoints: [{ ...validEndpoint, endpointId: " route-private" }],
    },
    {
      deviceId: "device-profile",
      endpoints: [{ ...validEndpoint, credentialRef: "secret\nreference" }],
    },
    {
      deviceId: "device-profile",
      endpoints: [validEndpoint, { ...validEndpoint, url: "https://other.test/control" }],
    },
    {
      deviceId: "device-profile",
      endpoints: [{ ...validEndpoint, url: "http://device.private.test/control" }],
    },
    {
      deviceId: "device-profile",
      endpoints: [
        {
          ...validEndpoint,
          kind: "wss",
          url: "https://device.private.test/control",
        },
      ],
    },
    {
      deviceId: "device-profile",
      endpoints: [
        {
          ...validEndpoint,
          url: "https://owner:password@device.private.test/control",
        },
      ],
    },
    {
      deviceId: "device-profile",
      endpoints: [
        {
          ...validEndpoint,
          url: "https://device.private.test/control?token=secret-value",
        },
      ],
    },
    {
      deviceId: "device-profile",
      endpoints: [
        {
          ...validEndpoint,
          url: "https://device.private.test/control?region=kr",
        },
      ],
    },
    {
      deviceId: "device-profile",
      endpoints: [{ ...validEndpoint, url: "https://device.private.test/control#unsafe" }],
    },
  ];

  for (const profile of invalidProfiles) {
    await assert.rejects(
      () => resolver.connect(profile),
      (error: unknown) => {
        assert.ok(error instanceof TransportConfigurationError);
        assert.equal(error.code, "TRANSPORT_PROFILE_INVALID");
        return true;
      },
    );
  }
  assert.equal(boundaryCalls, 0);
});

test("credential-like URL query parameters never reach transport boundaries", async () => {
  let boundaryCalls = 0;
  const resolver = createTransportResolver({
    probeTtlMs: 5_000,
    clock: { now: () => 1_000 },
    probe: async () => {
      boundaryCalls += 1;
      return { healthy: true, authenticated: true };
    },
    connect: async () => {
      boundaryCalls += 1;
      return { connected: false };
    },
  });

  for (const parameter of ["authorization", "auth", "credential", "key", "signature"]) {
    await assert.rejects(
      () =>
        resolver.connect({
          deviceId: "device-query-boundary",
          endpoints: [
            {
              endpointId: `route-${parameter}`,
              label: "Unsafe query route",
              kind: "https",
              url: `https://device.private.test/control?${parameter}=must-not-reach-probe`,
              credentialRef: "secret://transport/device",
            },
          ],
        }),
      (error: unknown) => {
        assert.ok(error instanceof TransportConfigurationError);
        assert.equal(error.code, "TRANSPORT_PROFILE_INVALID");
        return true;
      },
    );
  }

  assert.equal(boundaryCalls, 0);
});

test("credential assignments in an endpoint URL path never reach transport boundaries", async () => {
  let boundaryCalls = 0;
  const resolver = createTransportResolver({
    probeTtlMs: 5_000,
    clock: { now: () => 1_000 },
    probe: async () => {
      boundaryCalls += 1;
      return { healthy: true, authenticated: true };
    },
    connect: async () => {
      boundaryCalls += 1;
      return { connected: false };
    },
  });

  await assert.rejects(
    () =>
      resolver.connect({
        deviceId: "device-path-boundary",
        endpoints: [
          {
            endpointId: "route-path-credential",
            label: "Unsafe path route",
            kind: "https",
            url: ["https://device.private.test/api/token=", "super-secret-value"].join(""),
            credentialRef: "secret://transport/device",
          },
        ],
      }),
    (error: unknown) => {
      assert.ok(error instanceof TransportConfigurationError);
      assert.equal(error.code, "TRANSPORT_PROFILE_INVALID");
      return true;
    },
  );
  assert.equal(boundaryCalls, 0);
});

test("percent-encoded credential assignments in URL paths are rejected before I/O", async () => {
  let boundaryCalls = 0;
  const resolver = createTransportResolver({
    probeTtlMs: 5_000,
    clock: { now: () => 1_000 },
    probe: async () => {
      boundaryCalls += 1;
      return { healthy: true, authenticated: true };
    },
    connect: async () => {
      boundaryCalls += 1;
      return { connected: false };
    },
  });

  const unsafePaths = [
    ["token%3D", "super-secret-value"].join(""),
    ["x-api-key=", "raw-secret-value"].join(""),
    ["x-api-key%3D", "raw-secret-value"].join(""),
    ["refresh_token=", "raw-secret-value"].join(""),
    ["refresh_token%3D", "raw-secret-value"].join(""),
    ["x-auth-token=", "raw-secret-value"].join(""),
    ["private_token=", "raw-secret-value"].join(""),
    ["proxy-authorization%3D", "raw-secret-value"].join(""),
    ["%20token%3D", "raw-secret-value"].join(""),
  ];
  for (const [index, path] of unsafePaths.entries()) {
    await assert.rejects(
      () =>
        resolver.connect({
          deviceId: "device-encoded-path-boundary",
          endpoints: [
            {
              endpointId: `route-encoded-path-credential-${String(index)}`,
              label: "Unsafe encoded path route",
              kind: "https",
              url: `https://device.private.test/api/${path}`,
              credentialRef: "secret://transport/device",
            },
          ],
        }),
      (error: unknown) => {
        assert.ok(error instanceof TransportConfigurationError);
        assert.equal(error.code, "TRANSPORT_PROFILE_INVALID");
        return true;
      },
    );
  }
  assert.equal(boundaryCalls, 0);
});

test("endpoint substitution under the same ID always performs a fresh authenticated probe", async () => {
  const probedIdentities: string[] = [];
  const resolver = createTransportResolver<string>({
    probeTtlMs: 60_000,
    clock: { now: () => 1_000 },
    probe: async ({ deviceId, endpoint }) => {
      probedIdentities.push(`${endpoint.kind}|${endpoint.url}|${endpoint.credentialRef}`);
      return {
        healthy: true,
        authenticated: true,
        peerDeviceId: deviceId,
      };
    },
    connect: async ({ deviceId, endpoint }) => ({
      connected: true,
      authenticated: true,
      peerDeviceId: deviceId,
      connection: endpoint.url,
    }),
  });
  const base: TransportProfile = {
    deviceId: "device-substitution",
    endpoints: [
      {
        endpointId: "stable-id",
        label: "Private route",
        kind: "https",
        url: "https://first.private.test/control",
        credentialRef: "secret://transport/first",
      },
    ],
  };

  await resolver.connect(base);
  await resolver.connect({
    deviceId: base.deviceId,
    endpoints: [
      {
        ...base.endpoints[0]!,
        url: "https://second.private.test/control",
        credentialRef: "secret://transport/second",
      },
    ],
  });
  await resolver.connect({
    deviceId: base.deviceId,
    endpoints: [
      {
        ...base.endpoints[0]!,
        kind: "wss",
        url: "wss://second.private.test/control",
      },
    ],
  });

  assert.deepEqual(probedIdentities, [
    "https|https://first.private.test/control|secret://transport/first",
    "https|https://second.private.test/control|secret://transport/second",
    "wss|wss://second.private.test/control|secret://transport/first",
  ]);
});

test("resolution and exhaustion diagnostics are deeply immutable", async () => {
  const successResolver = createTransportResolver<string>({
    probeTtlMs: 5_000,
    clock: { now: () => 1_000 },
    probe: async ({ deviceId }) => ({
      healthy: true,
      authenticated: true,
      peerDeviceId: deviceId,
    }),
    connect: async ({ deviceId }) => ({
      connected: true,
      authenticated: true,
      peerDeviceId: deviceId,
      connection: "connection",
    }),
  });
  const profile: TransportProfile = {
    deviceId: "device-immutable",
    endpoints: [
      {
        endpointId: "route-immutable",
        label: "Immutable route",
        kind: "https",
        url: "https://immutable.private.test/control",
        credentialRef: "secret://transport/immutable",
      },
    ],
  };
  const resolution = await successResolver.connect(profile);
  assert.equal(Object.isFrozen(resolution), true);
  assert.equal(Object.isFrozen(resolution.attemptTrace), true);
  assert.equal(Object.isFrozen(resolution.attemptTrace[0]), true);

  const failureResolver = createTransportResolver({
    probeTtlMs: 5_000,
    clock: { now: () => 1_000 },
    probe: async () => ({
      healthy: false,
      authenticated: false,
      diagnostic: { reason: "offline" },
    }),
    connect: async () => ({ connected: false }),
  });
  await assert.rejects(
    () => failureResolver.connect(profile),
    (error: unknown) => {
      assert.ok(error instanceof TransportRoutesExhaustedError);
      assert.equal(Object.isFrozen(error.diagnostics), true);
      assert.equal(Object.isFrozen(error.diagnostics.attempts), true);
      assert.equal(Object.isFrozen(error.diagnostics.attempts[0]), true);
      assert.equal(Object.isFrozen(error.diagnostics.attempts[0]?.diagnostic), true);
      return true;
    },
  );
});
