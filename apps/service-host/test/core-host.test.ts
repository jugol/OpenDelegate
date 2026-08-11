import assert from "node:assert/strict";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { afterEach, describe, it, mock } from "node:test";

import { isRunningCoreHealthResponseV1 } from "@opendelegate/platform-services";

import {
  buildCoreChildServiceEnvironment,
  CoreHealthServer,
  resolveWorkerReleaseRoot,
  startCoLocatedMainDeviceWorkload,
  waitForCoreWorkloadReadiness,
  type CoreWorkloadHandle,
  type ServiceHostConfiguration,
} from "../src/index.ts";

describe("native Worker service environment", () => {
  it("marks every native service host as a system service without mutating its input", () => {
    const input = { PATH: "C:\\tools", OPENDELEGATE_SERVICE_MODE: "foreground" };
    const environment = buildCoreChildServiceEnvironment(input);

    assert.equal(environment["PATH"], "C:\\tools");
    assert.equal(environment["OPENDELEGATE_SERVICE_MODE"], "system-service");
    assert.equal(input.OPENDELEGATE_SERVICE_MODE, "foreground");
  });

  it("adds only bounded owner provider executable directories on Windows", () => {
    const input = {
      Path: "C:\\Windows\\System32;C:\\USERS\\OWNER\\.LOCAL\\BIN",
      codex_home: "C:\\wrong-codex",
      CLAUDE_CONFIG_DIR: "C:\\wrong-claude",
      OPENDELEGATE_SERVICE_MODE: "foreground",
    };
    const environment = buildCoreChildServiceEnvironment(input, {
      platform: "windows",
      ownerSession: {
        userName: "WORKSTATION\\owner",
        stableUserId: "S-1-5-21-1000",
        homeDirectory: "C:\\Users\\owner",
        adminAutoOpen: { enabled: false },
      },
      agentProviderAccess: {
        codexHomeDirectory: "C:\\Users\\owner\\.codex",
        codexServiceHomeDirectory: "C:\\ProgramData\\OpenDelegate\\state\\state\\providers\\codex",
        claudeHomeDirectory: "C:\\Users\\owner\\.claude",
      },
    });

    assert.equal(
      environment["Path"],
      "C:\\Users\\owner\\.local\\bin;C:\\Users\\owner\\AppData\\Roaming\\npm;C:\\Windows\\System32",
    );
    assert.equal(input.Path, "C:\\Windows\\System32;C:\\USERS\\OWNER\\.LOCAL\\BIN");
    assert.equal(
      environment["CODEX_HOME"],
      "C:\\ProgramData\\OpenDelegate\\state\\state\\providers\\codex",
    );
    assert.equal(environment["CLAUDE_CONFIG_DIR"], "C:\\Users\\owner\\.claude");
    assert.equal(Object.hasOwn(environment, "codex_home"), false);
    assert.equal(input.codex_home, "C:\\wrong-codex");
    assert.equal(environment["OPENDELEGATE_SERVICE_MODE"], "system-service");
  });

  it("provides the same bounded launcher path to a Windows Main control plane", () => {
    const environment = buildCoreChildServiceEnvironment(
      { PATH: "C:\\Windows\\System32" },
      {
        platform: "windows",
        ownerSession: {
          userName: "WORKSTATION\\owner",
          stableUserId: "S-1-5-21-1000",
          homeDirectory: "C:\\Users\\owner",
          adminAutoOpen: { enabled: false },
        },
        agentProviderAccess: {
          codexHomeDirectory: "C:\\Users\\owner\\.codex",
          codexServiceHomeDirectory:
            "C:\\ProgramData\\OpenDelegate\\state\\state\\providers\\codex",
          claudeHomeDirectory: "C:\\Users\\owner\\.claude",
        },
      },
    );

    assert.equal(
      environment["PATH"],
      "C:\\Users\\owner\\.local\\bin;C:\\Users\\owner\\AppData\\Roaming\\npm;C:\\Windows\\System32",
    );
    assert.equal(
      environment["CODEX_HOME"],
      "C:\\ProgramData\\OpenDelegate\\state\\state\\providers\\codex",
    );
    assert.equal(environment["CLAUDE_CONFIG_DIR"], "C:\\Users\\owner\\.claude");
  });
});

const servers: CoreHealthServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("core service health boundary", () => {
  it("reports liveness without claiming helper or Computer Use readiness", async () => {
    const port = await reservePort();
    const server = new CoreHealthServer({
      endpoint: `http://127.0.0.1:${port}/health/live`,
      instanceId: "personal",
      deviceId: "device-personal",
      role: "worker",
      releaseVersion: "1.2.3",
    });
    servers.push(server);
    await server.listen();
    const startingResponse = await fetch(`http://127.0.0.1:${port}/health/live`);
    const startingBody = (await startingResponse.json()) as Record<string, unknown>;
    assert.equal(startingResponse.status, 503);
    assert.equal(startingBody["status"], "starting");
    assert.equal(startingBody["headlessWorkAvailable"], false);
    server.markRunning();

    const response = await fetch(`http://127.0.0.1:${port}/health/live`);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(response.status, 200);
    assert.equal(body["status"], "running");
    assert.equal(body["headlessWorkAvailable"], true);
    assert.equal(
      isRunningCoreHealthResponseV1(body, {
        instanceId: "personal",
        deviceId: "device-personal",
        role: "worker",
        releaseVersion: "1.2.3",
      }),
      true,
    );
    assert.equal(Object.hasOwn(body, "computerUseReady"), false);
    assert.equal(JSON.stringify(body).includes("secret://"), false);

    server.markFailed();
    assert.equal((await fetch(`http://127.0.0.1:${port}/health/live`)).status, 503);
  });
});

