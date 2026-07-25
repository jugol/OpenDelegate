import assert from "node:assert/strict";
import test from "node:test";

import {
  LocalKnowledgeInitialContextProvider,
  WorkerEgressGuard,
  type WorkerRunAssignmentV1,
} from "../src/index.ts";

test("local Knowledge search opens only bounded selected notes for initial context", async () => {
  const calls: string[] = [];
  const provider = new LocalKnowledgeInitialContextProvider({
    knowledge: {
      health() {
        calls.push("health");
        return { status: "ready" };
      },
      search(query, options) {
        calls.push(`search:${query}:${String(options.limit)}`);
        return [
          { noteId: "build.md", title: "Build", preview: "ignored preview" },
          { noteId: "gpu.md", title: "GPU", preview: "ignored preview" },
        ];
      },
      openNotes(noteIds, options) {
        calls.push(`open:${noteIds.join(",")}:${String(options.totalCharacterBudget)}`);
        return {
          characterBudget: options.totalCharacterBudget,
          usedCharacters: 36,
          notes: [
            {
              noteId: "build.md",
              title: "Build on this Device",
              content: "Use the local signed build cache.",
              truncated: false,
            },
          ],
          omittedNoteIds: ["gpu.md"],
        };
      },
    },
    candidateLimit: 2,
    characterBudget: 4_000,
  });

  const context = await provider.prepare({
    assignment: assignment(),
    workstreamId: "implementation",
    workspaceId: "workspace-app",
  });

  assert.match(context?.prompt ?? "", /Device-local Knowledge/u);
  assert.match(context?.prompt ?? "", /Build on this Device/u);
  assert.match(context?.prompt ?? "", /Use the local signed build cache/u);
  assert.doesNotMatch(context?.prompt ?? "", /build\.md|gpu\.md|ignored preview/u);
  const egressGuard = WorkerEgressGuard.empty();
  await egressGuard.protectKnowledge(
    context?.knowledgeSources ?? { noteIds: [], titles: [], contents: [] },
  );
  for (const protectedValue of [
    "build.md",
    "gpu.md",
    "Build on this Device",
    "Use the local signed build cache.",
  ]) {
    assert.equal(egressGuard.inspectText(protectedValue).safe, false);
  }
  assert.deepEqual(calls, [
    "health",
    "search:Compile release Compile and test the release. Release tests pass. Do not publish. cache signed build:2",
    "open:build.md,gpu.md:4000",
  ]);
});

test("unready or irrelevant local Knowledge adds no automatic context", async () => {
  let searches = 0;
  const unready = new LocalKnowledgeInitialContextProvider({
    knowledge: {
      health: () => ({ status: "not-ready" }),
      search: () => {
        searches += 1;
        return [];
      },
      openNotes: () => {
        throw new Error("must not open");
      },
    },
  });
  assert.equal(
    await unready.prepare({
      assignment: assignment(),
      workstreamId: "implementation",
      workspaceId: "workspace-app",
    }),
    undefined,
  );
  assert.equal(searches, 0);

  const irrelevant = new LocalKnowledgeInitialContextProvider({
    knowledge: {
      health: () => ({ status: "ready" }),
      search: () => [],
      openNotes: () => {
        throw new Error("must not open");
      },
    },
  });
  assert.equal(
    await irrelevant.prepare({
      assignment: assignment(),
      workstreamId: "implementation",
      workspaceId: "workspace-app",
    }),
    undefined,
  );
});

function assignment(): WorkerRunAssignmentV1 {
  return {
    taskId: "task-release",
    workOrder: {
      protocolVersion: "v1",
      workOrderId: "work-order-release",
      title: "Compile release",
      brief: "Compile and test the release.",
      completionCriteria: ["Release tests pass."],
      constraints: ["Do not publish."],
      selectedInputIds: [],
      dependsOn: [],
      schedulingHints: {
        preferredDeviceIds: [],
        preferredRoles: [],
      },
      requiredCapabilities: ["cache", "signed", "build"],
      requiredSecretRefs: [],
      workspaceId: "workspace-app",
    },
    deviceId: "device-worker",
    workerId: "worker-device",
    routeId: "route-main",
    runId: "run-release",
    leaseId: "lease-release",
    fencingToken: 1,
    leaseExpiresAtMs: Date.now() + 60_000,
  };
}
