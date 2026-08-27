import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { RELEASE_SKILL_DIRECTORIES, renderBundleReadme } from "../build-release.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const projectSkillRoot = join(repositoryRoot, ".agents", "skills");

async function readRepositoryFile(path) {
  return readFile(join(repositoryRoot, path), "utf8");
}

function parseFrontmatter(content) {
  assert.match(content, /^---\r?\n/u, "SKILL.md must start with YAML frontmatter");
  const closingMatch = /\r?\n---\r?\n/u.exec(content.slice(4));
  const closing = closingMatch === null ? -1 : 4 + closingMatch.index;
  assert.notEqual(closing, -1, "SKILL.md must close YAML frontmatter");
  const frontmatter = content.slice(4, closing).split(/\r?\n/u);
  const body = content.slice(closing + closingMatch[0].length).trim();
  const fields = new Map();
  for (const line of frontmatter) {
    const match = /^(?<key>[A-Za-z0-9_-]+):\s*(?<value>.+)$/u.exec(line);
    if (match?.groups !== undefined) {
      fields.set(match.groups.key, match.groups.value.trim());
    }
  }
  return { body, fields };
}

test("source checkout exposes one canonical copy of each project skill", async () => {
  assert.deepEqual(RELEASE_SKILL_DIRECTORIES, ["opendelegate-init", "opendelegate-join"]);
  await assert.rejects(stat(join(repositoryRoot, "skills", "opendelegate-init")), /ENOENT/u);
  await assert.rejects(stat(join(repositoryRoot, "skills", "opendelegate-join")), /ENOENT/u);

  for (const skill of RELEASE_SKILL_DIRECTORIES) {
    const sourcePath = join(projectSkillRoot, skill, "SKILL.md");
    const metadata = await stat(sourcePath);
    assert.equal(metadata.isFile(), true, `${skill} source SKILL.md must exist`);
    const content = await readFile(sourcePath, "utf8");
    const { body, fields } = parseFrontmatter(content);
    assert.equal(fields.get("name"), skill);
    assert.equal(fields.has("description"), true);
    assert.equal(fields.get("description").length <= 60, true);
    assert.equal(fields.has("version"), true);
    assert.equal(fields.get("platforms"), "[linux, macos, windows]");
    assert.notEqual(body.length, 0);
  }
});

test("source docs point to .agents skills and bundle output keeps skills paths", async () => {
  const [readme, guide, hermesGuide, releaseBuilder] = await Promise.all([
    readRepositoryFile("README.md"),
    readRepositoryFile("docs/GETTING_STARTED.md"),
    readRepositoryFile("docs/HERMES_SETUP_AGENT.md"),
    readRepositoryFile("tooling/build-release.mjs"),
  ]);

  for (const content of [readme, guide, hermesGuide]) {
    assert.match(content, /\.agents\/skills\/opendelegate-init\/SKILL\.md/u);
    assert.match(content, /\.agents\/skills\/opendelegate-join\/SKILL\.md/u);
  }
  assert.match(hermesGuide, /skills\/opendelegate-init\/SKILL\.md/u);
  assert.match(hermesGuide, /skills\/opendelegate-join\/SKILL\.md/u);
  assert.match(
    hermesGuide,
    /does not claim that Hermes is a first-class OpenDelegate runtime Agent Adapter/u,
  );

  assert.match(
    releaseBuilder,
    /join\(sourceRoot, "\.agents", "skills", skill\).*join\(staging, "skills", skill\)/su,
  );

  const bundleReadme = renderBundleReadme(
    "internal-preview-blocked",
    { implementation: { partial: 36 }, liveProof: { "blocked-external": 15, "not-run": 21 } },
    "win32",
    "x64",
    "0.1.0-alpha.1",
  );
  assert.match(bundleReadme, /skills\/opendelegate-join\/SKILL\.md/u);
  assert.doesNotMatch(bundleReadme, /\.agents\/skills/u);
});

test("localized source READMEs do not introduce Hermes runtime-adapter claims", async () => {
  const localized = [
    "README.ko.md",
    "README.ja.md",
    "README.fr.md",
    "README.es.md",
    "README.zh-CN.md",
  ];
  for (const filename of localized) {
    const content = await readRepositoryFile(filename);
    assert.doesNotMatch(
      content,
      /Hermes[^\n]{0,80}(?:runtime|Runtime)[^\n]{0,80}(?:adapter|Adapter)/u,
    );
  }
  const docs = await readdir(join(repositoryRoot, "docs"));
  assert.equal(docs.includes("HERMES_SETUP_AGENT.md"), true);
});
