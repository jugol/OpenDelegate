import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

async function readRepositoryFile(path) {
  return readFile(new URL(`../../${path}`, import.meta.url), "utf8");
}

test("README leads with SSH-first Hermes federation", async () => {
  const [
    readme,
    korean,
    context,
    guide,
    hermesGuide,
    template,
    packageManifest,
    contributing,
    security,
    releaseBuilder,
  ] = await Promise.all([
    readRepositoryFile("README.md"),
    readRepositoryFile("README.ko.md"),
    readRepositoryFile("CONTEXT.md"),
    readRepositoryFile("docs/GETTING_STARTED.md"),
    readRepositoryFile("docs/HERMES_SETUP_AGENT.md"),
    stat(new URL("../../templates/DEVICE.md", import.meta.url)),
    readRepositoryFile("package.json"),
    readRepositoryFile("CONTRIBUTING.md"),
    readRepositoryFile("SECURITY.md"),
    readRepositoryFile("tooling/build-release.mjs"),
  ]);

  assert.match(readme, /setting up and operating Hermes Agents across several computers/u);
  assert.match(readme, /SSH is the bootstrap and recovery channel/u);
  assert.match(readme, /Hermes Peer API is the normal Agent-to-Agent work channel/u);
  assert.match(readme, /There is no OpenDelegate Admin Web/u);
  assert.match(readme, /There is no enrollment-grant workflow/u);
  assert.match(readme, /hermes skills trust/u);
  assert.match(readme, /hermes peer dm/u);
  assert.match(readme, /Legacy prototype notice/u);
  assert.match(readme, /hermes-agent\.nousresearch\.com\/docs\/getting-started\/installation/u);
  assert.match(readme, /You do not need pnpm, Node\.js, `apps\/`, or `packages\/`/u);
  assert.doesNotMatch(readme, /hermes peer dm --timeout/u);

  assert.match(korean, /SSH는 최초 설정과 복구 Channel/u);
  assert.match(korean, /OpenDelegate Admin Web을 따로 설치하거나 관리하지 않습니다/u);
  assert.match(korean, /Enrollment Grant 절차를 사용하지 않습니다/u);

  assert.match(context, /SSH-first direction confirmed/u);
  assert.match(context, /No separate web control plane/u);
  assert.match(context, /Peer API is the normal work channel/u);

  assert.match(guide, /## 2\. Verify SSH identity and reachability/u);
  assert.match(
    guide,
    /ssh -o BatchMode=yes -o ConnectTimeout=10 TARGET "echo OpenDelegate-SSH-ready"/u,
  );
  assert.doesNotMatch(guide, /TARGET true/u);
  assert.match(guide, /ssh -t TARGET hermes setup/u);
  assert.match(guide, /ssh -t TARGET hermes gateway setup/u);
  assert.match(guide, /hermes chat -q "Reply with exactly: OpenDelegate-Agent-ready"/u);
  assert.match(guide, /hermes gateway setup/u);
  assert.match(guide, /hermes peer add/u);
  assert.match(guide, /hermes peer dm DEVICE_NAME/u);
  assert.doesNotMatch(guide, /hermes peer dm --timeout/u);

  assert.match(hermesGuide, /SSH-first Device\s+federation/u);
  assert.match(hermesGuide, /API_SERVER_KEY/u);
  assert.match(hermesGuide, /owner-controlled TTY/u);
  assert.match(hermesGuide, /hermes setup/u);
  assert.doesNotMatch(hermesGuide, /hermes peer dm --timeout/u);
  assert.equal(template.isFile(), true);

  assert.match(packageManifest, /SSH-first procedures/u);
  assert.doesNotMatch(packageManifest, /"description": "A personal, self-hosted control plane/u);
  assert.match(contributing, /CONTEXT\.md` is the current product contract/u);
  assert.match(contributing, /Legacy prototype development environment/u);
  assert.match(security, /Current security boundaries/u);
  assert.match(security, /failed `\/health` probe does not prove a Device is powered off/u);
  assert.match(releaseBuilder, /LEGACY_RELEASE_DISABLED_MESSAGE/u);
  assert.match(releaseBuilder, /bundle builder is retired/u);
});

test("legacy product documents are visibly deprecated", async () => {
  for (const filename of [
    "docs/PRODUCT_SPEC.md",
    "docs/IMPLEMENTATION_PLAN.md",
    "docs/DECISIONS.md",
  ]) {
    const content = await readRepositoryFile(filename);
    assert.match(content, /Legacy prototype/u);
    assert.match(content, /CONTEXT\.md/u);
  }
});

test("every localized README uses the SSH-first flow", async () => {
  for (const filename of [
    "README.ja.md",
    "README.fr.md",
    "README.es.md",
    "README.zh-CN.md",
    "README.zh-TW.md",
  ]) {
    const content = await readRepositoryFile(filename);
    assert.match(content, /SSH/u);
    assert.match(content, /Peer|ピア|对等|對等/u);
    assert.match(content, /hermes skills trust/u);
    assert.doesNotMatch(content, /Admin Web →|Main Admin Web|Configuration Chat/u);
  }
});
