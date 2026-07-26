import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  ComputerUseActionSummary,
  ComputerUseSession,
  ComputerUseSessionStatus,
  DesktopLeasePort,
  NativeObservation,
} from "@opendelegate/computer-use-os";
import {
  ComputerUseToolPortError,
  type ComputerUseRunAuthority,
  type ComputerUseToolContext,
} from "@opendelegate/computer-use-mcp";

import { WorkerComputerUseToolPort } from "../src/computer-use-tool-port.ts";

const AUTHORITY: ComputerUseRunAuthority = Object.freeze({
  taskId: "task-browser",
  workOrderId: "work-browser",
  runId: "run-browser",
  deviceId: "device-windows",
  executionHandleId: "cu_browser",
  lease: Object.freeze({
    resourceName: "desktop-session",
    capacity: 1,
    leaseId: "desktop-lease-browser",
    fencingToken: 5,
    expiresAtMs: 10_000,
  }),
  desktopAuthority: Object.freeze({
    helperInstanceId: "helper-windows-1",
    serviceEpoch: 3,
    persistenceGeneration: 8,
  }),
});

describe("WorkerComputerUseToolPort", () => {
  it("maps the exact current Computer Use session into bounded MCP results", async () => {
    const session = new FixtureSession();
    const port = createPort(session);
    const context = toolContext();

    assert.equal((await port.readiness(context)).status, "ready");
    assert.deepEqual(await port.observe(context), {
      displayFingerprint: "display:fixture",
      summary: "2 accessible controls are available on the current display.",
      controls: [
        {
          controlId: "submit",
          role: "button",
          label: "Submit",
        },
        {
          controlId: "name",
          role: "textbox",
          label: "Name",
          value: "",
        },
      ],
    });
    const capture = await port.capture(context);
    assert.equal(capture.width, 1);
    assert.equal(capture.height, 1);
    assert.notEqual(capture.png, session.captureBytes);
    assert.deepEqual(await port.click(context, { controlId: "submit" }), {
      sequence: 1,
      executedAtMs: 1_010,
      displayFingerprint: "display:fixture",
    });
    assert.deepEqual(await port.typeText(context, { controlId: "name", text: "OpenDelegate" }), {
      sequence: 2,
      executedAtMs: 1_020,
      displayFingerprint: "display:fixture",
    });
    assert.equal(session.clicks, 1);
    assert.equal(session.typedTexts, 1);
  });

  it("fails stale Run, lease, unsupported actions, and emergency stop closed", async () => {
    const session = new FixtureSession();
    let executionCurrent = false;
    const port = createPort(session, {
      isExecutionCurrent: () => Promise.resolve(executionCurrent),
    });
    await assert.rejects(port.observe(toolContext()), hasToolError("STALE_AUTHORITY"));

    executionCurrent = true;
    const staleLeasePort = createPort(session, {
      leases: {
        async verify() {
          return {
            status: "stale",
            reason: "replaced",
            verifiedAtMs: 1_000,
          };
        },
      },
    });
    await assert.rejects(staleLeasePort.capture(toolContext()), hasToolError("STALE_LEASE"));
    await assert.rejects(port.key(toolContext(), { key: "Enter" }), hasToolError("UNSUPPORTED"));
    await assert.rejects(
      port.scroll(toolContext(), { deltaX: 0, deltaY: 100 }),
      hasToolError("UNSUPPORTED"),
    );

    assert.deepEqual(await port.stop(toolContext(), { mode: "emergency-stop" }), {
      status: "stopped",
    });
    assert.equal(session.status(), "emergency-stopped");
  });
});

function createPort(
  session: FixtureSession,
  overrides: {
    readonly isExecutionCurrent?: () => Promise<boolean>;
    readonly leases?: DesktopLeasePort;
  } = {},
): WorkerComputerUseToolPort {
  return new WorkerComputerUseToolPort({
    authority: AUTHORITY,
    session,
    readiness: async () => ({
      status: "ready",
      osFamily: "windows",
      backendId: "windows-uia-wgc-sendinput-v1",
      displayFingerprint: "display:fixture",
      checks: [
        {
          name: "interactive-session",
          status: "pass",
          evidence: "Interactive session verified.",
        },
      ],
    }),
    isExecutionCurrent: overrides.isExecutionCurrent ?? (() => Promise.resolve(true)),
    leases:
      overrides.leases ??
      ({
        async verify(request) {
          return {
            status: "current",
            leaseId: request.lease.leaseId,
            fencingToken: request.lease.fencingToken,
            verifiedAtMs: 1_000,
          };
        },
      } satisfies DesktopLeasePort),
  });
}

function toolContext(): ComputerUseToolContext {
  return {
    authority: structuredClone(AUTHORITY),
    signal: new AbortController().signal,
  };
}

function hasToolError(code: ComputerUseToolPortError["code"]) {
  return (error: unknown): boolean =>
    error instanceof ComputerUseToolPortError && error.code === code;
}

class FixtureSession implements ComputerUseSession {
  public readonly executionHandleId = AUTHORITY.executionHandleId;
  public readonly captureBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  public clicks = 0;
  public typedTexts = 0;
  #status: ComputerUseSessionStatus = "active";
  readonly #entries: Array<ComputerUseActionSummary["entries"][number]> = [];

  public status(): ComputerUseSessionStatus {
    return this.#status;
  }

  public async observe(): Promise<NativeObservation> {
    return {
      displayFingerprint: "display:fixture",
      accessibilityTree: [
        {
          controlId: "submit",
          role: "button",
          label: "Submit",
        },
        {
          controlId: "name",
          role: "textbox",
          label: "Name",
          value: "",
        },
      ],
    };
  }

  public async capture() {
    return {
      evidenceId: "evidence-1",
      runId: AUTHORITY.runId,
      mediaType: "image/png" as const,
      width: 1,
      height: 1,
      bytes: this.captureBytes,
      sha256: `sha256:${"a".repeat(64)}` as const,
      capturedAtMs: 1_005,
      displayFingerprint: "display:fixture",
    };
  }

  public async click(input: { readonly controlId: string }) {
    this.clicks += 1;
    this.#record("click", input.controlId);
  }

  public async typeText(input: { readonly controlId: string; readonly text: string }) {
    assert.equal(input.text, "OpenDelegate");
    this.typedTexts += 1;
    this.#record("type-text", input.controlId);
  }

  public actionSummary(): ComputerUseActionSummary {
    return {
      executionHandleId: this.executionHandleId,
      taskId: AUTHORITY.taskId,
      deviceId: AUTHORITY.deviceId,
      runId: AUTHORITY.runId,
      entries: [...this.#entries],
    };
  }

  public captureActionSummary() {
    return {
      evidenceId: "summary-1",
      runId: AUTHORITY.runId,
      mediaType: "application/json" as const,
      filename: "actions.json",
      bytes: Uint8Array.from([123, 125]),
      sha256: `sha256:${"b".repeat(64)}` as const,
      createdAtMs: 1_020,
    };
  }

  public async cancel() {
    this.#status = "cancelled";
  }

  public async emergencyStop() {
    this.#status = "emergency-stopped";
  }

  public async release() {
    this.#status = "released";
  }

  #record(kind: "click" | "type-text", controlId: string): void {
    const sequence = this.#entries.length + 1;
    this.#entries.push({
      sequence,
      kind,
      controlId,
      fingerprint: `sha256:${"c".repeat(63)}${String(sequence)}`,
      authorizationId: `authorization-${String(sequence)}`,
      executedAtMs: 1_000 + sequence * 10,
    });
  }
}
