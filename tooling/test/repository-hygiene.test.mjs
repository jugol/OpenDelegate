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
  assert.match(
    config,
    /url:\s*https:\/\/github\.com\/jugol\/OpenDelegate\/security\/advisories\/new/u,
  );
  assert.match(
    securityPolicy,
    /https:\/\/github\.com\/jugol\/OpenDelegate\/security\/advisories\/new/u,
  );
  assert.match(securityPolicy, /Do not use a GitHub issue/u);
  assert.match(
    threatModelForm,
    /https:\/\/github\.com\/jugol\/OpenDelegate\/security\/advisories\/new/u,
  );
  assert.match(threatModelForm, /id:\s*disclosure_safety/u);
  assert.match(threatModelForm, /contains no undisclosed vulnerability/u);
  await assert.rejects(access(obsoletePublicForm), { code: "ENOENT" });
});
