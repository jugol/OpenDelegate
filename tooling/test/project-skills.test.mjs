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

test("Getting Started keeps source and bundle skill paths distinct", async () => {
  const guide = await readRepositoryFile("docs/GETTING_STARTED.md");
  const bundleInventory = guide.slice(
    guide.indexOf("A bundle contains:"),
    guide.indexOf("Obtain the checksum through the trusted publication channel"),
  );
  assert.match(bundleInventory, /skills\/opendelegate-init\/SKILL\.md/u);
  assert.match(bundleInventory, /skills\/opendelegate-join\/SKILL\.md/u);
  assert.doesNotMatch(bundleInventory, /\.agents\/skills/u);

  assert.match(guide, /source or `skills\/opendelegate-init\/SKILL\.md` from a bundle/u);
  assert.match(guide, /source or `skills\/opendelegate-join\/SKILL\.md` from a bundle/u);
});

test("Korean README links Hermes setup guidance without runtime-adapter claims", async () => {
  const readme = await readRepositoryFile("README.ko.md");
  assert.match(readme, /Hermes Setup Agent 가이드\(영문\)\]\(docs\/HERMES_SETUP_AGENT\.md\)/u);
  assert.match(readme, /Codex나 Claude, Hermes 같은 유능한 로컬 setup Agent/u);
  assert.match(
    readme,
    /Hermes를 OpenDelegate 실행용 Agent Adapter로 구현하거나 지원한다고 주장하지 않습니다/u,
  );
  assert.doesNotMatch(
    readme,
    /Hermes[^\n]{0,80}(?:runtime|Runtime)[^\n]{0,80}(?:adapter|Adapter)/u,
  );
});

test("setup docs route Main and Worker skills by input type", async () => {
  const [readme, koreanReadme, guide] = await Promise.all([
    readRepositoryFile("README.md"),
    readRepositoryFile("README.ko.md"),
    readRepositoryFile("docs/GETTING_STARTED.md"),
  ]);

  const readmeDetailedSetup = readme.slice(
    readme.indexOf("## Detailed setup"),
    readme.indexOf("Each Device defaults to"),
  );
  assert.match(
    readmeDetailedSetup,
    /\.agents\/skills\/opendelegate-init\/SKILL\.md` from a source checkout or\s+`skills\/opendelegate-init\/SKILL\.md` from a verified bundle/u,
  );
  assert.match(
    readmeDetailedSetup,
    /\.agents\/skills\/opendelegate-join\/SKILL\.md` from a source checkout or\s+`skills\/opendelegate-join\/SKILL\.md` from a verified bundle/u,
  );

  const koreanDetailedSetup = koreanReadme.slice(
    koreanReadme.indexOf("## 상세 설정"),
    koreanReadme.indexOf("각 Device의 기본값"),
  );
  assert.match(
    koreanDetailedSetup,
    /source\s+checkout이면 `\.agents\/skills\/opendelegate-init\/SKILL\.md`, 검증된 bundle이면\s+`skills\/opendelegate-init\/SKILL\.md`/u,
  );
  assert.match(
    koreanDetailedSetup,
    /source\s+checkout이면\s+`\.agents\/skills\/opendelegate-join\/SKILL\.md`, 검증된 bundle이면 `skills\/opendelegate-join\/SKILL\.md`/u,
  );

  const guideIntro = guide.slice(0, guide.indexOf("> [!IMPORTANT]"));
  assert.match(
    guideIntro,
    /\.agents\/skills\/opendelegate-init\/SKILL\.md` from source or `skills\/opendelegate-init\/SKILL\.md` from a\s+bundle/u,
  );
  assert.match(
    guideIntro,
    /\.agents\/skills\/opendelegate-join\/SKILL\.md`\s+from source or `skills\/opendelegate-join\/SKILL\.md` from a bundle/u,
  );
});
