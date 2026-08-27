import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  copyReleaseSkills,
  RELEASE_SKILL_DIRECTORIES,
  renderBundleReadme,
} from "../build-release.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const projectSkillRoot = join(repositoryRoot, ".agents", "skills");

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function parseFrontmatter(content) {
  const match = /^---\r?\n(?<frontmatter>[\s\S]*?)\r?\n---\r?\n(?<body>[\s\S]+)$/u.exec(content);
  assert.notEqual(match, null, "SKILL.md must contain YAML frontmatter and a body");
  const fields = new Map();
  for (const line of match.groups.frontmatter.split(/\r?\n/u)) {
    const field = /^(?<key>[A-Za-z0-9_-]+):\s*(?<value>.+)$/u.exec(line);
    if (field?.groups !== undefined) {
      fields.set(field.groups.key, field.groups.value.trim());
    }
  }
  return { body: match.groups.body.trim(), fields };
}

test("source project skills expose portable bounded metadata", async () => {
  for (const skill of RELEASE_SKILL_DIRECTORIES) {
    const content = await readFile(join(projectSkillRoot, skill, "SKILL.md"), "utf8");
    const { body, fields } = parseFrontmatter(content);
    assert.equal(fields.get("name"), skill);
    assert.equal(fields.has("description"), true);
    assert.equal(fields.get("description").length <= 60, true);
    assert.equal(fields.get("version"), "0.1.0");
    assert.equal(fields.get("platforms"), "[linux, macos, windows]");
    assert.notEqual(body.length, 0);
  }
});

