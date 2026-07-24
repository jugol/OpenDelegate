import assert from "node:assert/strict";
import test from "node:test";

import { Capability, CapabilityId, DeviceId, DomainError } from "../src/index.ts";

const detectedEvidence = {
  kind: "probe" as const,
  source: "path-probe",
  observedAtMs: 1_000,
  detail: "codex executable was found",
};

test("a Capability records evidence-backed verification and immutable constraints", () => {
  const capability = Capability.create({
    id: CapabilityId.from("capability-codex"),
    deviceId: DeviceId.from("device-main"),
    name: "codex",
    state: "detected",
    evidence: [detectedEvidence],
    constraints: [{ key: "os", value: "macos" }],
    resourceRequirements: [{ resource: "agent-slot", units: 1 }],
  });

  capability.transition({
    state: "verification-pending",
    evidence: {
      kind: "verification",
      source: "smoke-test",
      observedAtMs: 2_000,
      detail: "safe smoke test started",
    },
  });
  capability.transition({
    state: "verified",
    version: "1.2.3",
    evidence: {
      kind: "verification",
      source: "smoke-test",
      observedAtMs: 2_100,
      detail: "structured response received",
    },
  });

  const snapshot = capability.snapshot;
  assert.equal(snapshot.state, "verified");
  assert.equal(snapshot.health, "healthy");
  assert.equal(snapshot.version, "1.2.3");
  assert.equal(snapshot.evidence.length, 3);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.evidence), true);
  assert.equal(Object.isFrozen(snapshot.evidence[0]), true);
  assert.equal(Object.isFrozen(snapshot.constraints), true);
  assert.equal(Object.isFrozen(snapshot.resourceRequirements), true);
});

test("a disabled Capability cannot become verified without being re-detected", () => {
  const capability = Capability.create({
    id: CapabilityId.from("capability-computer-use"),
    deviceId: DeviceId.from("device-linux"),
    name: "computer-use",
    state: "unavailable",
    evidence: [
      {
        kind: "observation",
        source: "desktop-probe",
        observedAtMs: 1_000,
        detail: "no interactive graphical session",
      },
    ],
  });
  capability.transition({
    state: "disabled",
    evidence: {
      kind: "owner-action",
      source: "owner",
      observedAtMs: 2_000,
      detail: "disabled during maintenance",
    },
  });

  assert.throws(
    () =>
      capability.transition({
        state: "verified",
        evidence: {
          kind: "verification",
          source: "agent-claim",
          observedAtMs: 3_000,
          detail: "untrusted verification claim",
        },
      }),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "CAPABILITY_TRANSITION_INVALID");
      return true;
    },
  );
  assert.equal(capability.state, "disabled");
});
