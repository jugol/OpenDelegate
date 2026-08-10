import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build as bundle } from "esbuild";

test("release scratch and accidentally rooted host paths stay outside the checkout", async () => {
  const rootEntries = await readdir(new URL("../../", import.meta.url), {
    withFileTypes: true,
  });
  const forbidden = rootEntries
    .filter(
      (entry) =>
        entry.name === "Users" ||
        entry.name === "home" ||
        entry.name === "tmp" ||
        entry.name === "var" ||
        entry.name.startsWith(".od-") ||
        entry.name.startsWith("odhoist-"),
    )
    .map((entry) => entry.name)
    .sort();

  assert.deepEqual(forbidden, []);
});

test("every remote GitHub Action is pinned to an immutable commit with a version comment", async () => {
  const workflowDirectory = new URL("../../.github/workflows/", import.meta.url);
  const workflowFiles = (await readdir(workflowDirectory))
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .sort();
  const mutableReferences = [];

  for (const workflowFile of workflowFiles) {
    const source = await readFile(new URL(workflowFile, workflowDirectory), "utf8");
    for (const [index, line] of source.split(/\r?\n/u).entries()) {
      const remoteAction = line.match(/^\s*uses:\s*([^./\s][^@\s]*)@(\S+)(?:\s+#\s+(\S+))?\s*$/u);
      if (remoteAction === null) {
        continue;
      }

      const [, action, revision, version] = remoteAction;
      if (!/^[a-f0-9]{40}$/u.test(revision ?? "") || !/^v\d/u.test(version ?? "")) {
        mutableReferences.push(
          `${workflowFile}:${index + 1} ${action ?? "unknown"}@${revision ?? "missing"}`,
        );
      }
    }
  }

  assert.deepEqual(mutableReferences, []);
});

test("hosted CI uses named OS images that match the declared compatibility matrix", async () => {
  const workflowDirectory = new URL("../../.github/workflows/", import.meta.url);
  const workflowFiles = (await readdir(workflowDirectory))
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .sort();
  const mutableRunnerLabels = [];

  for (const workflowFile of workflowFiles) {
    const source = await readFile(new URL(workflowFile, workflowDirectory), "utf8");
    for (const [index, line] of source.split(/\r?\n/u).entries()) {
      if (/\b(?:ubuntu|windows|macos)-latest\b/u.test(line)) {
        mutableRunnerLabels.push(`${workflowFile}:${index + 1} ${line.trim()}`);
      }
    }
  }

  assert.deepEqual(mutableRunnerLabels, []);

  const supportMatrix = await readFile(
    new URL("../../docs/release/SUPPORT_MATRIX.md", import.meta.url),
    "utf8",
  );
  for (const image of ["ubuntu-24.04", "windows-2025", "macos-26"]) {
    assert.equal(supportMatrix.includes(`\`${image}\``), true);
  }
});

test("pull requests stay lean while release validation retains the bounded platform matrix", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../../apps/main/package.json", import.meta.url), "utf8"),
  );
  const pullRequestWorkflow = await readFile(
    new URL("../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const releaseWorkflow = await readFile(
    new URL("../../.github/workflows/release-validation.yml", import.meta.url),
    "utf8",
  );

  assert.equal(
    manifest.scripts?.test,
    "node --experimental-strip-types --test --test-concurrency=2",
  );
  assert.equal(
    manifest.scripts?.["test:serial"],
    "node --experimental-strip-types --test --test-concurrency=1",
  );
  assert.match(pullRequestWorkflow, /^name:\s*Pull request\s*$/mu);
  assert.match(pullRequestWorkflow, /^\s+pull_request:\s*$/mu);
  assert.doesNotMatch(pullRequestWorkflow, /^\s+push:\s*$/mu);
  assert.doesNotMatch(pullRequestWorkflow, /^\s+workflow_dispatch:\s*$/mu);
  assert.match(pullRequestWorkflow, /^\s+name:\s*Validate pull request\s*$/mu);
  assert.match(pullRequestWorkflow, /^\s+runs-on:\s*ubuntu-24\.04\s*$/mu);
  assert.match(pullRequestWorkflow, /^\s+timeout-minutes:\s*15\s*$/mu);
  assert.match(pullRequestWorkflow, /^\s+fetch-depth:\s*0\s*$/mu);
  assert.doesNotMatch(pullRequestWorkflow, /^\s+run:\s*pnpm check\s*$/mu);
  assert.match(pullRequestWorkflow, /Test and build affected workspaces/u);
  assert.match(pullRequestWorkflow, /--filter "\.\.\.\[\$PR_BASE_SHA\]"/u);
  assert.match(
    pullRequestWorkflow,
    /git diff --quiet "\$PR_BASE_SHA"\.\.\.HEAD -- package\.json pnpm-lock\.yaml pnpm-workspace\.yaml/u,
  );
  assert.match(pullRequestWorkflow, /--recursive --filter "!opendelegate"/u);
  assert.match(pullRequestWorkflow, /Determine Admin Web browser scope/u);
  assert.match(pullRequestWorkflow, /if:\s*steps\.browser-scope\.outputs\.required == 'true'/u);
  assert.doesNotMatch(pullRequestWorkflow, /^\s+matrix:\s*$/mu);
  assert.doesNotMatch(pullRequestWorkflow, /release:build/u);

  assert.match(releaseWorkflow, /^name:\s*Release validation\s*$/mu);
  assert.match(releaseWorkflow, /^\s+workflow_dispatch:\s*$/mu);
  assert.doesNotMatch(releaseWorkflow, /^\s+pull_request:\s*$/mu);
  assert.doesNotMatch(releaseWorkflow, /^\s+push:\s*$/mu);
  assert.match(
    releaseWorkflow,
    /jobs:\s*\n\s*verify:[\s\S]*?\n\s+timeout-minutes:\s*\$\{\{\s*matrix\.timeout_minutes\s*\}\}\s*$/mu,
  );
  for (const [os, timeout] of [
    ["ubuntu-24.04", 30],
    ["windows-2025", 50],
    ["macos-26", 30],
  ]) {
    assert.match(
      releaseWorkflow,
      new RegExp(`- os: ${os.replaceAll(".", "\\.")}\\s+timeout_minutes: ${timeout}`, "u"),
    );
  }
});

test("the Main host-permission override remains test-only with native security coverage", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../../apps/main/package.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(manifest.exports, { ".": "./src/index.ts" });
  const runtimeBoundary = await readFile(
    new URL("../../apps/main/src/internal/runtime-permissions.ts", import.meta.url),
    "utf8",
  );
  const publicRuntime = await readFile(
    new URL("../../apps/main/src/index.ts", import.meta.url),
    "utf8",
  );
  const productionCli = await readFile(
    new URL("../../apps/main/src/cli.ts", import.meta.url),
    "utf8",
  );
  const portableFixture = await readFile(
    new URL("../../apps/main/test-fixtures/portable-main-runtime.ts", import.meta.url),
    "utf8",
  );
  const nativeSecuritySmoke = await readFile(
    new URL("../../apps/main/test/runtime-permissions-native.test.ts", import.meta.url),
    "utf8",
  );

  assert.match(runtimeBoundary, /withHostRuntimePermissionEnforcerForTest/u);
  assert.doesNotMatch(runtimeBoundary, /OPENDELEGATE_TEST|NODE_ENV/u);
  assert.doesNotMatch(publicRuntime, /withHostRuntimePermissionEnforcerForTest/u);
  assert.doesNotMatch(publicRuntime, /runtimePermissionEnforcer|hostPermissionEnforcer/u);
  assert.doesNotMatch(productionCli, /withHostRuntimePermissionEnforcerForTest/u);
  assert.match(portableFixture, /withHostRuntimePermissionEnforcerForTest/u);
  assert.match(nativeSecuritySmoke, /from "\.\.\/src\/index\.ts"/u);
  assert.doesNotMatch(
    nativeSecuritySmoke,
    /portable-main-runtime|withHostRuntimePermissionEnforcerForTest/u,
  );
  for (const invariant of [
    /createMainRuntime/u,
    /initializeMainHome/u,
    /main\.sqlite3-wal/u,
    /main\.sqlite3-shm/u,
    /\*S-1-5-11:\(OI\)\(CI\)RX/u,
    /AreAccessRulesProtected/u,
    /FileSystemRights\]::FullControl/u,
    /RUNTIME_PATH_UNSAFE/u,
    /"junction"/u,
  ]) {
    assert.match(nativeSecuritySmoke, invariant);
  }
});

