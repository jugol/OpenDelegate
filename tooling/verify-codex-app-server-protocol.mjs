import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const adapterUrl = new URL(
  "../packages/agent-adapters/src/codex-app-server-adapter.ts",
  import.meta.url,
);
const adapterSource = await readFile(adapterUrl, "utf8");
const testedVersion = requireMatch(
  adapterSource,
  /export const CODEX_APP_SERVER_TESTED_VERSIONS = \["([0-9]+\.[0-9]+\.[0-9]+)"\]/u,
  "tested Codex App Server version",
);
const executable = process.env["OPENDELEGATE_CODEX_EXECUTABLE"] ?? "codex";
const generatedRoot = await mkdtemp(join(tmpdir(), "opendelegate-codex-protocol-"));

try {
  const versionResult = runCodex(["--version"]);
  const installedVersion = requireMatch(
    versionResult.stdout,
    /(?:codex-cli\s+)?([0-9]+\.[0-9]+\.[0-9]+)/u,
    "installed Codex version",
  );
  if (installedVersion !== testedVersion) {
    throw new Error(
      `Codex ${installedVersion} cannot verify the adapter catalog pinned to ${testedVersion}.`,
    );
  }

  runCodex(["app-server", "generate-ts", "--experimental", "--out", generatedRoot]);
  const envelopeSource = await readFile(
    join(generatedRoot, "ServerNotificationEnvelope.ts"),
    "utf8",
  );
  const generatedMethods = uniqueSorted(
    [...envelopeSource.matchAll(/"method": "([^"]+)"/gu)].map((match) => match[1]),
  );
  const catalogBody = requireMatch(
    adapterSource,
    /const SUPPORTED_NOTIFICATION_METHODS = new Set\(\[(.*?)\]\);/su,
    "OpenDelegate Codex notification catalog",
  );
  const adapterMethods = uniqueSorted(
    [...catalogBody.matchAll(/"([^"]+)"/gu)].map((match) => match[1]),
  );
  const missing = generatedMethods.filter((method) => !adapterMethods.includes(method));
  const stale = adapterMethods.filter((method) => !generatedMethods.includes(method));
  if (missing.length > 0 || stale.length > 0) {
    throw new Error(
      `Codex notification catalog mismatch. Missing: ${missing.join(", ") || "none"}. Stale: ${stale.join(", ") || "none"}.`,
    );
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        status: "verified",
        codexVersion: installedVersion,
        notificationCount: generatedMethods.length,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(generatedRoot, { recursive: true, force: true });
}

function runCodex(arguments_) {
  const result = spawnSync(executable, arguments_, {
    encoding: "utf8",
    shell: process.platform === "win32",
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr.trim() ?? `exit ${String(result.status)}`;
    throw new Error(`Codex protocol verification failed: ${detail}`);
  }
  return result;
}

function requireMatch(source, pattern, label) {
  const value = pattern.exec(source)?.[1];
  if (value === undefined) {
    throw new Error(`Could not read ${label}.`);
  }
  return value;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
