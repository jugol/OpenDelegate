import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  autoOpenAdminForOwnerSession,
  createAdminBrowserLaunchRequest,
  type AdminAutoOpenInput,
  type AdminBrowserLaunchRequest,
} from "../src/index.ts";

describe("owner-session Admin auto-open", () => {
  it("waits for Main readiness and atomically launches at most once in one login session", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "opendelegate-admin-open-"));
    const launched: AdminBrowserLaunchRequest[] = [];
    let readinessChecks = 0;
    try {
      const input = fixture(runtimeRoot, "windows:3:logon:0-1007");
      const first = await autoOpenAdminForOwnerSession(input, {
        fetch: async () => {
          readinessChecks += 1;
          if (readinessChecks === 1) {
            return healthResponse(503);
          }
          return readinessChecks === 2
            ? healthResponse(200, { instanceId: "another-instance" })
            : healthResponse(200);
        },
        delay: async () => undefined,
        launch: async (request) => {
          launched.push(request);
        },
        windowsDirectory: "C:\\Windows",
      });
      const replay = await autoOpenAdminForOwnerSession(input, {
        fetch: async () => {
          throw new Error("A completed session claim must skip readiness polling.");
        },
        delay: async () => undefined,
        launch: async (request) => {
          launched.push(request);
        },
        windowsDirectory: "C:\\Windows",
      });

      assert.equal(first.status, "opened");
      assert.equal(replay.status, "already-opened");
      assert.equal(readinessChecks, 3);
      assert.deepEqual(launched, [
        {
          executable: "C:\\Windows\\explorer.exe",
          arguments: ["http://127.0.0.1:43180/"],
        },
      ]);
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("opens again for a distinct owner login session but never from a Worker", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "opendelegate-admin-open-session-"));
    let launches = 0;
    const dependencies = {
      fetch: async () => healthResponse(200),
      delay: async () => undefined,
      launch: async () => {
        launches += 1;
      },
      windowsDirectory: "C:\\Windows",
    };
    try {
      assert.equal(
        (
          await autoOpenAdminForOwnerSession(
            fixture(runtimeRoot, "windows:3:logon:0-1007"),
            dependencies,
          )
        ).status,
        "opened",
      );
      assert.equal(
        (
          await autoOpenAdminForOwnerSession(
            fixture(runtimeRoot, "windows:4:logon:0-1008"),
            dependencies,
          )
        ).status,
        "opened",
      );
      assert.equal(
        (
          await autoOpenAdminForOwnerSession(
            { ...fixture(runtimeRoot, "windows:5:logon:0-1009"), role: "worker" },
            dependencies,
          )
        ).status,
        "disabled",
      );
      assert.equal(launches, 2);
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("accepts exact macOS and Linux login identities and rejects a UID-only fallback", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "opendelegate-admin-open-posix-"));
    let launches = 0;
    const dependencies = {
      fetch: async () => healthResponse(200),
      delay: async () => undefined,
      launch: async () => {
        launches += 1;
      },
    };
    try {
      const mac = fixture(runtimeRoot, "unix:501:audit:1048577");
      const linux = fixture(runtimeRoot, "unix:1000:xdg:session-4");
      assert.equal(
        (
          await autoOpenAdminForOwnerSession(
            {
              ...mac,
              platform: "macos",
              ownerStableId: "501",
            },
            dependencies,
          )
        ).status,
        "opened",
      );
      assert.equal(
        (
          await autoOpenAdminForOwnerSession(
            {
              ...linux,
              platform: "linux",
              ownerStableId: "1000",
            },
            dependencies,
          )
        ).status,
        "opened",
      );
      assert.equal(
        (
          await autoOpenAdminForOwnerSession(
            {
              ...linux,
              sessionId: "unix:1000",
              platform: "linux",
              ownerStableId: "1000",
            },
            dependencies,
          )
        ).status,
        "session-unavailable",
      );
      assert.equal(launches, 2);
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("does not claim or launch when Main never becomes ready or the helper stops", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "opendelegate-admin-open-wait-"));
    let launches = 0;
    try {
      const unavailable = await autoOpenAdminForOwnerSession(
        fixture(runtimeRoot, "windows:6:logon:0-1010"),
        {
          fetch: async () => healthResponse(503),
          delay: async () => undefined,
          launch: async () => {
            launches += 1;
          },
          readinessAttempts: 2,
          windowsDirectory: "C:\\Windows",
        },
      );
      const controller = new AbortController();
      controller.abort();
      const cancelled = await autoOpenAdminForOwnerSession(
        { ...fixture(runtimeRoot, "windows:7:logon:0-1011"), signal: controller.signal },
        {
          fetch: async () => healthResponse(200),
          delay: async () => undefined,
          launch: async () => {
            launches += 1;
          },
          windowsDirectory: "C:\\Windows",
        },
      );

      assert.equal(unavailable.status, "main-unavailable");
      assert.equal(cancelled.status, "cancelled");
      assert.equal(launches, 0);
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("uses exact shell-free browser launch contracts on Windows, macOS, and Linux", () => {
    assert.deepEqual(
      createAdminBrowserLaunchRequest("windows", "https://admin.example.test/", {
        windowsDirectory: "D:\\Windows",
      }),
      {
        executable: "D:\\Windows\\explorer.exe",
        arguments: ["https://admin.example.test/"],
      },
    );
    assert.deepEqual(createAdminBrowserLaunchRequest("macos", "https://admin.example.test/"), {
      executable: "/usr/bin/open",
      arguments: ["https://admin.example.test/"],
    });
    assert.deepEqual(createAdminBrowserLaunchRequest("linux", "https://admin.example.test/"), {
      executable: "/usr/bin/xdg-open",
      arguments: ["https://admin.example.test/"],
    });
  });
});

function fixture(runtimeRoot: string, sessionId: string): AdminAutoOpenInput {
  return {
    instanceId: "personal",
    deviceId: "device-personal",
    platform: "windows",
    role: "main",
    runtimeRoot,
    ownerStableId: "S-1-5-21-1000",
    sessionId,
    adminAutoOpen: {
      enabled: true,
      url: "http://127.0.0.1:43180/",
    },
    health: {
      endpoint: "http://127.0.0.1:43190/health/live",
      timeoutMs: 1_000,
    },
    signal: new AbortController().signal,
  };
}

function healthResponse(
  status: number,
  override: Partial<{
    instanceId: string;
    deviceId: string;
    role: string;
    status: string;
    headlessWorkAvailable: boolean;
  }> = {},
): Response {
  return new Response(
    JSON.stringify({
      schemaVersion: 1,
      product: "OpenDelegate",
      plane: "core",
      instanceId: "personal",
      deviceId: "device-personal",
      role: "main",
      status: "running",
      headlessWorkAvailable: true,
      ...override,
    }),
    {
      status,
      headers: {
        "content-type": "application/json",
      },
    },
  );
}