test("production application bundles exclude first-party test access paths", async () => {
  const repositoryRoot = new URL("../../", import.meta.url);
  const mainExternals = ["@node-rs/argon2", "@node-rs/argon2-*", "better-sqlite3", "pg"];
  const configurations = [
    {
      entryPoint: "apps/main/src/cli.ts",
      externals: mainExternals,
      label: "Main",
    },
    {
      entryPoint: "apps/worker/src/cli.ts",
      externals: ["better-sqlite3"],
      label: "Worker",
    },
    {
      entryPoint: "apps/service-host/src/core-entry.ts",
      externals: mainExternals,
      label: "service host",
    },
    {
      entryPoint: "apps/service-host/src/helper-entry.ts",
      externals: mainExternals,
      label: "session helper",
    },
  ];

  for (const configuration of configurations) {
    const result = await bundle({
      absWorkingDir: fileURLToPath(repositoryRoot),
      bundle: true,
      entryPoints: [configuration.entryPoint],
      external: configuration.externals,
      format: "esm",
      logLevel: "silent",
      metafile: true,
      platform: "node",
      target: "node24.18",
      treeShaking: true,
      write: false,
    });
    const source = result.outputFiles.map((output) => output.text).join("\n");
    const testInputs = Object.keys(result.metafile.inputs)
      .map((path) => path.replaceAll("\\", "/"))
      .filter((path) => /(?:^|\/)(?:test|test-fixtures|test-support)(?:\/|$)/u.test(path));
    const firstPartyExternalImports = Object.values(result.metafile.outputs)
      .flatMap((output) => output.imports)
      .filter((entry) => entry.external && entry.path.startsWith("@opendelegate/"))
      .map((entry) => entry.path)
      .sort();

    assert.notEqual(source, "", `${configuration.label} should emit a production bundle`);
    assert.deepEqual(testInputs, [], `${configuration.label} should not bundle test inputs`);
    assert.deepEqual(
      firstPartyExternalImports,
      [],
      `${configuration.label} should not retain first-party package imports`,
    );
    assert.equal(
      source.includes("withHostRuntimePermissionEnforcerForTest"),
      false,
      `${configuration.label} should tree-shake the test permission setter`,
    );
    assert.equal(
      source.includes("portable-main-runtime"),
      false,
      `${configuration.label} should not include the portable test fixture`,
    );
  }
});

