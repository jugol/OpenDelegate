import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";

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

test("secret scanning verifies a pinned Gitleaks binary against the full Git history", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/security.yml", import.meta.url),
    "utf8",
  );

  assert.match(workflow, /fetch-depth:\s*0/u);
  assert.match(workflow, /GITLEAKS_VERSION:\s*8\.30\.1/u);
  assert.match(
    workflow,
    /GITLEAKS_ARCHIVE_SHA256:\s*551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb/u,
  );
  assert.match(workflow, /sha256sum --check/u);
  assert.match(workflow, /gitleaks" git --no-banner --redact --log-opts="--all" \./u);
  assert.doesNotMatch(workflow, /gitleaks\/gitleaks-action@/u);
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

function hasExactTrimmedLine(text, expected) {
  return text.split(/\r?\n/u).some((line) => line.trim() === expected);
}
