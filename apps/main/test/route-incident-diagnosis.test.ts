import assert from "node:assert/strict";
import test from "node:test";

import { type AgentAdapter, type AgentRunHandle } from "@opendelegate/agent-adapters";
import {
  InMemoryEventStore,
  type AppendEvents,
  type EventStore,
  type StoredEvent,
} from "@opendelegate/event-store";
import { createWorkerRouteIncident } from "@opendelegate/device-channel";

import {
  AgentBackedRouteIncidentDiagnostic,
  MainRouteIncidentDiagnosisService,
  type RouteIncidentDiagnosisResult,
  type RouteIncidentDiagnosticAgentPort,
} from "../src/route-incident-diagnosis.ts";

const eventClock = {
  now: () => "2026-07-25T00:00:00.000Z",
};

function incident(occurrenceSeed: string, endpointUrl = "wss://main-private.example.test/device") {
  return createWorkerRouteIncident({
    profile: {
      deviceId: "device-main",
      endpoints: [
        {
          endpointId: "route-private",
          label: "Private Main route",
          kind: "wss",
          url: endpointUrl,
          credentialRef: "secret://device-certificate",
        },
      ],
    },
    attempts: [
      {
        endpointId: "route-private",
        label: "Private Main route",
        kind: "wss",
        probeSource: "live",
        outcome: "connect-failed",
        failureStage: "connect",
        diagnostic: {
          code: "ETIMEDOUT",
          retryable: true,
          status: 503,
          token: "must-not-cross",
          stack: "/private/route.ts:10",
        },
      },
    ],
    occurrenceSeed,
  });
}

function request(routeIncident = incident("occurrence-1"), delivery = 1) {
  return {
    authenticatedDeviceId: "device-worker-1",
    requestMessageId: `route-incident-message-${delivery}`,
    idempotencyKey: `route-incident-delivery-${delivery}`,
    incident: routeIncident,
    receivedAtMs: 1_000 + delivery,
  };
}

class CountingAgent implements RouteIncidentDiagnosticAgentPort {
  public calls = 0;

  public async diagnose(input: Parameters<RouteIncidentDiagnosticAgentPort["diagnose"]>[0]) {
    this.calls += 1;
    assert.deepEqual(input.authority, {
      tools: "denied",
      osMutation: "denied",
      networkMutation: "denied",
    });
    assert.equal(input.limits.maximumTurns, 1);
    const serialized = JSON.stringify(input);
    for (const forbidden of [
      "main-private",
      "device-certificate",
      "must-not-cross",
      "/private/",
      "503",
      "retryable",
    ]) {
      assert.equal(serialized.includes(forbidden), false, `leaked ${forbidden}`);
    }
    return {
      recommendation: "Review the private-network reachability before changing configuration.",
      ownerQuestion: "Was the private-network path expected to be available during this incident?",
    };
  }
}

test("Main persists and diagnoses one occurrence once across delivery replay and service restart", async () => {
  const store = new InMemoryEventStore({ clock: eventClock });
  const agent = new CountingAgent();
  const notifications = new Map<string, RouteIncidentDiagnosisResult>();
  const createService = () =>
    new MainRouteIncidentDiagnosisService({
      eventStore: store,
      agent,
      notifications: {
        async publish(input) {
          notifications.set(input.idempotencyKey, input.result);
        },
      },
    });

  const first = await createService().handle(request());
  assert.equal(first.disposition, "diagnosed");
  assert.equal(first.result.source, "agent");
  assert.equal(agent.calls, 1);

  const replay = await createService().handle(request(incident("occurrence-1"), 2));
  assert.equal(replay.disposition, "duplicate");
  assert.deepEqual(replay.result, first.result);
  assert.equal(agent.calls, 1);
  assert.equal(notifications.size, 1);
});

test("a resolved recurrence and a changed Transport Profile each create a new diagnosis", async () => {
  const store = new InMemoryEventStore({ clock: eventClock });
  const agent = new CountingAgent();
  const service = new MainRouteIncidentDiagnosisService({ eventStore: store, agent });
  const original = incident("occurrence-1");
  const recurrence = incident("occurrence-2");
  const changedProfile = incident("occurrence-3", "wss://main-tailnet.example.test/device");

  await service.handle(request(original, 1));
  await service.handle(request(recurrence, 2));
  await service.handle(request(changedProfile, 3));

  assert.equal(original.fingerprint, recurrence.fingerprint);
  assert.notEqual(original.incidentId, recurrence.incidentId);
  assert.notEqual(original.profileRevision, changedProfile.profileRevision);
  assert.notEqual(original.fingerprint, changedProfile.fingerprint);
  assert.equal(agent.calls, 3);
});