test("secret scanning verifies a pinned Gitleaks binary against the full Git history", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/security.yml", import.meta.url),
    "utf8",
  );
  const ignoreFile = await readFile(new URL("../../.gitleaksignore", import.meta.url), "utf8");
  const ignoredFingerprints = ignoreFile
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

  assert.match(workflow, /fetch-depth:\s*0/u);
  assert.match(workflow, /GITLEAKS_VERSION:\s*8\.30\.1/u);
  assert.match(
    workflow,
    /GITLEAKS_ARCHIVE_SHA256:\s*551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb/u,
  );
  assert.match(workflow, /sha256sum --check/u);
  assert.match(workflow, /gitleaks" git --no-banner --redact --log-opts="--all" \./u);
  assert.doesNotMatch(workflow, /gitleaks\/gitleaks-action@/u);
  assert.equal(ignoredFingerprints.length, 66);
  assert.equal(new Set(ignoredFingerprints).size, ignoredFingerprints.length);
  const allowedCommits = new Map([
    ["a5ba2c415d8444471c6a554384e2af5f852b31fa", 0],
    ["03b11178532aa62d2ded78eef3013e93ed7925f0", 0],
    ["f87d7c93ec2e7acbb3a938220e6a9f41632d1171", 0],
    ["7a5ad34e1faa223e243fa1fe1f08148b091a0dbd", 0],
    ["e953ec34a1150c4765949e7dfd65ba219d7519af", 0],
    ["978aa848f000b97869223e674994921a94c10659", 0],
  ]);
  for (const fingerprint of ignoredFingerprints) {
    const match = fingerprint.match(
      /^([0-9a-f]{40}):[^:]+:(?:generic-api-key|private-key):[1-9]\d*$/u,
    );
    assert.notEqual(match, null);
    assert.equal(allowedCommits.has(match[1]), true);
    allowedCommits.set(match[1], allowedCommits.get(match[1]) + 1);
  }
  assert.deepEqual([...allowedCommits.values()], [26, 26, 1, 1, 6, 6]);
});

