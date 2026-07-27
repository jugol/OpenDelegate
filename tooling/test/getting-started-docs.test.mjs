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
  const [readme, guide, initSkill] = await Promise.all([
    readRepositoryFile("README.md"),
    readRepositoryFile("docs/GETTING_STARTED.md"),
    readRepositoryFile("skills/opendelegate-init/SKILL.md"),
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
  assert.match(quickStart, /SHA256SUMS/u);
  assert.match(quickStart, /Admin Web/u);
  assert.match(quickStart, /Discord Forum post/u);
  assert.match(quickStart, /Task/u);
  assert.match(quickStart, /before the\s+first Main initialization/u);

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
  assert.match(guide, /Never open, paste, or send the grant/u);
  assert.match(guide, /one Forum post becomes one Task/u);
  assert.match(guide, /Replies in that post continue the\s+same Task/u);
  assert.match(guide, /A new post starts a clean Task context/u);
  assert.match(guide, /before the first deterministic `init`/u);
  assert.match(guide, /cannot add or replace a Discord binding/u);
  assert.match(initSkill, /Before the first deterministic `init`/u);
  assert.match(initSkill, /CONFIG_EXISTS/u);
});

test("every localized README exposes the same launcher-free Quick Start", async () => {
  const locales = [
    {
      filename: "README.ko.md",
      heading: "## 빠른 시작",
      nextHeading: "## OpenDelegate를 만드는 이유",
      firstInitPattern: /최초 Main 초기화\s+전에/u,
    },
    {
      filename: "README.ja.md",
      heading: "## クイックスタート",
      nextHeading: "## OpenDelegate が必要な理由",
      firstInitPattern: /最初の Main 初期化前/u,
    },
    {
      filename: "README.fr.md",
      heading: "## Démarrage rapide",
      nextHeading: "## Pourquoi OpenDelegate",
      firstInitPattern: /avant la première initialisation du Main/u,
    },
    {
      filename: "README.es.md",
      heading: "## Inicio rápido",
      nextHeading: "## Por qué OpenDelegate",
      firstInitPattern: /antes de la primera inicialización del Main/u,
    },
    {
      filename: "README.zh-CN.md",
      heading: "## 快速开始",
      nextHeading: "## 为什么选择 OpenDelegate",
      firstInitPattern: /首次 Main\s+初始化之前/u,
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
    assert.doesNotMatch(quickStart, /pnpm (?:install|check|build)/u);
  }
});

test("Discord setup documents the complete least-privilege Forum journey", async () => {
  const guide = await readRepositoryFile("docs/DISCORD_SETUP.md");
  const journey = [
    "## 1. Create the Discord App and bot",
    "## 2. Prepare the Community server and Forum",
    "## 3. Configure intents and permissions",
    "## 4. Collect the non-secret IDs",
    "## 5. Create the OpenDelegate binding",
    "## 6. Provision the bot token",
    "## 7. Verify the first Task",
  ];
  for (let index = 1; index < journey.length; index += 1) {
    assertAppearsBefore(guide, journey[index - 1], journey[index]);
  }

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
  assert.match(guide, /new Forum post/u);
  assert.match(guide, /reply in the same post/u);
  assert.doesNotMatch(guide, /"botToken"\s*:/u);
});