test("an unavailable or invalid Agent produces the deterministic targeted owner question", async () => {
  const unavailable = new MainRouteIncidentDiagnosisService({
    eventStore: new InMemoryEventStore({ clock: eventClock }),
  });
  const unavailableReceipt = await unavailable.handle(request());
  assert.equal(unavailableReceipt.result.source, "deterministic-fallback");
  assert.equal(unavailableReceipt.result.reasonCode, "AGENT_UNAVAILABLE");
  assert.match(unavailableReceipt.result.ownerQuestion, /\?$/u);
  assert.equal(unavailableReceipt.result.recommendation.includes("ETIMEDOUT"), true);

  const invalid = new MainRouteIncidentDiagnosisService({
    eventStore: new InMemoryEventStore({ clock: eventClock }),
    agent: {
      async diagnose() {
        return {
          recommendation: "Try a change.",
          ownerQuestion: "Should I reconfigure the firewall?",
          command: "netsh advfirewall set allprofiles state off",
        };
      },
    },
  });
  const invalidReceipt = await invalid.handle(request(incident("invalid-agent")));
  assert.equal(invalidReceipt.result.source, "deterministic-fallback");
  assert.equal(JSON.stringify(invalidReceipt).includes("netsh"), false);
});

test("a crash after the Agent claim never repeats the external turn and recovers with fallback", async () => {
  const backing = new InMemoryEventStore({ clock: eventClock });
  const store = new FailFirstCompletionEventStore(backing);
  const agent = new CountingAgent();
  const service = new MainRouteIncidentDiagnosisService({ eventStore: store, agent });
  await assert.rejects(() => service.handle(request()), /synthetic completion crash/u);
  assert.equal(agent.calls, 1);

  const restarted = new MainRouteIncidentDiagnosisService({ eventStore: store, agent });
  const receipt = await restarted.handle(request(incident("occurrence-1"), 2));
  assert.equal(receipt.disposition, "recovered");
  assert.equal(receipt.result.reasonCode, "DIAGNOSIS_INTERRUPTED");
  assert.equal(agent.calls, 1);
});

test("the Agent-backed diagnosis is one read-only deny-mode turn and rejects tool requests", async () => {
  let cancelCount = 0;
  const adapter: AgentAdapter = {
    adapterId: "fake-diagnostic-agent",
    provider: "generic",
    probe: () => Promise.reject(new Error("not used")),
    resume: () => Promise.reject(new Error("not used")),
    async start(startRequest) {
      assert.equal(startRequest.sandbox, "read-only");
      assert.equal(startRequest.permissions.mode, "deny");
      assert.deepEqual(startRequest.permissions.allowedTools, []);
      assert.equal(startRequest.toolServers, undefined);
      const handle: AgentRunHandle = {
        events: (async function* () {
          yield {
            sequence: 1,
            observedAt: "2026-07-25T00:00:00.000Z",
            type: "tool_request" as const,
            toolName: "shell",
          };
        })(),
        result: Promise.resolve({
          status: "succeeded",
          finalText: JSON.stringify({
            recommendation: "No mutation.",
            ownerQuestion: "Is the path expected to be reachable?",
          }),
        }),
        async cancel() {
          cancelCount += 1;
        },
      };
      return handle;
    },
  };
  const diagnostic = new AgentBackedRouteIncidentDiagnostic({
    adapter,
    deviceId: "device-main",
    workspace: {
      workspaceId: "workspace-route-diagnosis",
      cwd: process.cwd(),
      isolation: "none",
    },
  });
  await assert.rejects(() =>
    diagnostic.diagnose({
      authenticatedDeviceId: "device-worker-1",
      incident: incident("tool-attempt"),
      limits: { maximumTurns: 1, maximumOutputCharacters: 4_096 },
      authority: {
        tools: "denied",
        osMutation: "denied",
        networkMutation: "denied",
      },
    }),
  );
  assert.equal(cancelCount > 0, true);
});

class FailFirstCompletionEventStore implements EventStore {
  readonly #backing: EventStore;
  #failCompletion = true;

  public constructor(backing: EventStore) {
    this.#backing = backing;
  }

  public async append(input: AppendEvents): Promise<readonly StoredEvent[]> {
    if (
      this.#failCompletion &&
      input.events.some((event) => event.type === "transport.route-incident.diagnosis-completed.v1")
    ) {
      this.#failCompletion = false;
      throw new Error("synthetic completion crash");
    }
    return await this.#backing.append(input);
  }

  public readStream(streamId: string): Promise<readonly StoredEvent[]> {
    return this.#backing.readStream(streamId);
  }

  public readAll(): Promise<readonly StoredEvent[]> {
    return this.#backing.readAll();
  }

  public streamVersion(streamId: string): Promise<number> {
    return this.#backing.streamVersion(streamId);
  }

  public replay<TProjection>(
    streamId: string,
    initial: TProjection,
    apply: (projection: TProjection, event: StoredEvent) => TProjection,
  ): Promise<TProjection> {
    return this.#backing.replay(streamId, initial, apply);
  }
}