test("dependency review and audit reject moderate or higher advisories", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/security.yml", import.meta.url),
    "utf8",
  );

  assert.match(workflow, /fail-on-severity:\s*moderate/u);
  assert.match(workflow, /pnpm audit --audit-level moderate/u);
  assert.doesNotMatch(workflow, /(?:fail-on-severity|audit-level):?\s*high/u);
});

test("public issue intake directs vulnerabilities to the verified private reporting route", async () => {
  const config = await readFile(
    new URL("../../.github/ISSUE_TEMPLATE/config.yml", import.meta.url),
    "utf8",
  );
  const securityPolicy = await readFile(new URL("../../SECURITY.md", import.meta.url), "utf8");
  const threatModelForm = await readFile(
    new URL("../../.github/ISSUE_TEMPLATE/threat-model.yml", import.meta.url),
    "utf8",
  );
  const obsoletePublicForm = new URL(
    "../../.github/ISSUE_TEMPLATE/security-channel.yml",
    import.meta.url,
  );

  assert.match(config, /^blank_issues_enabled:\s*false\s*$/mu);
  assert.equal(
    hasExactTrimmedLine(
      config,
      "url: https://github.com/jugol/OpenDelegate/security/advisories/new",
    ),
    true,
  );
  assert.equal(
    hasExactTrimmedLine(
      securityPolicy,
      "[**Report a vulnerability privately**](https://github.com/jugol/OpenDelegate/security/advisories/new).",
    ),
    true,
  );
  assert.match(securityPolicy, /Do not use a GitHub issue/u);
  assert.equal(
    hasExactTrimmedLine(
      threatModelForm,
      "form: https://github.com/jugol/OpenDelegate/security/advisories/new",
    ),
    true,
  );
  assert.match(threatModelForm, /id:\s*disclosure_safety/u);
  assert.match(threatModelForm, /contains no undisclosed vulnerability/u);
  assert.equal(
    hasExactTrimmedLine(
      "url: https://github.com/jugol/OpenDelegate/security/advisories/new.attacker.example",
      "url: https://github.com/jugol/OpenDelegate/security/advisories/new",
    ),
    false,
  );
  await assert.rejects(access(obsoletePublicForm), { code: "ENOENT" });
});

test("the canonical release ledger cannot omit the accepted six-locale Admin gate", async () => {
  const ledger = JSON.parse(
    await readFile(new URL("../../docs/release/acceptance-evidence.json", import.meta.url), "utf8"),
  );
  const byId = new Map(ledger.criteria.map((criterion) => [criterion.id, criterion]));
  const adminOutage = byId.get(30);
  const fullMatrix = byId.get(32);
  const requiredEvidence = [
    "apps/admin-web/src/i18n/i18n.test.tsx",
    "apps/admin-web/e2e/admin-overview.spec.ts",
  ];

  assert.ok(adminOutage);
  assert.ok(fullMatrix);
  assert.match(adminOutage.nextGate, /six-locale/u);
  assert.match(fullMatrix.title, /six-locale Admin/u);
  assert.match(fullMatrix.nextGate, /six-locale Admin/u);
  for (const evidence of requiredEvidence) {
    assert.ok(adminOutage.evidence.includes(evidence));
    assert.ok(fullMatrix.evidence.includes(evidence));
  }
});

function hasExactTrimmedLine(text, expected) {
  return text.split(/\r?\n/u).some((line) => line.trim() === expected);
}
