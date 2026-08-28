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

test("README leads with one simple Agent-first setup and keeps the detailed journey", async () => {
  const [readme, guide, initSkill, supportMatrix, heroImage] = await Promise.all([
    readRepositoryFile("README.md"),
    readRepositoryFile("docs/GETTING_STARTED.md"),
    readRepositoryFile(".agents/skills/opendelegate-init/SKILL.md"),
    readRepositoryFile("docs/release/SUPPORT_MATRIX.md"),
    stat(new URL("../../docs/design/opendelegate-orchestration-hero.png", import.meta.url)),
  ]);

  const recommendedHeading = "## Recommended installation: ask your Agent";
  const detailedHeading = "## Detailed setup";
  const readmeLead = readme.slice(0, readme.indexOf(recommendedHeading));
  assert.match(
    readmeLead,
    /Tell OpenDelegate the outcome you want in Discord[\s\S]*decides where and how to run it/u,
  );
  assert.match(readmeLead, /> \[!TIP\]\r?\n> \*\*Start here:/u);
  assert.equal(heroImage.isFile(), true);
  assert.match(readmeLead, /docs\/design\/opendelegate-orchestration-hero\.png/u);
  assertAppearsBefore(readme, "opendelegate-orchestration-hero.png", "**Start here:**");
  assert.match(readmeLead, /\[Complete setup guide\]\(docs\/GETTING_STARTED\.md\)/u);
  assert.match(readmeLead, /\[Hermes setup Agent guide\]\(docs\/HERMES_SETUP_AGENT\.md\)/u);
  assert.match(readmeLead, /\[Discord Forum setup\]\(docs\/DISCORD_SETUP\.md\)/u);
  assert.equal(readmeLead.includes(`(#${githubHeadingAnchor(recommendedHeading)})`), true);
  assertAppearsBefore(readme, "**Start here:**", recommendedHeading);
  assertAppearsBefore(readme, recommendedHeading, detailedHeading);
  assertAppearsBefore(readme, detailedHeading, "## Why OpenDelegate");
  assert.equal(
    readme.slice(0, readme.indexOf(recommendedHeading)).split(/\r?\n/u).length <= 18,
    true,
    "The hero and recommended installation must be visible within the first 18 README lines",
  );
  const setupJourney = readme.slice(
    readme.indexOf(recommendedHeading),
    readme.indexOf("## Why OpenDelegate"),
  );
  assert.match(setupJourney, /> \[!WARNING\]\r?\n>/u);
  assertAppearsBefore(setupJourney, "This is the shortest and recommended path", "> [!WARNING]");
  assertAppearsBefore(setupJourney, "> [!WARNING]", "OpenDelegate is installed with an Agent");
  assert.equal(readme.includes("## Current source state"), true);
  assert.equal(setupJourney.includes(`(#${githubHeadingAnchor("## Current source state")})`), true);
  assert.match(setupJourney, /\[complete setup guide\]\(docs\/GETTING_STARTED\.md\)/u);
  assert.match(setupJourney, /docs\/HERMES_SETUP_AGENT\.md/u);
  assert.match(setupJourney, /\(docs\/DISCORD_SETUP\.md\)/u);
  assert.match(setupJourney, /skills\/opendelegate-init\/SKILL\.md/u);
  assert.match(setupJourney, /skills\/opendelegate-join\/SKILL\.md/u);
  assert.match(setupJourney, /Give this repository URL to Codex, Claude, or Hermes/u);
  const ownerPrompt = setupJourney.match(/> Set up OpenDelegate[\s\S]*?> finish there\./u)?.[0];
  assert.notEqual(
    ownerPrompt,
    undefined,
    "Recommended installation must include one copyable prompt",
  );
  assert.doesNotMatch(ownerPrompt, /AGENTS\.md|SKILL\.md/u);
  assert.match(ownerPrompt, /repository's own Main installation instructions/u);
  assert.match(ownerPrompt, /Never ask me to paste credentials,\s*> tokens, or other secrets/u);
  assert.doesNotMatch(ownerPrompt, /when you need a choice or credential/u);
  assert.match(setupJourney, /docs\/design\/admin-configuration-chat-implemented\.png/u);
  assert.match(setupJourney, /SQLite is already the zero-configuration local default/u);
  assert.match(setupJourney, /Provider credentials and Discord tokens never belong in chat/u);
  assertAppearsBefore(setupJourney, "Configuration Chat", detailedHeading);
  assert.match(setupJourney, /SHA256SUMS/u);
  assert.match(setupJourney, /Admin Web/u);
  assert.match(setupJourney, /Discord Forum post/u);
  assert.match(setupJourney, /Tasks → New task/u);
  assert.match(setupJourney, /Task/u);
  assert.match(setupJourney, /Discord is optional during first initialization/u);
  assertAppearsBefore(
    setupJourney,
    ".agents/skills/opendelegate-join/SKILL.md",
    "Discord Forum post",
  );
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
  assert.match(guide, /authenticated\s+Configuration Chat path/u);
  assert.match(guide, /Discord is optional during deterministic `init`/u);
  assert.match(guide, /add, replace,\s+extend, or disable the live binding/u);
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
  assert.match(guide, /If you do not want Discord, skip this section/u);
  assert.doesNotMatch(guide, /README\.md#build-an-internal-preview/u);

  const initializationDecision = guide.slice(
    guide.indexOf("Before invoking the launcher for the first time"),
    guide.indexOf("The Agent will inspect the host"),
  );
  assert.match(initializationDecision, /configure\s+Discord now/u);
  assert.match(initializationDecision, /defer it until after owner claim/u);
  assert.match(initializationDecision, /Discord-disabled/u);
  assert.doesNotMatch(initializationDecision, /For an internal preview, the Agent must/u);

  const adminChecklist = guide.slice(
    guide.indexOf("Work through these items with the Configuration Agent"),
    guide.indexOf("The initial Main provider login already happened"),
  );
  assert.match(adminChecklist, /inspect the current `discord\.binding`/u);
  assert.match(adminChecklist, /do not\s+upload the token again or submit a no-op proposal/u);
  assert.match(adminChecklist, /deferred, new, or changed Discord setup/u);
  assert.match(adminChecklist, /secure credential\s+panel/u);
  assert.match(adminChecklist, /confirm that the binding remains disabled/u);

  assert.match(initSkill, /Before the first deterministic `init`/u);
  assert.match(initSkill, /release-metadata\.json/u);
  assert.match(initSkill, /supportStatus/u);
  assert.match(initSkill, /When the owner selected Discord for an internal preview/u);
  assert.match(initSkill, /When the owner selected Discord for release-candidate bytes/u);
  assert.match(initSkill, /verified Configuration Chat Discord path/u);
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

  assert.match(supportMatrix, /\| Codex App Server and CLI \| 0\.146\.0 \|/u);
  assert.match(
    supportMatrix,
    /\| Claude Agent SDK and authentication CLI \| SDK 0\.3\.220; Claude Code 2\.1\.220 \|/u,
  );
  assert.match(supportMatrix, /Provider command identity release blocker/u);
  assert.match(supportMatrix, /persists only the provider selection/u);
});

test("every localized README exposes the same simple Agent-first installation", async () => {
  const locales = [
    {
      filename: "README.ko.md",
      heading: "## 권장 설치: Agent에게 맡기세요",
      detailedHeading: "## 상세 설정",
      nextHeading: "## OpenDelegate를 만드는 이유",
      startHere: "**여기서 시작하세요:**",
      ownerIntroduction: "OpenDelegate는 Agent와 함께 설치합니다.",
      statusHeading: "## 현재 소스 상태",
      deferredDiscordPattern: /추가·교체·확장·비활성화/u,
      adminTaskPattern: /Admin\s+Web\s*→\s*Tasks\s*→\s*새 작업/u,
      promisePattern: /Discord에서 원하는 결과만 말하세요.*실행 위치와 방법은 OpenDelegate가 결정/u,
      securePromptPattern: /비밀값을 채팅에 붙여 넣으라고 하지\s*> 말고/u,
      unsafePromptPattern: /인증 정보를 제공해야 할 때만 질문/u,
    },
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
      content.slice(0, content.indexOf(locale.heading)).split(/\r?\n/u).length <= 18,
      true,
      `${locale.filename} hero and recommended installation must be visible within the first 18 lines`,
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
