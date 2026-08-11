import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const adapterPackage = JSON.parse(
  await readFile(new URL("../packages/agent-adapters/package.json", import.meta.url), "utf8"),
);
const codexSource = await readFile(
  new URL("../packages/agent-adapters/src/codex-app-server-adapter.ts", import.meta.url),
  "utf8",
);
const claudeCliSource = await readFile(
  new URL("../packages/agent-adapters/src/claude-cli-adapter.ts", import.meta.url),
  "utf8",
);

const current = {
  codex: readFirstArrayVersion(codexSource, "CODEX_APP_SERVER_TESTED_VERSIONS"),
  claudeSdk: requireVersion(
    adapterPackage.dependencies?.["@anthropic-ai/claude-agent-sdk"],
    "@anthropic-ai/claude-agent-sdk dependency",
  ),
  claudeCli: readFirstArrayVersion(claudeCliSource, "CLAUDE_CLI_TESTED_VERSIONS"),
};

const candidates = [
  candidate("@openai/codex", "Codex App Server and CLI", current.codex),
  candidate("@anthropic-ai/claude-agent-sdk", "Claude Agent SDK", current.claudeSdk),
  candidate("@anthropic-ai/claude-code", "Claude Code CLI", current.claudeCli),
];

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      checkedAt: new Date().toISOString(),
      repositoryRoot,
      mode: "discovery-only",
      candidates,
      updateAvailable: candidates.some((entry) => entry.updateAvailable),
      nextStep:
        "An update candidate is not a compatibility approval. Update exact pins on a branch, run pnpm providers:verify-codex-protocol for Codex, review other provider schemas where available, then run focused adapter conformance and the affected release gates before promotion.",
    },
    null,
    2,
  )}\n`,
);

function candidate(packageName, component, currentVersion) {
  const latestVersion = npmViewVersion(packageName);
  return {
    packageName,
    component,
    currentVersion,
    latestVersion,
    updateAvailable: currentVersion !== latestVersion,
    alreadyPinned: currentVersion === latestVersion,
  };
}

function npmViewVersion(packageName) {
  const result = spawnSync("npm", ["view", packageName, "version"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail =
      result.error?.message ??
      result.stderr?.trim() ??
      `npm exited with status ${String(result.status)}`;
    throw new Error(`Could not query ${packageName}: ${detail}`);
  }
  return requireVersion(result.stdout.trim(), `${packageName} registry version`);
}

function readFirstArrayVersion(source, exportName) {
  const match = new RegExp(
    `export const ${exportName} = \\["([0-9]+\\.[0-9]+\\.[0-9]+)"`,
    "u",
  ).exec(source);
  return requireVersion(match?.[1], exportName);
}

function requireVersion(value, label) {
  if (typeof value !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(value)) {
    throw new Error(`${label} is not an exact semantic version.`);
  }
  return value;
}
