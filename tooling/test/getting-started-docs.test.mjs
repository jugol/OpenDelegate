import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function readRepositoryFile(path) {
  return readFile(new URL(`../../${path}`, import.meta.url), "utf8");
}

function assertAppearsBefore(content, first, second) {
  const firstOffset = content.indexOf(first);
  const secondOffset = content.indexOf(second);
  assert.notEqual(firstOffset, -1, `Missing expected documentation fragment: ${first}`);
  assert.notEqual(secondOffset, -1, `Missing expected documentation fragment: ${second}`);
  assert.equal(firstOffset < secondOffset, true, `${first} must appear before ${second}`);
}

test("README leads owners into one complete agent-first setup journey", async () => {
  const [readme, guide, initSkill, supportMatrix] = await Promise.all([
    readRepositoryFile("README.md"),
    readRepositoryFile("docs/GETTING_STARTED.md"),
    readRepositoryFile("skills/opendelegate-init/SKILL.md"),
    readRepositoryFile("docs/release/SUPPORT_MATRIX.md"),
  ]);

  assertAppearsBefore(readme, "## Quick Start", "## Why OpenDelegate");
  const quickStart = readme.slice(
    readme.indexOf("## Quick Start"),
    readme.indexOf("## Why OpenDelegate"),
  );
  assert.match(quickStart, /\[complete setup guide\]\(docs\/GETTING_STARTED\.md\)/u);
  assert.match(quickStart, /\(docs\/DISCORD_SETUP\.md\)/u);
  assert.match(quickStart, /skills\/opendelegate-init\/SKILL\.md/u);
  assert.match(quickStart, /skills\/opendelegate-join\/SKILL\.md/u);
  assert.match(quickStart, /Guide me through every owner decision/u);
  assert.match(quickStart, /SHA256SUMS/u);
  assert.match(quickStart, /Admin Web/u);
  assert.match(quickStart, /Discord Forum post/u);
  assert.match(quickStart, /Tasks → New task/u);
  assert.match(quickStart, /Task/u);
  assert.match(quickStart, /before the\s+first Main initialization/u);
  assertAppearsBefore(quickStart, "skills/opendelegate-join/SKILL.md", "Discord Forum post");
  assert.equal(readme.includes(".\\opendelegate.cmd init --open"), false);
  assert.equal(readme.includes("./opendelegate init --open"), false);

  const journey = [
    "## Before you start",
    "## 1. Get an OpenDelegate bundle",
    "## 2. Initialize the fixed Main Device",
    "## 3. Claim owner access",
    "## 4. Finish setup in Admin Web",
    "## 5. Connect Discord Forum",
    "## 6. Add another Device",
    "## 7. Create your first Task",
    "## Daily operation",
    "## Recovery and troubleshooting",
  ];
  for (let index = 1; index < journey.length; index += 1) {
    assertAppearsBefore(guide, journey[index - 1], journey[index]);
  }

  assert.match(guide, /skills\/opendelegate-init\/SKILL\.md/u);
  assert.match(guide, /skills\/opendelegate-join\/SKILL\.md/u);
  assert.match(guide, /\(DISCORD_SETUP\.md\)/u);
  assert.match(guide, /ten one-time recovery codes/u);
  assert.match(guide, /opendelegate device grant/u);
  assert.match(guide, /\.\\opendelegate\.cmd device grant/u);
  assert.match(guide, /\.\/opendelegate device grant/u);
  assert.match(guide, /Never open, paste, or send the grant/u);
  assert.match(guide, /one Forum post becomes one Task/u);
  assert.match(guide, /Replies in that post continue the\s+same Task/u);
  assert.match(guide, /A new post starts a clean Task context/u);
  assert.match(guide, /Admin Web → Tasks → New task/u);
  assert.match(guide, /Main database remains the\s+source of truth/u);
  assert.match(guide, /private-network Artifact exposure with authentication/u);
  assert.match(guide, /release-metadata\.json/u);
  assert.match(guide, /supportStatus/u);
  assert.match(guide, /Release candidate or promoted supported release/u);
  assert.match(guide, /verified Configuration Chat path/u);
  assert.match(guide, /before the first deterministic `init`/u);
  assert.match(guide, /cannot add or replace a Discord binding/u);
  assert.match(guide, /Internal\s+previews remain foreground-only/u);
  assertAppearsBefore(guide, "### Make the Configuration Agent ready", "## 3. Claim owner access");
  assert.match(guide, /CODEX_HOME/u);
  assert.match(guide, /CLAUDE_CONFIG_DIR/u);
  assert.match(guide, /codex login/u);
  assert.match(guide, /claude auth login/u);
  assert.match(guide, /configurationAgent\.status` is `ready`/u);
  assert.match(guide, /current internal preview does not expose/u);
  assert.match(guide, /does not prove a pinned executable identity/u);
  assert.match(
    guide,
    /release candidate must expose a packaged provider login and probe\s+boundary/u,
  );
  assertAppearsBefore(
    guide,
    "## 3. Claim owner access",
    "From the authenticated owner session, read `GET /api/v1/runtime/features`",
  );
  assert.doesNotMatch(guide, /stop before owner claim/u);
  assert.match(guide, /If you did not select Discord, skip this section/u);
  assert.doesNotMatch(guide, /README\.md#build-an-internal-preview/u);

  const initializationDecision = guide.slice(
    guide.indexOf("Before invoking the launcher for the first time"),
    guide.indexOf("The Agent will inspect the host"),
  );
  assert.match(initializationDecision, /If you selected Discord/u);
  assert.match(initializationDecision, /If you declined Discord/u);
  assert.match(initializationDecision, /explicitly\s+Discord-disabled/u);
  assert.doesNotMatch(initializationDecision, /For an internal preview, the Agent must/u);

  const adminChecklist = guide.slice(
    guide.indexOf("Work through these items with the Configuration Agent"),
    guide.indexOf("The initial Main provider login already happened"),
  );
  assert.match(adminChecklist, /when Discord was selected/u);
  assert.match(adminChecklist, /When Discord was declined/u);
  assert.match(adminChecklist, /confirm\s+that it remains disabled/u);

  assert.match(initSkill, /Before the first deterministic `init`/u);
  assert.match(initSkill, /release-metadata\.json/u);
  assert.match(initSkill, /supportStatus/u);
  assert.match(initSkill, /When the owner selected Discord for an internal preview/u);
  assert.match(initSkill, /CONFIG_EXISTS/u);
  assert.match(initSkill, /When the owner selected Discord for release-candidate bytes/u);
  assert.match(initSkill, /verified Configuration Chat → Discord path/u);
  assertAppearsBefore(
    initSkill,
    "### Bootstrap the Main Configuration Agent",
    "Initialize Main and start the separate loopback-only claim listener",
  );
  assert.match(initSkill, /CODEX_HOME/u);
  assert.match(initSkill, /CLAUDE_CONFIG_DIR/u);
  assert.match(initSkill, /codex login/u);
  assert.match(initSkill, /claude auth login/u);
  assert.match(initSkill, /current internal preview does not expose/u);
  assert.match(initSkill, /does not prove a pinned executable identity/u);
  assert.match(initSkill, /candidate lacks a packaged provider login and probe\s+boundary/u);
  assert.doesNotMatch(initSkill, /provider's pinned executable/u);
  assert.match(initSkill, /When the owner selected Discord/u);
  assert.match(initSkill, /When the owner declined Discord/u);

  const skillMainDecision = initSkill.slice(
    initSkill.indexOf("Before the first deterministic `init`"),
    initSkill.indexOf("### Bootstrap the Main Configuration Agent"),
  );
  assert.match(skillMainDecision, /When the owner selected Discord for an internal preview/u);
  assert.match(skillMainDecision, /When the owner selected Discord for release-candidate bytes/u);
  assert.match(skillMainDecision, /When the owner declined Discord/u);
  assert.match(skillMainDecision, /initialize Main without a\s+Discord binding/u);
  assertAppearsBefore(
    initSkill,
    "Have the owner create the passphrase",
    "From the authenticated owner session, read `GET /api/v1/runtime/features`",
  );
  assert.doesNotMatch(initSkill, /stop before owner claim/u);

  assert.match(supportMatrix, /\| Codex App Server and CLI \| 0\.145\.0 \|/u);
  assert.match(
    supportMatrix,
    /\| Claude Agent SDK and authentication CLI \| SDK 0\.3\.205; Claude Code 2\.1\.205 \|/u,
  );
  assert.match(supportMatrix, /Provider command identity release blocker/u);
  assert.match(supportMatrix, /persists only the provider selection/u);
});

test("every localized README exposes the same launcher-free Quick Start", async () => {
  const locales = [
    {
      filename: "README.ko.md",
      heading: "## 빠른 시작",
      nextHeading: "## OpenDelegate를 만드는 이유",
      firstInitPattern: /최초 Main 초기화\s+전에/u,
      adminTaskPattern: /Admin\s+Web\s*→\s*Tasks\s*→\s*새 작업/u,
    },
    {
      filename: "README.ja.md",
      heading: "## クイックスタート",
      nextHeading: "## OpenDelegate が必要な理由",
      firstInitPattern: /最初の Main 初期化前/u,
      adminTaskPattern: /Admin\s+Web\s*→\s*Tasks\s*→\s*新しいタスク/u,
    },
    {
      filename: "README.fr.md",
      heading: "## Démarrage rapide",
      nextHeading: "## Pourquoi OpenDelegate",
      firstInitPattern: /avant la première initialisation du Main/u,
      adminTaskPattern: /Admin\s+Web\s*→\s*Tasks\s*→\s*Nouvelle\s+tâche/u,
    },
    {
      filename: "README.es.md",
      heading: "## Inicio rápido",
      nextHeading: "## Por qué OpenDelegate",
      firstInitPattern: /antes de la primera inicialización del Main/u,
      adminTaskPattern: /Admin\s+Web\s*→\s*Tasks\s*→\s*Nueva\s+tarea/u,
    },
    {
      filename: "README.zh-CN.md",
      heading: "## 快速开始",
      nextHeading: "## 为什么选择 OpenDelegate",
      firstInitPattern: /首次 Main\s+初始化之前/u,
      adminTaskPattern: /Admin\s+Web\s*→\s*Tasks\s*→\s*新建任务/u,
    },
  ];

  for (const locale of locales) {
    const content = await readRepositoryFile(locale.filename);
    assertAppearsBefore(content, locale.heading, locale.nextHeading);
    const quickStart = content.slice(
      content.indexOf(locale.heading),
      content.indexOf(locale.nextHeading),
    );

    assert.match(quickStart, /\(docs\/GETTING_STARTED\.md\)/u);
    assert.match(quickStart, /\(docs\/DISCORD_SETUP\.md\)/u);
    assert.match(quickStart, /skills\/opendelegate-init\/SKILL\.md/u);
    assert.match(quickStart, /skills\/opendelegate-join\/SKILL\.md/u);
    assert.match(quickStart, /Discord Forum/u);
    assert.match(quickStart, /Task/u);
    assert.match(quickStart, locale.firstInitPattern);
    assert.match(quickStart, locale.adminTaskPattern);
    assert.doesNotMatch(quickStart, /pnpm (?:install|check|build)/u);
    assert.equal(content.includes(".\\opendelegate.cmd init --open"), false);
    assert.equal(content.includes("./opendelegate init --open"), false);
  }
});

test("Discord setup documents the complete least-privilege Forum journey", async () => {
  const guide = await readRepositoryFile("docs/DISCORD_SETUP.md");
  const journey = [
    "### 1. Create the Discord App and bot",
    "### 2. Prepare the Community server and Forum",
    "### 3. Configure intents and permissions",
    "### 4. Collect the non-secret IDs",
    "### 5. Create the OpenDelegate binding",
    "### 6. Provision the bot token",
    "### 7. Verify the first Task",
  ];
  for (let index = 1; index < journey.length; index += 1) {
    assertAppearsBefore(guide, journey[index - 1], journey[index]);
  }
  assertAppearsBefore(
    guide,
    "## Release-candidate and promoted-release path",
    "## Internal-preview manual path",
  );
  assertAppearsBefore(
    guide,
    "## Internal-preview manual path",
    "### 1. Create the Discord App and bot",
  );
  assert.match(guide, /release-metadata\.json/u);
  assert.match(guide, /verified Configuration Chat/u);
  assert.match(guide, /Do not apply the internal-preview manual workaround/u);
  assert.match(guide, /Discord is optional/u);
  assert.match(guide, /Admin Web → Tasks → New task/u);
  assert.match(guide, /rules below apply only after the owner selects Discord/u);

  for (const intent of ["GUILDS", "GUILD_MESSAGES", "MESSAGE_CONTENT"]) {
    assert.match(guide, new RegExp(`\\b${intent}\\b`, "u"));
  }
  assert.match(guide, /GUILD_MEMBERS.*not required/u);

  for (const permission of [
    "VIEW_CHANNEL",
    "READ_MESSAGE_HISTORY",
    "SEND_MESSAGES",
    "SEND_MESSAGES_IN_THREADS",
    "ATTACH_FILES",
    "MANAGE_THREADS",
  ]) {
    assert.match(guide, new RegExp(`\\b${permission}\\b`, "u"));
  }

  for (const workflowTag of ["intake", "running", "waiting", "review", "done", "failed"]) {
    assert.match(guide, new RegExp(`"${workflowTag}"`, "u"));
  }

  for (const identifier of ["applicationId", "botUserId", "guildId", "channelId", "ownerUserIds"]) {
    assert.match(guide, new RegExp(`"${identifier}"`, "u"));
  }

  assert.match(guide, /"botTokenAlias"/u);
  assert.match(guide, /--discord-token-stdin/u);
  assert.match(guide, /\.\\opendelegate\.cmd init --discord-config/u);
  assert.match(guide, /\.\/opendelegate init --discord-config/u);
  assert.match(guide, /provision the PostgreSQL URI first/iu);
  assert.match(guide, /same complete non-secret `init` options/u);
  assert.match(guide, /new Forum post/u);
  assert.match(guide, /reply in the same post/u);
  assert.doesNotMatch(guide, /"botToken"\s*:/u);
});
