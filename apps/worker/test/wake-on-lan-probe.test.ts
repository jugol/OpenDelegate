import assert from "node:assert/strict";
import test from "node:test";

import { SystemWakeOnLanProbe, type WakeOnLanCommandRunner } from "../src/wake-on-lan-probe.ts";

const NOW = Date.parse("2026-07-29T08:00:00.000Z");

test("Windows reports enabled when any physical adapter accepts magic-packet wake", async () => {
  const probe = new SystemWakeOnLanProbe({
    platform: "win32",
    now: () => NOW,
    runner: runner(async () => '["Disabled","Enabled","Unsupported"]'),
    windowsPowerShellPath: "powershell.exe",
  });

  assert.deepEqual(await probe.probe(), {
    state: "enabled",
    source: "windows-netadapter-power",
    observedAtMs: NOW,
  });
});

test("macOS distinguishes a supported but disabled wake target", async () => {
  const probe = new SystemWakeOnLanProbe({
    platform: "darwin",
    now: () => NOW,
    runner: runner(async () => "Battery Power:\n womp 0\nAC Power:\n womp 0\n"),
  });

  assert.deepEqual(await probe.probe(), {
    state: "disabled",
    source: "macos-pmset",
    observedAtMs: NOW,
  });
});

test("Linux reduces per-interface ethtool output without exposing interface data", async () => {
  const probe = new SystemWakeOnLanProbe({
    platform: "linux",
    linuxInterfaceNames: () => ["tailscale0", "enp5s0"],
    now: () => NOW,
    runner: runner(async (_executable, arguments_) =>
      arguments_[0] === "enp5s0"
        ? "Settings for PRIVATE-INTERFACE:\n Supports Wake-on: pumbg\n Wake-on: g\n"
        : "Settings for tailscale0:\n Supports Wake-on: d\n Wake-on: d\n",
    ),
  });

  const result = await probe.probe();
  assert.deepEqual(result, {
    state: "enabled",
    source: "linux-ethtool",
    observedAtMs: NOW,
  });
  assert.equal(JSON.stringify(result).includes("PRIVATE-INTERFACE"), false);
  assert.equal(JSON.stringify(result).includes("enp5s0"), false);
});

test("a missing or denied platform probe reports unknown instead of guessing", async () => {
  const probe = new SystemWakeOnLanProbe({
    platform: "linux",
    linuxInterfaceNames: () => ["eth0"],
    now: () => NOW,
    runner: runner(async () => {
      throw new Error("permission denied: PRIVATE-DIAGNOSTIC");
    }),
  });

  assert.deepEqual(await probe.probe(), {
    state: "unknown",
    source: "probe-unavailable",
    observedAtMs: NOW,
  });
});

test("Linux reports unknown when no physical interface can be assessed", async () => {
  const probe = new SystemWakeOnLanProbe({
    platform: "linux",
    linuxInterfaceNames: () => [],
    now: () => NOW,
    runner: runner(async () => {
      throw new Error("must not run");
    }),
  });

  assert.deepEqual(await probe.probe(), {
    state: "unknown",
    source: "linux-ethtool",
    observedAtMs: NOW,
  });
});

test("Linux reports unknown when ethtool output lacks conclusive evidence", async () => {
  const probe = new SystemWakeOnLanProbe({
    platform: "linux",
    linuxInterfaceNames: () => ["eth0"],
    now: () => NOW,
    runner: runner(async () => "Settings for PRIVATE-INTERFACE:\n Link detected: yes\n"),
  });

  assert.deepEqual(await probe.probe(), {
    state: "unknown",
    source: "linux-ethtool",
    observedAtMs: NOW,
  });
});

test("Linux preserves uncertainty when one interface probe fails", async () => {
  const probe = new SystemWakeOnLanProbe({
    platform: "linux",
    linuxInterfaceNames: () => ["eth0", "eth1"],
    now: () => NOW,
    runner: runner(async (_executable, arguments_) => {
      if (arguments_[0] === "eth0") {
        throw new Error("permission denied: PRIVATE-DIAGNOSTIC");
      }
      return "Supports Wake-on: d\nWake-on: d\n";
    }),
  });

  assert.deepEqual(await probe.probe(), {
    state: "unknown",
    source: "linux-ethtool",
    observedAtMs: NOW,
  });
});

test("Linux preserves uncertainty when the bounded interface scan is truncated", async () => {
  const probe = new SystemWakeOnLanProbe({
    platform: "linux",
    linuxInterfaceNames: () =>
      Array.from({ length: 33 }, (_value, index) => `eth${String(index).padStart(2, "0")}`),
    now: () => NOW,
    runner: runner(async () => "Supports Wake-on: d\nWake-on: d\n"),
  });

  assert.deepEqual(await probe.probe(), {
    state: "unknown",
    source: "linux-ethtool",
    observedAtMs: NOW,
  });
});

function runner(run: WakeOnLanCommandRunner["run"]): WakeOnLanCommandRunner {
  return { run };
}
