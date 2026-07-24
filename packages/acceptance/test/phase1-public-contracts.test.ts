import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import test, { type TestContext } from "node:test";

import { ResourceLockError } from "@opendelegate/resource-locks";
import { SchedulerError } from "@opendelegate/scheduler";
import { SecretError } from "@opendelegate/secrets";

import {
  createRichPhase1Harness,
  type RichPhase1Harness,
  type RichPhase1Scenario,
} from "../src/phase1-public-contract-harness.ts";

const PRIVATE_VALUES = [
  "Quasar recovery procedure",
  "Zephyr desktop procedure",
  "KNOWLEDGE-QUASAR-PRIVATE",
  "KNOWLEDGE-ZEPHYR-PRIVATE",
  "research-secret-value",
  "desktop-secret-value",
] as const;

test("the rich Phase 1 journey crosses every public safety contract before presenting an Artifact", async (t) => {
  const harness = await createHarness(t, "allowed");

  const result = await harness.execute();

  assert.deepEqual(result.clarification, {
    taskId: "task-rich-phase-1",
    state: "waiting_user",
    clarificationId: "clarification-execution-scope",
    question:
      "Should this Task use only deterministic fake Devices and keep local Knowledge private?",
    answeredBy: "discord-owner",
    answer:
      "Yes. Use only deterministic fake Devices and keep Device-local Knowledge and Secrets off Main.",
  });
  assert.equal(result.task.taskId, result.clarification.taskId);
  assert.equal(result.task.state, "completed");
  if (result.task.state !== "completed") {
    assert.fail("The clarified rich journey must complete after the owner answer.");
  }
  assert.deepEqual(result.task.stateHistory, [
    "intake",
    "waiting_user",
    "running",
    "review",
    "completed",
  ]);
  assert.deepEqual(
    result.task.verifiedCompletionCriteria,
    result.task.taskBrief.completionCriteria,
  );
  assert.deepEqual(result.task.workOrders.map((workOrder) => workOrder.workOrderId).sort(), [
    "work-order-computer-use",
    "work-order-research",
    "work-order-summary",
  ]);
  assert.equal(result.task.resultProjection.statusTag, "Done");
  assert.equal(result.task.resultProjection.actions[0].label, "Open report");
  assert.deepEqual(result.evidence.selectedDeviceIds, [
    "device-research",
    "device-desktop",
    "device-research",
  ]);
  assert.deepEqual(result.evidence.transportEndpointIds, [
    "endpoint-device-research-primary",
    "endpoint-device-desktop-primary",
    "endpoint-device-research-primary",
  ]);
  assert.deepEqual(result.evidence.runFencingTokens, [1, 3, 4]);
  assert.equal(result.evidence.policyAllowCount, 6);
  assert.deepEqual(result.evidence.policyDecisionCodes, [
    "POLICY_SAFE_OBSERVATION",
    "POLICY_SAFE_OBSERVATION",
    "POLICY_OWNER_GRANT",
    "POLICY_OWNER_GRANT",
    "POLICY_OWNER_GRANT",
    "POLICY_SAFE_OBSERVATION",
  ]);
  assert.ok(
    result.evidence.dispatchPolicyEvaluations.includes(
      "work-order-computer-use:device-research:require-approval",
    ),
  );
  assert.ok(
    result.evidence.dispatchPolicyEvaluations.includes(
      "work-order-computer-use:device-desktop:allow",
    ),
  );
  assert.equal(result.evidence.secretExecutionCount, 3);
  assert.equal(result.evidence.knowledgeRetrievalCount, 3);
  assert.equal(result.evidence.agentTurnCount, 3);
  assert.equal(result.evidence.maxConcurrentWorkerRuns, 2);
  assert.equal(result.evidence.dependencyWaveProven, true);
  assert.equal(result.evidence.crossDeviceKnowledgeRejected, true);
  assert.equal(result.evidence.restartCount, 2);
  assert.deepEqual(result.evidence.coordinatorCallCounts, {
    assess: 1,
    plan: 1,
    synthesize: 1,
    review: 1,
  });
  assert.equal(result.evidence.replayMatched, true);
  assert.deepEqual(result.replayedTask, result.task);
  assert.equal(result.evidence.desktopContentionRejected, true);
  assert.deepEqual(result.evidence.desktopEvidence, {
    kind: "screenshot",
    mediaType: "image/png",
    state: "success",
    width: 1280,
    height: 720,
  });
  assert.deepEqual(result.evidence.computerInputOnceGrant, {
    firstUseAllowCount: 3,
    competingReplayRejected: true,
    consumedGrantCount: 3,
  });
  assert.deepEqual(result.journalEventTypes, [
    "task.bound",
    "clarification.requested",
    "clarification.answered",
    "plan.recorded",
    "work-order.dispatched",
    "work-order.dispatched",
    "work-order.run-failed",
    "work-order.completed",
    "work-order.dispatched",
    "work-order.completed",
    "work-order.dispatched",
    "work-order.completed",
    "synthesis.recorded",
    "artifact.published",
    "task.review-started",
    "task.review-completed",
    "task.completed",
  ]);
  assert.deepEqual(result.orchestrationEvents.slice(4, 12), [
    { type: "work-order.dispatched", workOrderId: "work-order-research" },
    { type: "work-order.dispatched", workOrderId: "work-order-computer-use" },
    { type: "work-order.run-failed", workOrderId: "work-order-computer-use" },
    { type: "work-order.completed", workOrderId: "work-order-research" },
    { type: "work-order.dispatched", workOrderId: "work-order-computer-use" },
    { type: "work-order.completed", workOrderId: "work-order-computer-use" },
    { type: "work-order.dispatched", workOrderId: "work-order-summary" },
    { type: "work-order.completed", workOrderId: "work-order-summary" },
  ]);
  assert.match(result.artifact.content, /deterministic safety gates/i);

  const mainVisibleOutput = JSON.stringify({
    task: result.task,
    artifact: result.artifact,
  });
  for (const privateValue of PRIVATE_VALUES) {
    assert.equal(
      mainVisibleOutput.includes(privateValue),
      false,
      `Main-visible output leaked ${privateValue}.`,
    );
  }
});