test("source project skills remain single-source and bundle-relative", async () => {
  assert.deepEqual(RELEASE_SKILL_DIRECTORIES, ["opendelegate-init", "opendelegate-join"]);
  assert.equal(await pathExists(join(repositoryRoot, "skills", "opendelegate-init")), false);
  assert.equal(await pathExists(join(repositoryRoot, "skills", "opendelegate-join")), false);

  for (const skill of RELEASE_SKILL_DIRECTORIES) {
    assert.equal(await pathExists(join(projectSkillRoot, skill, "SKILL.md")), true);
  }

  const staging = await mkdtemp(join(tmpdir(), "opendelegate-project-skills-"));
  try {
    await copyReleaseSkills(staging, repositoryRoot);
    const bundledInitPath = join(staging, "skills", "opendelegate-init", "SKILL.md");
    const bundledJoinPath = join(staging, "skills", "opendelegate-join", "SKILL.md");
    const bundledInit = await readFile(bundledInitPath, "utf8");

    assert.equal(await pathExists(bundledJoinPath), true);
    assert.match(bundledInit, /\.\.\/opendelegate-join\/SKILL\.md/u);
    assert.doesNotMatch(bundledInit, /\.agents\/skills/u);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
});

test("AGENTS routes Main and Worker setup by installation input", async () => {
  const agents = await readFile(join(repositoryRoot, "AGENTS.md"), "utf8");
  for (const path of [
    ".agents/skills/opendelegate-init/SKILL.md",
    ".agents/skills/opendelegate-join/SKILL.md",
    "skills/opendelegate-init/SKILL.md",
    "skills/opendelegate-join/SKILL.md",
  ]) {
    assert.match(agents, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  assert.match(agents, /setup Agent does\s+not become an OpenDelegate runtime Agent Adapter/u);
  assert.match(agents, /support status/u);
});

test("Hermes setup guide covers the complete safe newcomer path", async () => {
  const guide = await readFile(join(repositoryRoot, "docs", "HERMES_SETUP_AGENT.md"), "utf8");

  assert.match(guide, /iex \(irm https:\/\/hermes-agent\.nousresearch\.com\/install\.ps1\)/u);
  assert.match(guide, /curl -fsSL https:\/\/hermes-agent\.nousresearch\.com\/install\.sh \| bash/u);
  assert.match(guide, /hermes doctor/u);
  assert.match(guide, /git clone https:\/\/github\.com\/jugol\/OpenDelegate\.git/u);
  assert.match(guide, /git pull --ff-only/u);
  assert.match(guide, /hermes skills trust[\s\S]*start a fresh Hermes session/u);
  assert.match(guide, /release bundle[\s\S]*skills\/opendelegate-init\/SKILL\.md/u);
  assert.match(guide, /\.agents\/skills\/opendelegate-join\/SKILL\.md/u);
  assert.match(
    guide,
    /effective `HERMES_HOME`[\s\S]*outside both the checkout and release bundle/u,
  );
  assert.match(guide, /setup Agent[\s\S]*does not add a Hermes runtime Agent Adapter/u);
  assert.match(guide, /Set up OpenDelegate on this computer as my fixed, always-on Main Device/u);
  assert.match(guide, /Join this computer to my fixed OpenDelegate Main/u);
  assert.match(guide, /unsupported internal preview/u);
});

test("English and Korean newcomer entry points route Hermes safely", async () => {
  const [readme, korean, gettingStarted] = await Promise.all([
    readFile(join(repositoryRoot, "README.md"), "utf8"),
    readFile(join(repositoryRoot, "README.ko.md"), "utf8"),
    readFile(join(repositoryRoot, "docs", "GETTING_STARTED.md"), "utf8"),
  ]);

  for (const content of [readme, korean, gettingStarted]) {
    assert.match(content, /HERMES_SETUP_AGENT\.md/u);
    assert.match(content, /\.agents\/skills\/opendelegate-init\/SKILL\.md/u);
    assert.match(content, /skills\/opendelegate-init\/SKILL\.md/u);
    assert.match(content, /\.agents\/skills\/opendelegate-join\/SKILL\.md/u);
    assert.match(content, /skills\/opendelegate-join\/SKILL\.md/u);
  }

  assert.match(readme, /Codex, Claude, or Hermes/u);
  assert.match(readme, /hermes skills trust[\s\S]*fresh Hermes session/u);
  assert.match(
    readme,
    /does not claim or\s+implement Hermes as a first-class OpenDelegate runtime adapter/u,
  );
  assert.match(korean, /Codex나 Claude, Hermes/u);
  assert.match(korean, /hermes skills trust[\s\S]*새 Hermes 세션/u);
  assert.match(
    korean,
    /Hermes를 OpenDelegate 실행용 Agent Adapter로 구현하거나 지원한다고 주장하지 않습니다/u,
  );
  assert.match(gettingStarted, /effective\s+`HERMES_HOME`[\s\S]*outside/u);
});

test("every localized README distinguishes source and bundle skill paths", async () => {
  for (const filename of [
    "README.ko.md",
    "README.ja.md",
    "README.fr.md",
    "README.es.md",
    "README.zh-CN.md",
  ]) {
    const content = await readFile(join(repositoryRoot, filename), "utf8");
    for (const skill of RELEASE_SKILL_DIRECTORIES) {
      assert.match(content, new RegExp(`\\.agents/skills/${skill}/SKILL\\.md`, "u"));
      assert.match(content, new RegExp(`skills/${skill}/SKILL\\.md`, "u"));
    }
  }
});

test("generated release README exposes the Hermes bundle path", () => {
  const readme = renderBundleReadme(
    "internal-preview-blocked",
    { implementation: { partial: 36 }, liveProof: { "blocked-external": 15, "not-run": 21 } },
    "win32",
    "x64",
    "0.1.0-alpha.1",
    "en",
  );

  assert.match(readme, /Codex, Claude, or Hermes/u);
  assert.match(readme, /docs\/HERMES_SETUP_AGENT\.md/u);
  assert.match(readme, /skills\/opendelegate-init\/SKILL\.md/u);
  assert.match(readme, /skills\/opendelegate-join\/SKILL\.md/u);
  assert.doesNotMatch(readme, /\.agents\/skills/u);
});

test("Admin Device prompts route source setup Agents to project skills", async () => {
  for (const filename of [
    "messages.en.ts",
    "messages.ko.ts",
    "messages.ja.ts",
    "messages.fr.ts",
    "messages.es.ts",
    "messages.zh-CN.ts",
  ]) {
    const content = await readFile(
      join(repositoryRoot, "apps", "admin-web", "src", "i18n", filename),
      "utf8",
    );
    assert.match(content, /Hermes/u);
    assert.match(content, /\.agents\/skills\/opendelegate-join\/SKILL\.md/u);
  }
});

test("source maps and release evidence point to canonical project skills", async () => {
  for (const filename of [
    "README.md",
    "README.ko.md",
    "README.ja.md",
    "README.fr.md",
    "README.es.md",
    "README.zh-CN.md",
    "docs/adr/0003-phase-zero-module-map.md",
    "docs/release/acceptance-evidence.json",
  ]) {
    const content = await readFile(join(repositoryRoot, filename), "utf8");
    assert.match(content, /\.agents\/skills\/opendelegate-init/u);
    assert.match(content, /\.agents\/skills\/opendelegate-join/u);
  }

  const docsTest = await readFile(
    join(repositoryRoot, "tooling", "test", "getting-started-docs.test.mjs"),
    "utf8",
  );
  assert.match(docsTest, /readRepositoryFile\("\.agents\/skills\/opendelegate-init\/SKILL\.md"\)/u);
});

test("canonical decisions bound Hermes to setup-agent scope", async () => {
  const [specification, plan, decisions, adr] = await Promise.all([
    readFile(join(repositoryRoot, "docs", "PRODUCT_SPEC.md"), "utf8"),
    readFile(join(repositoryRoot, "docs", "IMPLEMENTATION_PLAN.md"), "utf8"),
    readFile(join(repositoryRoot, "docs", "DECISIONS.md"), "utf8"),
    readFile(join(repositoryRoot, "docs", "adr", "0059-hermes-setup-agent-onboarding.md"), "utf8"),
  ]);

  for (const content of [specification, plan, decisions, adr]) {
    assert.match(content, /Hermes/u);
    assert.match(content, /setup Agent/u);
    assert.match(content, /runtime\s+Agent Adapter/u);
  }
  assert.match(specification, /\.agents\/skills/u);
  assert.match(specification, /skills\/opendelegate-init\/SKILL\.md/u);
  assert.match(specification, /HERMES_HOME/u);
  assert.match(decisions, /## D-121 — Hermes is a setup Agent, not a runtime Adapter/u);
});