describe("co-located Main Device workload", () => {
  it("starts Main and its local Worker under one lifecycle", async () => {
    const mainCompletion = Promise.withResolvers<void>();
    const workerCompletion = Promise.withResolvers<void>();
    const mainReady = Promise.withResolvers<void>();
    const workerReady = Promise.withResolvers<void>();
    const main = workload(mainCompletion.promise, mainReady.promise);
    const worker = workload(workerCompletion.promise, workerReady.promise);
    const configuration = {} as ServiceHostConfiguration;
    const controller = new AbortController();
    const startMainControlPlane = mock.fn(
      async (
        _configuration: ServiceHostConfiguration,
        _signal: AbortSignal,
      ): Promise<CoreWorkloadHandle> => main,
    );
    const startLocalWorker = mock.fn(
      async (
        _configuration: ServiceHostConfiguration,
        _signal: AbortSignal,
      ): Promise<CoreWorkloadHandle> => worker,
    );

    const composed = await startCoLocatedMainDeviceWorkload(configuration, controller.signal, {
      startMainControlPlane,
      startLocalWorker,
    });

    assert.equal(startMainControlPlane.mock.callCount(), 1);
    assert.equal(startLocalWorker.mock.callCount(), 1);
    assert.equal(startMainControlPlane.mock.calls[0]?.arguments[0], configuration);
    assert.equal(startLocalWorker.mock.calls[0]?.arguments[0], configuration);
    assert.equal(startMainControlPlane.mock.calls[0]?.arguments[1], controller.signal);
    assert.equal(startLocalWorker.mock.calls[0]?.arguments[1], controller.signal);

    let composedReady = false;
    void composed.ready.then(() => {
      composedReady = true;
    });
    mainReady.resolve();
    await Promise.resolve();
    assert.equal(composedReady, false);
    workerReady.resolve();
    await composed.ready;
    assert.equal(composedReady, true);

    workerCompletion.resolve();
    await composed.completed;
    await composed.stop();
    assert.equal(worker.stop.mock.callCount(), 1);
    assert.equal(main.stop.mock.callCount(), 1);
  });

  it("stops Main when the local Worker cannot start", async () => {
    const mainCompletion = Promise.withResolvers<void>();
    const main = workload(mainCompletion.promise);
    const failure = new Error("local Worker configuration is missing");

    await assert.rejects(
      startCoLocatedMainDeviceWorkload(
        {} as ServiceHostConfiguration,
        new AbortController().signal,
        {
          startMainControlPlane: async () => main,
          startLocalWorker: async () => {
            throw failure;
          },
        },
      ),
      failure,
    );
    assert.equal(main.stop.mock.callCount(), 1);
  });
});

describe("Worker release identity", () => {
  it("uses the physical release behind the active release pointer", async () => {
    const observed: string[] = [];
    const activeRelease = resolve("current");
    const expectedPhysicalRelease = resolve("releases", "0.1.0-alpha.1");
    const physicalRelease = await resolveWorkerReleaseRoot(activeRelease, async (path) => {
      observed.push(path);
      return expectedPhysicalRelease;
    });

    assert.deepEqual(observed, [activeRelease]);
    assert.equal(physicalRelease, expectedPhysicalRelease);
  });
});

describe("core workload readiness gate", () => {
  it("accepts only an explicit workload readiness signal", async () => {
    const pendingCompletion = Promise.withResolvers<void>();
    const pendingReady = Promise.withResolvers<void>();
    const controller = new AbortController();
    const gate = waitForCoreWorkloadReadiness(
      workload(pendingCompletion.promise, pendingReady.promise),
      1_000,
      controller.signal,
    );

    pendingReady.resolve();
    assert.equal(await gate, true);
  });

  it("rejects a workload that exits before readiness", async () => {
    const pendingCompletion = Promise.withResolvers<void>();
    const pendingReady = Promise.withResolvers<void>();
    const gate = waitForCoreWorkloadReadiness(
      workload(pendingCompletion.promise, pendingReady.promise),
      1_000,
      new AbortController().signal,
    );

    pendingCompletion.resolve();
    await assert.rejects(gate, /exited before becoming ready/u);
  });

  it("times out instead of accepting brief process liveness", async () => {
    const pendingCompletion = Promise.withResolvers<void>();
    const pendingReady = Promise.withResolvers<void>();
    await assert.rejects(
      waitForCoreWorkloadReadiness(
        workload(pendingCompletion.promise, pendingReady.promise),
        20,
        new AbortController().signal,
      ),
      /did not become ready before timeout/u,
    );
  });
});

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function workload(
  completed: Promise<void>,
  ready: Promise<void> = Promise.resolve(),
): CoreWorkloadHandle & {
  readonly stop: ReturnType<typeof mock.fn<() => Promise<void>>>;
} {
  const stop = mock.fn(async () => undefined);
  return { ready, completed, stop };
}