test("a deterministic Policy denial cannot reach Worker side effects", async (t) => {
  const harness = await createHarness(t, "policy-denied");

  await assert.rejects(
    harness.execute(),
    (error: unknown) =>
      error instanceof SchedulerError &&
      error.explanations.some((explanation) =>
        explanation.exclusions.some(
          (exclusion) =>
            exclusion.code === "POLICY_EXECUTION_NOT_ALLOWED" && exclusion.outcome === "deny",
        ),
      ),
  );
  assertNoWorkerSideEffects(harness);
});

test("Computer Use input is denied at the input boundary without producing input evidence", async (t) => {
  const harness = await createHarness(t, "computer-input-denied");

  await assert.rejects(
    harness.execute(),
    (error: unknown) => error instanceof SecretError && error.code === "SECRET_EXECUTOR_FAILED",
  );
  const diagnostics = harness.diagnostics();
  assert.deepEqual(diagnostics.computerInputPolicyDecisions, [
    "POLICY_COMPUTER_USE_APPROVAL_REQUIRED",
  ]);
  assert.equal(
    diagnostics.workerSideEffects.includes("computer-use:work-order-computer-use"),
    false,
  );
  assert.equal(diagnostics.artifactPublishCount, 0);
});

test("a replayed once-authorized Computer Use input is rejected at the public execution boundary", async (t) => {
  const harness = await createHarness(t, "computer-input-once-replay");

  await assert.rejects(
    harness.execute(),
    (error: unknown) => error instanceof SecretError && error.code === "SECRET_EXECUTOR_FAILED",
  );
  const diagnostics = harness.diagnostics();
  assert.deepEqual(diagnostics.computerInputPolicyDecisions, [
    "POLICY_OWNER_GRANT",
    "POLICY_COMPUTER_USE_APPROVAL_REQUIRED",
  ]);
  assert.deepEqual(diagnostics.computerInputRequestedAtMs, [
    Date.parse("2026-07-24T12:00:00.000Z"),
    Date.parse("2026-07-24T12:00:00.001Z"),
  ]);
  assert.equal(
    diagnostics.workerSideEffects.includes("computer-use:work-order-computer-use"),
    false,
  );
  assert.equal(diagnostics.artifactPublishCount, 0);
});

test("a consumed Computer Use once grant remains rejected after the policy component restarts", async (t) => {
  const harness = await createHarness(t, "computer-input-once-restart-replay");

  await assert.rejects(
    harness.execute(),
    (error: unknown) => error instanceof SecretError && error.code === "SECRET_EXECUTOR_FAILED",
  );
  const diagnostics = harness.diagnostics();
  assert.deepEqual(diagnostics.computerInputPolicyDecisions, [
    "POLICY_OWNER_GRANT",
    "POLICY_COMPUTER_USE_APPROVAL_REQUIRED",
  ]);
  assert.equal(
    diagnostics.workerSideEffects.includes("computer-use:work-order-computer-use"),
    false,
  );
  assert.equal(diagnostics.artifactPublishCount, 0);
});

test("missing Device-local Secret availability cannot reach Worker side effects", async (t) => {
  const harness = await createHarness(t, "missing-secret");

  await assert.rejects(
    harness.execute(),
    (error: unknown) =>
      error instanceof SchedulerError &&
      error.explanations.some((explanation) =>
        explanation.exclusions.some(
          (exclusion) => exclusion.code === "REQUIRED_SECRET_UNAVAILABLE",
        ),
      ),
  );
  assertNoWorkerSideEffects(harness);
});

test("a stale Run fence cannot reach Worker side effects", async (t) => {
  const harness = await createHarness(t, "stale-fence");

  await assert.rejects(
    harness.execute(),
    (error: unknown) => error instanceof ResourceLockError && error.code === "STALE_FENCING_TOKEN",
  );
  assertNoWorkerSideEffects(harness);
});

async function createHarness(
  t: TestContext,
  scenario: RichPhase1Scenario,
): Promise<RichPhase1Harness> {
  const knowledgeRoot = await mkdtemp(join(tmpdir(), "opendelegate-acceptance-"));

  t.after(async () => {
    const resolvedTemporaryRoot = await realpath(tmpdir());
    const resolvedRoot = await realpath(knowledgeRoot).catch(() => knowledgeRoot);
    const relativeRoot = relative(resolvedTemporaryRoot, resolvedRoot);
    const firstSegment = relativeRoot.split(sep)[0];
    assert.equal(isAbsolute(relativeRoot), false);
    assert.equal(relativeRoot.startsWith(".."), false);
    assert.ok(firstSegment?.startsWith("opendelegate-acceptance-"));
    await rm(resolvedRoot, { force: true, recursive: true });
  });

  return createRichPhase1Harness({
    knowledgeRoot,
    scenario,
  });
}

function assertNoWorkerSideEffects(harness: RichPhase1Harness): void {
  assert.deepEqual(harness.diagnostics(), {
    artifactPublishCount: 0,
    transportConnectionCount: 0,
    secretExecutionCount: 0,
    computerInputPolicyDecisions: [],
    computerInputRequestedAtMs: [],
    workerSideEffects: [],
  });
}
