import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const skillRoot = join(repositoryRoot, ".agents", "skills");

function frontmatter(content) {
  const match = /^---\r?\n(?<data>[\s\S]*?)\r?\n---\r?\n(?<body>[\s\S]+)$/u.exec(content);
  assert.notEqual(match, null);
  return { data: match.groups.data, body: match.groups.body };
}

test("SSH-first init and join skills are discoverable and bounded", async () => {
  const [initContent, joinContent, initMetadata, joinMetadata] = await Promise.all([
    readFile(join(skillRoot, "opendelegate-init", "SKILL.md"), "utf8"),
    readFile(join(skillRoot, "opendelegate-join", "SKILL.md"), "utf8"),
    readFile(join(skillRoot, "opendelegate-init", "agents", "openai.yaml"), "utf8"),
    readFile(join(skillRoot, "opendelegate-join", "agents", "openai.yaml"), "utf8"),
  ]);
  const init = frontmatter(initContent);
  const joinSkill = frontmatter(joinContent);

  assert.match(init.data, /name: opendelegate-init/u);
  assert.match(init.data, /version: 0\.2\.0/u);
  assert.match(init.body, /SSH/u);
  assert.match(init.body, /hermes peer add/u);
  assert.match(init.body, /OPENDELEGATE_PEER_KEY/u);
  assert.match(init.body, /OPENDELEGATE_PEER_NOTE/u);
  assert.match(init.body, /--note/u);
  assert.match(init.body, /--note "\$OPENDELEGATE_PEER_NOTE" --key "\$OPENDELEGATE_PEER_KEY"/u);
  assert.match(init.body, /encrypted/u);
  assert.match(init.body, /masked|no-echo/u);
  assert.doesNotMatch(init.body, /--key <API_SERVER_KEY>/u);
  assert.match(init.body, /hermes peer dm/u);
  assert.doesNotMatch(init.body, /hermes peer dm --timeout/u);
  assert.match(init.body, /echo OpenDelegate-SSH-ready/u);
  assert.doesNotMatch(init.body, /TARGET true/u);
  assert.match(init.body, /ssh -t TARGET hermes setup/u);
  assert.match(init.body, /ssh -t TARGET hermes gateway setup/u);
  assert.match(init.body, /OpenDelegate-Agent-ready/u);
  assert.match(init.body, /Do not create an OpenDelegate Admin Web/u);
  assert.match(init.body, /unexpected change is a hard failure/u);

  assert.match(joinSkill.data, /name: opendelegate-join/u);
  assert.match(joinSkill.data, /version: 0\.2\.0/u);
  assert.match(joinSkill.body, /Add or repair one Device/u);
  assert.match(joinSkill.body, /Do not use Admin Web or\s+an enrollment grant/u);
  assert.match(joinSkill.body, /Preserve Device-local config/u);
  assert.match(joinSkill.body, /hermes peer add/u);
  assert.match(joinSkill.body, /OPENDELEGATE_PEER_KEY/u);
  assert.match(joinSkill.body, /OPENDELEGATE_PEER_NOTE/u);
  assert.match(joinSkill.body, /--note/u);
  assert.match(joinSkill.body, /encrypted/u);
  assert.match(joinSkill.body, /masked|no-echo/u);
  assert.doesNotMatch(joinSkill.body, /--key <API_SERVER_KEY>/u);
  assert.match(joinSkill.body, /Do not infer power state from API state/u);
  assert.doesNotMatch(joinSkill.body, /hermes peer dm --timeout/u);
  assert.match(joinSkill.body, /echo OpenDelegate-SSH-ready/u);
  assert.doesNotMatch(joinSkill.body, /TARGET true/u);
  assert.match(joinSkill.body, /ssh -t TARGET hermes setup/u);
  assert.match(joinSkill.body, /ssh -t TARGET hermes gateway setup/u);

  for (const metadata of [initMetadata, joinMetadata]) {
    assert.match(metadata, /SSH|Origin|Hermes peer/u);
    assert.doesNotMatch(metadata, /\bMain\b|\bWorker\b|enroll/u);
  }
});

test("current project routing ignores the legacy web prototype", async () => {
  const [agents, claude, context, templateContent, template] = await Promise.all([
    readFile(join(repositoryRoot, "AGENTS.md"), "utf8"),
    readFile(join(repositoryRoot, "CLAUDE.md"), "utf8"),
    readFile(join(repositoryRoot, "CONTEXT.md"), "utf8"),
    readFile(join(repositoryRoot, "templates", "DEVICE.md"), "utf8"),
    stat(join(repositoryRoot, "templates", "DEVICE.md")),
  ]);

  assert.match(agents, /OpenDelegate is SSH-first Hermes Device federation/u);
  assert.match(agents, /legacy prototype/u);
  assert.match(agents, /docs\/design\//u);
  assert.match(agents, /Never infer that a Device is powered off/u);
  assert.match(agents, /hermes peer list/u);
  assert.match(claude, /CONTEXT\.md.*current source of truth/su);
  assert.doesNotMatch(claude, /together define the product/u);
  assert.match(context, /SSH is bootstrap and recovery/u);
  assert.match(context, /No enrollment grants/u);
  assert.match(context, /encrypted transport/u);
  assert.match(context, /docs\/design\//u);
  assert.match(templateContent, /Origin peer note/u);
  assert.match(templateContent, /encrypted/u);
  assert.equal(template.isFile(), true);
});
