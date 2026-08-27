import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
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

function githubHeadingAnchor(heading) {
  return heading
    .replace(/^##\s+/u, "")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{Letter}\p{Mark}\p{Number}\s-]/gu, "")
    .replace(/\s+/gu, "-");
}

test("README leads with the current multi-Device setup journey", async () => {
  const [readme, korean, guide, initSkill, joinSkill, heroImage] = await Promise.all([
    readRepositoryFile("README.md"),
    readRepositoryFile("README.ko.md"),
    readRepositoryFile("docs/GETTING_STARTED.md"),
    readRepositoryFile(".agents/skills/opendelegate-init/SKILL.md"),
    readRepositoryFile(".agents/skills/opendelegate-join/SKILL.md"),
    stat(new URL("../../docs/design/opendelegate-orchestration-hero.png", import.meta.url)),
  ]);

  const journey = [
    "## What OpenDelegate does",
    "## 5-minute setup (recommended)",
    "## Add every Device",
    "## Use OpenDelegate",
    "## How responsibilities are split",
    "## Architecture",
    "## Current source state",
  ];
  for (let index = 1; index < journey.length; index += 1) {
    assertAppearsBefore(readme, journey[index - 1], journey[index]);
  }

  const readmeLead = readme.slice(0, readme.indexOf(journey[0]));
  assert.match(readmeLead, /Set up one personal control plane for the AI Agents/u);
  assert.match(readmeLead, /public source pre-alpha/u);
  assert.match(readmeLead, /docs\/design\/opendelegate-orchestration-hero\.png/u);
  assert.equal(heroImage.isFile(), true);
  assert.match(readmeLead, /docs\/GETTING_STARTED\.md/u);
  assert.match(readmeLead, /docs\/HERMES_SETUP_AGENT\.md/u);

  const onboarding = readme.slice(readme.indexOf(journey[0]), readme.indexOf(journey[6]));
  assert.match(onboarding, /Hermes, Codex, or Claude/u);
  assert.match(onboarding, /git clone https:\/\/github\.com\/jugol\/OpenDelegate\.git/u);
  assert.match(onboarding, /git pull --ff-only/u);
  assert.match(onboarding, /hermes skills trust/u);
  assert.match(onboarding, /\.agents\/skills/u);
  assert.match(onboarding, /Add Device/u);
  assert.match(onboarding, /single-use enrollment grant/u);
  assert.match(onboarding, /Join this computer to my fixed OpenDelegate Main/u);
  assert.match(onboarding, /Admin Web/u);
  assert.match(onboarding, /Discord Forum \(optional during setup\)/u);
  assert.match(onboarding, /not as a first-class runtime/u);
  assert.match(onboarding, /credentials[\s\S]*outside the checkout or bundle/u);
  assert.doesNotMatch(onboarding, /npm run start/u);

  assert.match(korean, /여러 컴퓨터의 AI Agent를 하나의 개인 Control Plane/u);
  assert.match(korean, /## 5분 설정\(권장\)/u);
  assert.match(korean, /## 모든 Device 추가/u);
  assert.match(korean, /hermes skills trust/u);
  assert.match(korean, /Discord Forum\(최초 설정 시 선택\)/u);

  assert.match(guide, /\.agents\/skills\/opendelegate-init\/SKILL\.md/u);
  assert.match(guide, /skills\/opendelegate-init\/SKILL\.md/u);
  assert.match(initSkill, /supportStatus/u);
  assert.match(initSkill, /Before the first deterministic `init`/u);
  assert.match(joinSkill, /single-use grant/u);
  assert.match(joinSkill, /outbound-only/u);
});

test("every localized README exposes the same simple Agent-first installation", async () => {
  const locales = [
    {
      filename: "README.ja.md",
      heading: "## 推奨インストール：Agent に任せる",
      detailedHeading: "## 詳細セットアップ",
      nextHeading: "## OpenDelegate が必要な理由",
      startHere: "**ここから始めてください:**",
      ownerIntroduction: "OpenDelegate は Agent とともにインストールします。",
      statusHeading: "## 現在のソースの状態",
      deferredDiscordPattern: /追加、置換、拡張、無効化/u,
      adminTaskPattern: /Admin\s+Web\s*→\s*Tasks\s*→\s*新しいタスク/u,
      promisePattern:
        /Discord で望む成果を伝えてください.*実行場所と方法は OpenDelegate が決めます/u,
      securePromptPattern: /チャットに貼り付けるよう求めず/u,
      unsafePromptPattern: /私の判断や認証情報が必要なときだけ質問/u,
    },
    {
      filename: "README.fr.md",
      heading: "## Installation recommandée : confiez-la à votre Agent",
      detailedHeading: "## Configuration détaillée",
      nextHeading: "## Pourquoi OpenDelegate",
      startHere: "**Commencez ici :**",
      ownerIntroduction: "OpenDelegate s’installe avec un Agent",
      statusHeading: "## État actuel du code source",
      deferredDiscordPattern: /ajouter,\s+remplacer, étendre ou désactiver/u,
      adminTaskPattern: /Admin\s+Web\s*→\s*Tasks\s*→\s*Nouvelle\s+tâche/u,
      promisePattern:
        /Décrivez le résultat voulu dans Discord.*OpenDelegate décide où et comment l’exécuter/u,
      securePromptPattern: /secrets dans le chat/u,
      unsafePromptPattern: /un choix ou un identifiant est nécessaire/u,
    },
    {
      filename: "README.es.md",
      heading: "## Instalación recomendada: pídeselo a tu Agent",
      detailedHeading: "## Configuración detallada",
      nextHeading: "## Por qué OpenDelegate",
      startHere: "**Empieza aquí:**",
      ownerIntroduction: "OpenDelegate se instala con un Agent",
      statusHeading: "## Estado actual del código fuente",
      deferredDiscordPattern: /añadir,\s+sustituir, ampliar o desactivar/u,
      adminTaskPattern: /Admin\s+Web\s*→\s*Tasks\s*→\s*Nueva\s+tarea/u,
      promisePattern:
        /Dile a OpenDelegate qué resultado quieres en Discord.*decide dónde y cómo ejecutarlo/u,
      securePromptPattern: /secretos en el\s*> chat/u,
      unsafePromptPattern: /decisión o credencial/u,
    },
    {
      filename: "README.zh-CN.md",
      heading: "## 推荐安装：交给你的 Agent",
      detailedHeading: "## 详细设置",
      nextHeading: "## 为什么选择 OpenDelegate",
      startHere: "**从这里开始：**",
      ownerIntroduction: "OpenDelegate 由 Agent 协助安装",
      statusHeading: "## 当前源代码状态",
      deferredDiscordPattern: /添加、替换、扩展或禁用/u,
      adminTaskPattern: /Admin\s+Web\s*→\s*Tasks\s*→\s*新建任务/u,
      promisePattern: /只需在 Discord 中告诉 OpenDelegate 你想要的结果.*执行位置和方式由它决定/u,
      securePromptPattern: /秘密粘贴到聊天中/u,
      unsafePromptPattern: /做决定或提供凭据时才提问/u,
    },
  ];

  for (const locale of locales) {
    const content = await readRepositoryFile(locale.filename);
    const readmeLead = content.slice(0, content.indexOf(locale.heading));
    assert.match(readmeLead, locale.promisePattern);
    assert.match(readmeLead, /docs\/design\/opendelegate-orchestration-hero\.png/u);
    assertAppearsBefore(content, "opendelegate-orchestration-hero.png", locale.startHere);
    assert.match(readmeLead, /> \[!TIP\]\r?\n>/u);
    assert.match(readmeLead, /\(docs\/GETTING_STARTED\.md\)/u);
    assert.match(readmeLead, /\(docs\/DISCORD_SETUP\.md\)/u);
    assert.equal(
      readmeLead.includes(`(#${githubHeadingAnchor(locale.heading)})`),
      true,
      `${locale.filename} start panel must link to its recommended installation heading`,
    );
    assertAppearsBefore(content, locale.startHere, locale.heading);
    assertAppearsBefore(content, locale.heading, locale.detailedHeading);
    assertAppearsBefore(content, locale.detailedHeading, locale.nextHeading);
    assertAppearsBefore(content, locale.heading, locale.nextHeading);
    assert.equal(
      content.slice(0, content.indexOf(locale.heading)).split(/\r?\n/u).length <= 17,
      true,
      `${locale.filename} hero and recommended installation must be visible within the first 17 lines`,
    );
    const quickStart = content.slice(
      content.indexOf(locale.heading),
      content.indexOf(locale.nextHeading),
    );
    const copyablePrompt = quickStart.match(/3\.[\s\S]*?\r?\n\r?\n4\./u)?.[0];
    assert.notEqual(copyablePrompt, undefined, `${locale.filename} must include a copyable prompt`);
    assert.match(copyablePrompt, locale.securePromptPattern);
    assert.doesNotMatch(copyablePrompt, locale.unsafePromptPattern);

    assert.match(quickStart, /> \[!WARNING\]\r?\n>/u);
    assertAppearsBefore(quickStart, "> [!WARNING]", locale.ownerIntroduction);
    assert.equal(content.includes(locale.statusHeading), true);
    assert.equal(
      quickStart.includes(`(#${githubHeadingAnchor(locale.statusHeading)})`),
      true,
      `${locale.filename} release warning must link to its source-status heading`,
    );
    assert.match(quickStart, /\(docs\/GETTING_STARTED\.md\)/u);
    assert.match(quickStart, /\(docs\/DISCORD_SETUP\.md\)/u);
    assert.match(quickStart, /skills\/opendelegate-init\/SKILL\.md/u);
    assert.match(quickStart, /skills\/opendelegate-join\/SKILL\.md/u);
    assert.match(quickStart, /docs\/design\/admin-configuration-chat-implemented\.png/u);
    assert.match(quickStart, /Configuration Chat/u);
    assert.match(quickStart, /Discord Forum/u);
    assert.match(quickStart, /Task/u);
    assert.match(quickStart, locale.deferredDiscordPattern);
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
    "### 6. Provision or verify the bot token",
    "### 7. Verify the first Task",
  ];
  for (let index = 1; index < journey.length; index += 1) {
    assertAppearsBefore(guide, journey[index - 1], journey[index]);
  }
  assertAppearsBefore(guide, "## Supported binding lifecycle", "## Discord-side preparation");
  assertAppearsBefore(
    guide,
    "## Discord-side preparation",
    "### 1. Create the Discord App and bot",
  );
  assert.match(guide, /release-metadata\.json/u);
  assert.match(guide, /verified Configuration Chat/u);
  assert.match(guide, /serializes the one Gateway\s+transition/u);
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
