import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { auditReleaseEvidence, summarizeReleaseEvidence } from "./check-release-evidence.mjs";
import { stageNativeReleaseAssets } from "./native-release-assets.mjs";
import {
  finalizePlatformNativeAuthenticity,
  readPlatformAuthenticityPolicy,
  verifyFinalPlatformNativeAuthenticity,
} from "./platform-native-authenticity.mjs";
import { captureFrozenPayload, verifyFrozenPayload } from "./release-smoke-payload-seal.mjs";
import { withLinuxReleaseSmokeSecretFixture } from "./release-smoke-secret.mjs";
import {
  assertPinnedReleaseGitFilesMatchCommit,
  pinReleaseGitProvenance,
  readPinnedReleaseSourceIdentity,
  revalidatePinnedReleaseGitProvenance,
  runPinnedReleaseGit,
} from "./release-git-provenance.mjs";

const currentFile = fileURLToPath(import.meta.url);
const releaseToolRoot = resolve(dirname(currentFile), "..");
const releaseRunnerSourceEnvironment = "OPENDELEGATE_INTERNAL_RELEASE_SOURCE";
const releaseRunnerCommitEnvironment = "OPENDELEGATE_INTERNAL_RELEASE_COMMIT";
const configuredReleaseSource = process.env[releaseRunnerSourceEnvironment];
const expectedReleaseCommit = process.env[releaseRunnerCommitEnvironment];
const repositoryRoot =
  configuredReleaseSource === undefined ? releaseToolRoot : resolve(configuredReleaseSource);
export const REQUIRED_RELEASE_NODE_VERSION = "24.18.0";
export const PINNED_PNPM_VERSION = "11.15.1";
export const PINNED_PNPM_ARCHIVE_INTEGRITY =
  "sha512-gTULB+U8lTigLx8jA7QpD6LXvgTlbiqXDEzEtBfcdh3hlu2r1J1Vx9yVgNuBAHxEFD5OPX5GKzAA0jwlUSLQZQ==";
const pinnedPnpmArchiveUrl = `https://registry.npmjs.org/pnpm/-/pnpm-${PINNED_PNPM_VERSION}.tgz`;
const maximumPnpmArchiveBytes = 25 * 1024 * 1024;
const maximumNodeArchiveBytes = 128 * 1024 * 1024;
const runningReleaseToolPaths = [
  "tooling/build-release.mjs",
  "tooling/check-release-evidence.mjs",
  "tooling/native-release-assets.mjs",
  "tooling/native-payload-inventory.mjs",
  "tooling/platform-native-authenticity.mjs",
  "tooling/release-credential-authorization.mjs",
  "tooling/release-git-provenance.mjs",
  "tooling/release-smoke-payload-seal.mjs",
  "tooling/release-smoke-secret.mjs",
  "tooling/release-tooling-io.mjs",
];
const nodeDistributionRoot = `https://nodejs.org/dist/v${REQUIRED_RELEASE_NODE_VERSION}`;
const nodeShasumsUrl = `${nodeDistributionRoot}/SHASUMS256.txt`;
const officialRuntimeArchives = new Map([
  [
    "darwin-arm64",
    {
      filename: `node-v${REQUIRED_RELEASE_NODE_VERSION}-darwin-arm64.tar.gz`,
      sha256: "e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1",
    },
  ],
  [
    "darwin-x64",
    {
      filename: `node-v${REQUIRED_RELEASE_NODE_VERSION}-darwin-x64.tar.gz`,
      sha256: "dfd0dbd3e721503434df7b7205e719f61b3a3a31b2bcf9729b8b91fea240f080",
    },
  ],
  [
    "linux-arm64",
    {
      filename: `node-v${REQUIRED_RELEASE_NODE_VERSION}-linux-arm64.tar.gz`,
      sha256: "6b4484c2190274175df9aa8f28e2d758a819cb1c1fe6ab481e2f95b463ab8508",
    },
  ],
  [
    "linux-x64",
    {
      filename: `node-v${REQUIRED_RELEASE_NODE_VERSION}-linux-x64.tar.gz`,
      sha256: "783130984963db7ba9cbd01089eaf2c2efb055c7c1693c943174b967b3050cb8",
    },
  ],
  [
    "win32-arm64",
    {
      filename: `node-v${REQUIRED_RELEASE_NODE_VERSION}-win-arm64.zip`,
      sha256: "f274669adb93b1fd0fbf8f21fd078609e9dcc84333d4f2718d2dde3f9a161a01",
    },
  ],
  [
    "win32-x64",
    {
      filename: `node-v${REQUIRED_RELEASE_NODE_VERSION}-win-x64.zip`,
      sha256: "0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821",
    },
  ],
]);
const supportedPlatforms = new Set(["darwin", "linux", "win32"]);
const supportedArchitectures = new Set(["arm64", "x64"]);
const releaseCandidateTargets = new Set(["darwin-arm64", "linux-x64", "win32-x64"]);
const curatedRuntimeLicenseFiles = new Map([
  [
    "abstract-logging@2.0.1",
    {
      path: "docs/legal/runtime-license-overrides/abstract-logging-2.0.1-LICENSE.txt",
      source: "https://raw.githubusercontent.com/jsumners/abstract-logging/v2.0.1/Readme.md",
    },
  ],
  [
    "standardwebhooks@1.0.0",
    {
      path: "docs/legal/runtime-license-overrides/standardwebhooks-1.0.0-LICENSE.txt",
      source:
        "https://raw.githubusercontent.com/standard-webhooks/standard-webhooks/c7cd8a9eadf9879d6dca345e168dc8d15d19e487/libraries/LICENSE",
    },
  ],
]);
const acceptanceLedgerPath = "docs/release/acceptance-evidence.json";
const attestationEvidencePrefix = "docs/release/evidence/";
const fullGitCommitPattern = /^[0-9a-f]{40}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const regularFileMode = "100644";
export const RELEASE_SKILL_DIRECTORIES = Object.freeze(["opendelegate-init", "opendelegate-join"]);

export async function isDirectReleaseInvocation(invokedPath, modulePath = currentFile) {
  if (invokedPath === undefined) {
    return false;
  }
  try {
    const [canonicalInvokedPath, canonicalModulePath] = await Promise.all([
      realpath(invokedPath),
      realpath(modulePath),
    ]);
    return canonicalInvokedPath === canonicalModulePath;
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function officialRuntimeArchiveFor(platform, architecture) {
  const input = officialRuntimeArchives.get(`${platform}-${architecture}`);
  if (input === undefined) {
    throw new Error(`No audited Node.js runtime input exists for ${platform}-${architecture}.`);
  }
  return Object.freeze({
    ...input,
    shasumsUrl: nodeShasumsUrl,
    url: `${nodeDistributionRoot}/${input.filename}`,
  });
}

export function parseReleaseArguments(values) {
  let destination;
  let gitExecutable;
  let gitExecutableSha256;
  let internalPreview = false;
  let platformSigningPolicy;
  let platformSigningPolicySha256;

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--internal-preview") {
      internalPreview = true;
      continue;
    }
    if (value === "--git-executable") {
      const candidate = values[index + 1];
      if (candidate === undefined || candidate.startsWith("--") || !isAbsolute(candidate)) {
        throw new Error("--git-executable requires an explicit absolute path.");
      }
      if (gitExecutable !== undefined) {
        throw new Error("--git-executable may be specified only once.");
      }
      gitExecutable = resolve(candidate);
      index += 1;
      continue;
    }
    if (value === "--git-executable-sha256") {
      const candidate = values[index + 1];
      if (candidate === undefined || !sha256Pattern.test(candidate)) {
        throw new Error("--git-executable-sha256 requires a lowercase SHA-256.");
      }
      if (gitExecutableSha256 !== undefined) {
        throw new Error("--git-executable-sha256 may be specified only once.");
      }
      gitExecutableSha256 = candidate;
      index += 1;
      continue;
    }
    if (value === "--platform-signing-policy") {
      const candidate = values[index + 1];
      if (candidate === undefined || candidate.startsWith("--")) {
        throw new Error("--platform-signing-policy requires an absolute path.");
      }
      if (!isAbsolute(candidate)) {
        throw new Error("--platform-signing-policy must be an absolute path.");
      }
      if (platformSigningPolicy !== undefined) {
        throw new Error("--platform-signing-policy may be specified only once.");
      }
      platformSigningPolicy = resolve(candidate);
      index += 1;
      continue;
    }
    if (value === "--platform-signing-policy-sha256") {
      const candidate = values[index + 1];
      if (candidate === undefined || candidate.startsWith("--")) {
        throw new Error("--platform-signing-policy-sha256 requires a lowercase SHA-256.");
      }
      if (!/^[0-9a-f]{64}$/u.test(candidate)) {
        throw new Error("--platform-signing-policy-sha256 must be a lowercase SHA-256.");
      }
      if (platformSigningPolicySha256 !== undefined) {
        throw new Error("--platform-signing-policy-sha256 may be specified only once.");
      }
      platformSigningPolicySha256 = candidate;
      index += 1;
      continue;
    }
    if (value === "--destination") {
      const candidate = values[index + 1];
      if (candidate === undefined || candidate.startsWith("--")) {
        throw new Error("--destination requires an absolute path.");
      }
      destination = candidate;
      index += 1;
      continue;
    }
    if (value === "--help" || value === "-h") {
      return { help: true, internalPreview: false };
    }
    throw new Error(`Unknown release-build option: ${String(value)}.`);
  }

  if (destination === undefined) {
    throw new Error("--destination is required.");
  }
  if ((platformSigningPolicy === undefined) !== (platformSigningPolicySha256 === undefined)) {
    throw new Error(
      "The platform-signing policy path and lowercase SHA-256 must be provided together.",
    );
  }
  if ((gitExecutable === undefined) !== (gitExecutableSha256 === undefined)) {
    throw new Error("The Git executable path and lowercase SHA-256 must be provided together.");
  }
  if ((!internalPreview || platformSigningPolicy !== undefined) && gitExecutable === undefined) {
    throw new Error(
      "Supported or credential-bearing release builds require --git-executable and --git-executable-sha256.",
    );
  }
  return {
    destination,
    help: false,
    internalPreview,
    ...(gitExecutable === undefined ? {} : { gitExecutable }),
    ...(gitExecutableSha256 === undefined ? {} : { gitExecutableSha256 }),
    ...(platformSigningPolicy === undefined ? {} : { platformSigningPolicy }),
    ...(platformSigningPolicySha256 === undefined ? {} : { platformSigningPolicySha256 }),
  };
}

const bundleReadmeLanguages = Object.freeze([
  Object.freeze({ filename: "README.md", label: "English", locale: "en" }),
  Object.freeze({ filename: "README.ko.md", label: "한국어", locale: "ko" }),
  Object.freeze({ filename: "README.ja.md", label: "日本語", locale: "ja" }),
  Object.freeze({ filename: "README.fr.md", label: "Français", locale: "fr" }),
  Object.freeze({ filename: "README.es.md", label: "Español", locale: "es" }),
  Object.freeze({ filename: "README.zh-CN.md", label: "简体中文", locale: "zh-CN" }),
]);

const bundleReadmeCopy = Object.freeze({
  en: Object.freeze({
    agentStep:
      "Ask Codex, Claude, or another capable local agent to follow\n   `skills/opendelegate-init/SKILL.md`.",
    candidateWarning:
      "This candidate is not a supported release until it is promoted through the documented release channel.",
    cliIntroduction: "For deterministic CLI inspection:",
    documentation:
      "See `docs/release/README.md` for release semantics, `SECURITY.md` for private\nvulnerability reporting, and `THIRD_PARTY_NOTICES.json` for the complete bundled\ndependency legal inventory.",
    integrity:
      "Verify `SHA256SUMS` against a digest obtained through a trusted publication channel\nbefore relying on the payload. The enclosed manifest proves only internal\nconsistency, not publisher identity.",
    languageLabel: "Languages",
    ledgerIntroduction: "The acceptance ledger state recorded during assembly was:",
    packageDescription: (target) =>
      `This directory is a self-contained, platform-specific OpenDelegate bundle for\n${target}. It includes its audited Node.js runtime; do not install pnpm or run\nsource-checkout commands here.`,
    previewTitle: "unsupported internal preview",
    previewWarning:
      "Read `INTERNAL_PREVIEW.md`. This bundle is unsupported and must not be published under a release tag.",
    candidateTitle: "unpublished release candidate",
    startHeading: "Start with an agent",
    stateStep:
      "Keep runtime state, databases, credentials, logs, and generated Artifacts outside\n   this bundle.",
  }),
  ko: Object.freeze({
    agentStep:
      "Codex, Claude 또는 기능을 갖춘 다른 로컬 Agent에게\n   `skills/opendelegate-init/SKILL.md`를 따르도록 요청하세요.",
    candidateWarning:
      "이 후보는 문서화된 릴리스 채널을 통해 승격되기 전까지 지원 릴리스가 아닙니다.",
    cliIntroduction: "결정적인 CLI 인터페이스를 확인하려면 다음을 사용하세요.",
    documentation:
      "릴리스 의미는 `docs/release/README.md`, 비공개 취약점 신고 방법은 `SECURITY.md`,\n번들된 의존성의 전체 법적 목록은 `THIRD_PARTY_NOTICES.json`을 확인하세요.",
    integrity:
      "이 payload를 신뢰하기 전에 신뢰할 수 있는 배포 채널에서 얻은 digest와\n`SHA256SUMS`를 대조하세요. 포함된 manifest는 내부 일관성만 증명하며 게시자 신원은\n증명하지 않습니다.",
    languageLabel: "언어",
    ledgerIntroduction: "조립 시 기록된 acceptance ledger 상태는 다음과 같습니다.",
    packageDescription: (target) =>
      `이 디렉터리는 ${target}용 자체 완결형 플랫폼별 OpenDelegate 번들입니다.\n감사된 Node.js runtime이 포함되어 있으므로 여기에서 pnpm을 설치하거나 source checkout\n명령을 실행하지 마세요.`,
    previewTitle: "지원되지 않는 내부 프리뷰",
    previewWarning:
      "`INTERNAL_PREVIEW.md`를 먼저 읽으세요. 이 번들은 지원되지 않으며 릴리스 태그로 게시해서는 안 됩니다.",
    candidateTitle: "게시되지 않은 릴리스 후보",
    startHeading: "Agent로 시작하기",
    stateStep:
      "runtime 상태, 데이터베이스, 자격 증명, 로그 및 생성된 Artifact는 이 번들 밖에\n   보관하세요.",
  }),
  ja: Object.freeze({
    agentStep:
      "Codex、Claude、または対応可能な別のローカル Agent に\n   `skills/opendelegate-init/SKILL.md` の手順を実行するよう依頼してください。",
    candidateWarning:
      "この候補は、文書化されたリリースチャネルを通じて昇格されるまで、サポート対象のリリースではありません。",
    cliIntroduction: "決定的な CLI インターフェースを確認するには、次を実行します。",
    documentation:
      "リリースの意味は `docs/release/README.md`、非公開の脆弱性報告は `SECURITY.md`、\nバンドルされた依存関係の完全な法的一覧は `THIRD_PARTY_NOTICES.json` を確認してください。",
    integrity:
      "この payload を信頼する前に、信頼できる公開チャネルから取得した digest と\n`SHA256SUMS` を照合してください。同梱の manifest が証明するのは内部整合性のみで、\n公開者の身元ではありません。",
    languageLabel: "言語",
    ledgerIntroduction: "アセンブリ時に記録された acceptance ledger の状態は次のとおりです。",
    packageDescription: (target) =>
      `このディレクトリは ${target} 向けの自己完結型プラットフォーム別 OpenDelegate\nバンドルです。監査済みの Node.js runtime が含まれているため、ここで pnpm をインストールしたり\nsource checkout 用のコマンドを実行したりしないでください。`,
    previewTitle: "サポート対象外の内部プレビュー",
    previewWarning:
      "`INTERNAL_PREVIEW.md` を先に読んでください。このバンドルはサポート対象外であり、リリースタグで公開してはいけません。",
    candidateTitle: "未公開のリリース候補",
    startHeading: "Agent から始める",
    stateStep:
      "runtime 状態、データベース、認証情報、ログ、生成された Artifact はこのバンドルの\n   外に保存してください。",
  }),
  fr: Object.freeze({
    agentStep:
      "Demandez à Codex, Claude ou à un autre Agent local compatible de suivre\n   `skills/opendelegate-init/SKILL.md`.",
    candidateWarning:
      "Ce candidat n’est pas une version prise en charge tant qu’il n’a pas été promu par le canal de publication documenté.",
    cliIntroduction: "Pour inspecter l’interface CLI déterministe :",
    documentation:
      "Consultez `docs/release/README.md` pour la sémantique des releases, `SECURITY.md`\npour signaler une vulnérabilité en privé et `THIRD_PARTY_NOTICES.json` pour\nl’inventaire juridique complet des dépendances incluses.",
    integrity:
      "Avant d’utiliser ce payload, comparez `SHA256SUMS` à un digest obtenu par un canal\nde publication fiable. Le manifest inclus prouve uniquement la cohérence interne,\npas l’identité de l’éditeur.",
    languageLabel: "Langues",
    ledgerIntroduction: "L’état de l’acceptance ledger enregistré pendant l’assemblage était :",
    packageDescription: (target) =>
      `Ce répertoire contient un bundle OpenDelegate autonome et propre à la plateforme\n${target}. Il inclut son runtime Node.js audité ; n’installez pas pnpm et n’exécutez\npas ici de commandes destinées au source checkout.`,
    previewTitle: "aperçu interne non pris en charge",
    previewWarning:
      "Lisez d’abord `INTERNAL_PREVIEW.md`. Ce bundle n’est pas pris en charge et ne doit pas être publié sous un tag de release.",
    candidateTitle: "candidat de version non publié",
    startHeading: "Démarrer avec un Agent",
    stateStep:
      "Conservez l’état du runtime, les bases de données, les identifiants, les logs et les\n   Artifacts générés en dehors de ce bundle.",
  }),
  es: Object.freeze({
    agentStep:
      "Pide a Codex, Claude u otro Agent local compatible que siga\n   `skills/opendelegate-init/SKILL.md`.",
    candidateWarning:
      "Este candidato no es una versión con soporte hasta que se promocione mediante el canal de publicación documentado.",
    cliIntroduction: "Para inspeccionar la interfaz CLI determinista:",
    documentation:
      "Consulta `docs/release/README.md` para conocer la semántica de las releases,\n`SECURITY.md` para informar de vulnerabilidades en privado y\n`THIRD_PARTY_NOTICES.json` para ver el inventario legal completo de las dependencias incluidas.",
    integrity:
      "Antes de confiar en este payload, compara `SHA256SUMS` con un digest obtenido por\nun canal de publicación fiable. El manifest incluido solo demuestra la coherencia\ninterna, no la identidad de quien lo publica.",
    languageLabel: "Idiomas",
    ledgerIntroduction: "El estado del acceptance ledger registrado durante el ensamblado fue:",
    packageDescription: (target) =>
      `Este directorio contiene un bundle OpenDelegate autónomo y específico para\n${target}. Incluye su runtime Node.js auditado; no instales pnpm ni ejecutes aquí\ncomandos propios del source checkout.`,
    previewTitle: "vista previa interna sin soporte",
    previewWarning:
      "Lee primero `INTERNAL_PREVIEW.md`. Este bundle no tiene soporte y no debe publicarse bajo una etiqueta de release.",
    candidateTitle: "candidato de versión no publicado",
    startHeading: "Empezar con un Agent",
    stateStep:
      "Mantén el estado del runtime, las bases de datos, las credenciales, los logs y los\n   Artifacts generados fuera de este bundle.",
  }),
  "zh-CN": Object.freeze({
    agentStep:
      "请让 Codex、Claude 或其他具备相应能力的本地 Agent 按照\n   `skills/opendelegate-init/SKILL.md` 操作。",
    candidateWarning: "在通过文档所述的发布渠道完成提升之前，此候选版本不属于受支持的 Release。",
    cliIntroduction: "如需检查确定性的 CLI 界面，请运行：",
    documentation:
      "Release 语义请参阅 `docs/release/README.md`，私下报告安全漏洞请参阅\n`SECURITY.md`，随附依赖项的完整法律清单请参阅 `THIRD_PARTY_NOTICES.json`。",
    integrity:
      "在信任此 payload 之前，请使用从可信发布渠道获得的 digest 校验 `SHA256SUMS`。\n随附的 manifest 只能证明内部一致性，不能证明发布者身份。",
    languageLabel: "语言",
    ledgerIntroduction: "组装时记录的 acceptance ledger 状态如下：",
    packageDescription: (target) =>
      `此目录是面向 ${target} 的自包含 OpenDelegate 平台捆绑包，其中包含经过审计的\nNode.js runtime；请勿在此安装 pnpm，也不要运行面向 source checkout 的命令。`,
    previewTitle: "不受支持的内部预览版",
    previewWarning:
      "请先阅读 `INTERNAL_PREVIEW.md`。此捆绑包不受支持，且不得在 Release tag 下发布。",
    candidateTitle: "未发布的候选版本",
    startHeading: "从 Agent 开始",
    stateStep: "请将 runtime 状态、数据库、凭据、日志和生成的 Artifact 保存在此捆绑包之外。",
  }),
});

function renderBundleReadmeLanguageNavigation(locale) {
  const copy = bundleReadmeCopy[locale];
  return `${copy.languageLabel}: ${bundleReadmeLanguages
    .map((language) => {
      const link = `[${language.label}](${language.filename})`;
      return language.locale === locale ? `**${link}**` : link;
    })
    .join(" · ")}`;
}

export function renderBundleReadme(
  supportStatus,
  summary,
  platform = process.platform,
  architecture = process.arch,
  productVersion,
  locale = "en",
) {
  assertProductVersion(productVersion);
  const copy = bundleReadmeCopy[locale];
  if (copy === undefined) {
    throw new Error(`Unsupported bundle README locale: ${String(locale)}.`);
  }
  const preview = supportStatus.startsWith("internal-preview");
  const launcher = platform === "win32" ? "opendelegate.cmd" : "./opendelegate";
  const statusLabel = preview ? copy.previewTitle : copy.candidateTitle;
  const firstStep = preview ? copy.previewWarning : copy.candidateWarning;

  return `# OpenDelegate ${productVersion} ${statusLabel}

${renderBundleReadmeLanguageNavigation(locale)}

${copy.packageDescription(`${platform}/${architecture}`)}

Support status: \`${supportStatus}\`.

## ${copy.startHeading}

1. ${firstStep}
2. ${copy.agentStep}
3. ${copy.stateStep}

${copy.cliIntroduction}

\`\`\`text
${launcher} help
${launcher} init
${launcher} status
\`\`\`

${copy.ledgerIntroduction}

- Implementation: ${formatCounts(summary.implementation)}
- Live proof: ${formatCounts(summary.liveProof)}

${copy.integrity}

${copy.documentation}
`;
}

export async function writeBundleReadmes(
  staging,
  supportStatus,
  summary,
  platform = process.platform,
  architecture = process.arch,
  productVersion,
) {
  await Promise.all(
    bundleReadmeLanguages.map((language) =>
      writeFile(
        join(staging, language.filename),
        renderBundleReadme(
          supportStatus,
          summary,
          platform,
          architecture,
          productVersion,
          language.locale,
        ),
        "utf8",
      ),
    ),
  );
}

export function validateReleaseDestination(sourceRoot, destination) {
  if (!isAbsolute(destination)) {
    throw new Error("The release destination must be an absolute path.");
  }
  const normalizedSource = resolve(sourceRoot);
  const normalizedDestination = resolve(destination);
  const pathFromSource = relative(normalizedSource, normalizedDestination);
  if (
    pathFromSource === "" ||
    (!isAbsolute(pathFromSource) &&
      pathFromSource !== ".." &&
      !pathFromSource.startsWith(`..${sep}`))
  ) {
    throw new Error("Release artifacts must be written outside the source checkout.");
  }
  return normalizedDestination;
}

async function validateExternalReleaseInput(sourceRoot, input, label) {
  if (!isAbsolute(input)) {
    throw new Error(`The ${label} must use an absolute path.`);
  }
  const [normalizedSource, normalizedInput] = await Promise.all([
    realpath(sourceRoot),
    realpath(input),
  ]);
  const relationship = relative(normalizedSource, normalizedInput);
  if (
    relationship === "" ||
    (!isAbsolute(relationship) && relationship !== ".." && !relationship.startsWith(`..${sep}`))
  ) {
    throw new Error(`The ${label} must remain outside the source checkout.`);
  }
  return normalizedInput;
}

export function validateReleaseDestinationName(destination, internalPreview) {
  if (internalPreview && !basename(destination).toLowerCase().includes("internal-preview")) {
    throw new Error("An internal-preview destination name must contain 'internal-preview'.");
  }
}

export function determineSupportStatus(summary, internalPreview) {
  if (summary.releaseStatus === "released") {
    throw new Error(
      "A released ledger requires a separately designed and verified promotion attestation.",
    );
  }
  if (
    (summary.complete && summary.releaseStatus !== "candidate") ||
    (!summary.complete && summary.releaseStatus !== "blocked")
  ) {
    throw new Error("Release evidence completeness and releaseStatus are inconsistent.");
  }
  if (summary.complete) {
    return internalPreview ? "internal-preview-complete" : "release-candidate";
  }
  if (!internalPreview) {
    throw new Error(
      "The first-milestone release gate is blocked. Use --internal-preview only for a clearly marked, unsupported validation bundle.",
    );
  }
  return "internal-preview-blocked";
}

export function assertSupportMatrixTarget(platform, architecture, supportStatus) {
  if (
    supportStatus === "release-candidate" &&
    !releaseCandidateTargets.has(`${platform}-${architecture}`)
  ) {
    throw new Error(
      `Release candidates are limited to the declared support-matrix targets; ${platform}-${architecture} may create an internal preview only.`,
    );
  }
}

export function collectShaBoundAttestationPaths(ledger) {
  const paths = new Set();
  const addProof = (proof) => {
    if (
      proof === null ||
      typeof proof !== "object" ||
      Array.isArray(proof) ||
      proof.sourceCommit !== ledger.sourceCommit ||
      !Array.isArray(proof.evidence)
    ) {
      return;
    }
    for (const reference of proof.evidence) {
      if (
        reference !== null &&
        typeof reference === "object" &&
        !Array.isArray(reference) &&
        typeof reference.path === "string" &&
        typeof reference.sha256 === "string" &&
        sha256Pattern.test(reference.sha256)
      ) {
        paths.add(reference.path);
      }
    }
  };

  for (const criterion of Array.isArray(ledger.criteria) ? ledger.criteria : []) {
    if (criterion === null || typeof criterion !== "object" || Array.isArray(criterion)) {
      continue;
    }
    const verification =
      criterion.verification !== null &&
      typeof criterion.verification === "object" &&
      !Array.isArray(criterion.verification)
        ? criterion.verification
        : undefined;
    if (criterion.implementationStatus === "verified") {
      addProof(verification?.implementation);
    }
    if (criterion.liveProofStatus === "verified") {
      addProof(verification?.liveProof);
    }
  }
  if (ledger.releaseStatus === "candidate" || ledger.releaseStatus === "released") {
    addProof(ledger.candidateAttestation);
  }
  return [...paths].sort(compareCodeUnits);
}

export function parseRawGitDiff(rawDiff) {
  if (rawDiff === "") {
    return [];
  }
  const fields = rawDiff.split("\0");
  if (fields.at(-1) === "") {
    fields.pop();
  }
  const entries = [];
  for (let index = 0; index < fields.length;) {
    const header = fields[index];
    index += 1;
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z])(\d{0,3})$/.exec(
      header ?? "",
    );
    if (match === null) {
      throw new Error("Git returned an invalid raw attestation diff.");
    }
    const status = match[5];
    const firstPath = fields[index];
    index += 1;
    if (firstPath === undefined || firstPath === "") {
      throw new Error("Git returned an attestation diff entry without a path.");
    }
    if (status === "R" || status === "C") {
      const secondPath = fields[index];
      index += 1;
      if (secondPath === undefined || secondPath === "") {
        throw new Error("Git returned a rename or copy without a destination path.");
      }
      entries.push({
        oldMode: match[1],
        newMode: match[2],
        oldObject: match[3],
        newObject: match[4],
        status,
        score: match[6],
        oldPath: firstPath,
        path: secondPath,
      });
      continue;
    }
    entries.push({
      oldMode: match[1],
      newMode: match[2],
      oldObject: match[3],
      newObject: match[4],
      status,
      score: match[6],
      path: firstPath,
    });
  }
  return entries;
}

export function validateReleaseAttestationDiff(ledger, entries) {
  const shaBoundPaths = new Set(collectShaBoundAttestationPaths(ledger));
  const changedPaths = new Set();
  let ledgerChanged = false;

  for (const entry of entries) {
    const status = entry.status;
    const path = entry.path;
    if (status === "R" || status === "C") {
      throw new Error(
        `Release attestation commits may not contain Git renames or copies: ${String(entry.oldPath)} -> ${String(path)}.`,
      );
    }
    if (status === "D") {
      throw new Error(`Release attestation commits may not delete files: ${String(path)}.`);
    }
    if (status === "T") {
      throw new Error(`Release attestation commits may not change file types: ${String(path)}.`);
    }
    if (status !== "A" && status !== "M") {
      throw new Error(
        `Release attestation commits may not contain Git status ${String(status)}: ${String(path)}.`,
      );
    }
    if (typeof path !== "string" || path === "" || path.includes("\\")) {
      throw new Error("Release attestation commits contain an invalid repository path.");
    }
    if (changedPaths.has(path)) {
      throw new Error(`Release attestation commits contain duplicate diff entries for ${path}.`);
    }
    changedPaths.add(path);

    if (path === acceptanceLedgerPath) {
      if (
        status !== "M" ||
        entry.oldMode !== regularFileMode ||
        entry.newMode !== regularFileMode
      ) {
        throw new Error(
          `${acceptanceLedgerPath} must remain a modified regular mode-${regularFileMode} file.`,
        );
      }
      ledgerChanged = true;
      continue;
    }

    if (!path.startsWith(attestationEvidencePrefix) || path === attestationEvidencePrefix) {
      throw new Error(
        `Release attestation commits may change only ${acceptanceLedgerPath} and SHA-bound files under ${attestationEvidencePrefix}: ${path}.`,
      );
    }
    if (!shaBoundPaths.has(path)) {
      throw new Error(
        `Release attestation file is not SHA-bound by criterion verification or candidateAttestation: ${path}.`,
      );
    }
    const validModes =
      entry.newMode === regularFileMode &&
      ((status === "A" && entry.oldMode === "000000") ||
        (status === "M" && entry.oldMode === regularFileMode));
    if (!validModes) {
      throw new Error(
        `Release attestation evidence must remain a regular mode-${regularFileMode} file: ${path}.`,
      );
    }
  }

  if (!ledgerChanged) {
    throw new Error(
      `The attestation commit must modify ${acceptanceLedgerPath} while preserving audited source commit A.`,
    );
  }
  return [...changedPaths].sort(compareCodeUnits);
}

export async function createChecksumManifest(root, excluded = new Set(["SHA256SUMS"])) {
  const entries = await createFileEntries(root, excluded);
  return `${entries.map((entry) => `${entry.sha256}  ${entry.path}`).join("\n")}\n`;
}

export async function createPayloadManifest(
  root,
  excluded = new Set(["SHA256SUMS", "payload-manifest.json"]),
) {
  const files = await createFileEntries(root, excluded);
  return {
    schemaVersion: 1,
    excludedSelfReferences: [...excluded].sort(compareCodeUnits),
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    files,
  };
}

export async function writeIntegrityManifests(root) {
  await writeFile(
    join(root, "payload-manifest.json"),
    `${JSON.stringify(await createPayloadManifest(root), null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(root, "SHA256SUMS"), await createChecksumManifest(root), "utf8");
}

export async function inspectReleaseCandidateProvenance(
  sourceRoot,
  ledger,
  source,
  gitProvenance = null,
) {
  if (typeof ledger.sourceCommit !== "string" || !fullGitCommitPattern.test(ledger.sourceCommit)) {
    throw new Error("The audited source commit must be an exact 40-character lowercase Git SHA.");
  }
  if (typeof source.commit !== "string" || !fullGitCommitPattern.test(source.commit)) {
    throw new Error("The build commit must be an exact 40-character lowercase Git SHA.");
  }
  if (source.dirty) {
    throw new Error("A supported release candidate must be built from a clean Git checkout.");
  }
  if (ledger.sourceCommit === source.commit) {
    throw new Error(
      "A release candidate must be built from a distinct attestation commit B after audited source commit A.",
    );
  }

  await assertGitCommitExists(
    sourceRoot,
    ledger.sourceCommit,
    "audited source commit A",
    gitProvenance,
  );
  await assertGitCommitExists(sourceRoot, source.commit, "build commit B", gitProvenance);
  try {
    await runBoundProvenanceGit(
      gitProvenance,
      ["merge-base", "--is-ancestor", ledger.sourceCommit, source.commit],
      sourceRoot,
      { capture: true },
    );
  } catch (error) {
    throw new Error(
      "The audited source commit A must be an ancestor of release attestation commit B.",
      { cause: error },
    );
  }

  const rawDiff = (
    await runBoundProvenanceGit(
      gitProvenance,
      [
        "diff",
        "--raw",
        "--no-abbrev",
        "--no-ext-diff",
        "--find-renames",
        "--find-copies",
        "--find-copies-harder",
        "-z",
        ledger.sourceCommit,
        source.commit,
        "--",
      ],
      sourceRoot,
      { capture: true },
    )
  ).stdout;
  return {
    auditedSourceCommit: ledger.sourceCommit,
    buildCommit: source.commit,
    changedAttestationPaths: validateReleaseAttestationDiff(ledger, parseRawGitDiff(rawDiff)),
  };
}

export async function createCommittedSourceSnapshot(
  sourceRoot,
  commit,
  parent,
  gitProvenance = null,
) {
  if (!fullGitCommitPattern.test(commit)) {
    throw new Error(
      "A committed source snapshot requires an exact 40-character lowercase Git SHA.",
    );
  }
  const snapshot = await mkdtemp(join(parent, ".od-committed-source-"));
  const archivePath = join(parent, `.od-source-${process.pid}-${randomUUID().slice(0, 8)}.tar`);
  try {
    await runBoundProvenanceGit(
      gitProvenance,
      ["archive", "--format=tar", "-o", archivePath, commit],
      sourceRoot,
      { capture: true },
    );
    await runCommand("tar", ["-xf", archivePath, "-C", snapshot], sourceRoot, {
      capture: true,
    });
    return snapshot;
  } catch (error) {
    await rm(snapshot, { force: true, recursive: true });
    throw error;
  } finally {
    await rm(archivePath, { force: true });
  }
}

export async function withCommittedSourceSnapshot(
  sourceRoot,
  commit,
  parent,
  gitProvenanceOrOperation,
  maybeOperation,
) {
  const gitProvenance =
    typeof gitProvenanceOrOperation === "function" ? null : gitProvenanceOrOperation;
  const operation =
    typeof gitProvenanceOrOperation === "function" ? gitProvenanceOrOperation : maybeOperation;
  if (typeof operation !== "function") {
    throw new Error("A committed source snapshot requires an operation callback.");
  }
  const snapshot = await createCommittedSourceSnapshot(sourceRoot, commit, parent, gitProvenance);
  try {
    return await operation(snapshot);
  } finally {
    await rm(snapshot, { force: true, recursive: true });
  }
}

export async function verifyRunningReleaseToolFiles(
  sourceRoot,
  commit,
  paths = runningReleaseToolPaths,
  runningRoot = sourceRoot,
  gitProvenance = null,
) {
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error("A running release-tool verification requires a full Git commit ID.");
  }
  for (const path of paths) {
    const segments = path.split("/");
    if (
      !/^[A-Za-z0-9._/-]+$/u.test(path) ||
      segments.some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      throw new Error("A running release-tool path is not a safe repository-relative path.");
    }
    const [runningBytes, committed] = await Promise.all([
      readFile(join(runningRoot, ...segments), "utf8"),
      runBoundProvenanceGit(gitProvenance, ["show", `${commit}:${path}`], sourceRoot, {
        capture: true,
      }),
    ]);
    if (runningBytes !== committed.stdout) {
      throw new Error(
        `The running release tool does not match captured build commit ${commit}: ${path}.`,
      );
    }
  }
}

export function verifyPinnedPnpmArchive(archive) {
  if (!(archive instanceof Uint8Array) || archive.byteLength > maximumPnpmArchiveBytes) {
    throw new Error("The pinned pnpm archive is missing or exceeds its byte limit.");
  }
  const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
  if (integrity !== PINNED_PNPM_ARCHIVE_INTEGRITY) {
    throw new Error("The pnpm archive hash did not match the audited official input.");
  }
}

export async function readBoundedResponseBody(response, maximumBytes) {
  if (
    response?.body === null ||
    response?.body === undefined ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes <= 0
  ) {
    throw new Error("The download response has no bounded readable body.");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        return Buffer.concat(chunks, length);
      }
      const chunk = Buffer.from(result.value);
      length += chunk.byteLength;
      if (length > maximumBytes) {
        await reader.cancel("OpenDelegate download archive limit exceeded.");
        throw new Error("The download archive exceeds its byte limit.");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
}

export async function withPinnedPnpm(parent, operation) {
  const directory = await mkdtemp(join(parent, ".od-pnpm-bootstrap-"));
  const archivePath = join(directory, `pnpm-${PINNED_PNPM_VERSION}.tgz`);
  try {
    const response = await fetch(pinnedPnpmArchiveUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) {
      throw new Error(`Could not retrieve the pinned pnpm archive (${response.status}).`);
    }
    const declaredLengthHeader = response.headers.get("content-length");
    if (declaredLengthHeader !== null) {
      const declaredLength = Number(declaredLengthHeader);
      if (
        !Number.isSafeInteger(declaredLength) ||
        declaredLength < 0 ||
        declaredLength > maximumPnpmArchiveBytes
      ) {
        throw new Error("The pinned pnpm archive has an invalid or excessive content length.");
      }
    }
    const archive = await readBoundedResponseBody(response, maximumPnpmArchiveBytes);
    verifyPinnedPnpmArchive(archive);
    await writeFile(archivePath, archive);
    await runCommand("tar", ["-xf", archivePath, "-C", directory], parent, { capture: true });

    const packageRoot = join(directory, "package");
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    if (manifest.name !== "pnpm" || manifest.version !== PINNED_PNPM_VERSION) {
      throw new Error("The verified pnpm archive contains unexpected package metadata.");
    }
    await assertPortableTree(packageRoot);
    const cli = join(packageRoot, "bin", "pnpm.cjs");
    const cliMetadata = await lstat(cli);
    if (!cliMetadata.isFile() || cliMetadata.isSymbolicLink()) {
      throw new Error("The verified pnpm archive has no regular CLI entrypoint.");
    }
    return await operation(cli);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function readProductManifest(sourceRoot) {
  const manifest = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
  assertProductVersion(manifest.version);
  if (
    manifest.packageManager !== `pnpm@${PINNED_PNPM_VERSION}` ||
    manifest.devDependencies?.pnpm !== PINNED_PNPM_VERSION ||
    typeof manifest.devDependencies?.esbuild !== "string"
  ) {
    throw new Error("The committed product manifest does not match the pinned release toolchain.");
  }
  return manifest;
}

function assertProductVersion(productVersion) {
  if (
    typeof productVersion !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(productVersion)
  ) {
    throw new Error("The root package has no valid semantic product version.");
  }
}

async function createFileEntries(root, excluded) {
  const files = await listFiles(root);
  const entries = [];
  for (const path of files) {
    const pathFromRoot = relative(root, path).split(sep).join("/");
    if (excluded.has(pathFromRoot)) {
      continue;
    }
    const bytes = await readFile(path);
    entries.push({
      path: pathFromRoot,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return entries;
}

export async function buildRelease(options, dependencies = {}) {
  assertReleaseHost();
  const gitProvenance = await pinBuildGitProvenance(options, dependencies);
  const source =
    gitProvenance === null
      ? await readSourceIdentity()
      : await readPinnedReleaseSourceIdentity(gitProvenance);
  assertCleanBundleSource(source);
  if (gitProvenance !== null) {
    await assertPinnedReleaseGitFilesMatchCommit(gitProvenance, runningReleaseToolPaths);
    await revalidatePinnedReleaseGitProvenance(gitProvenance);
  }
  await assertCommittedReleaseRunner(source, gitProvenance);

  const lexicalDestination = validateReleaseDestination(repositoryRoot, options.destination);
  validateReleaseDestinationName(lexicalDestination, options.internalPreview);
  const destination = await validateProspectiveDestination(repositoryRoot, lexicalDestination);
  await assertPathAbsent(destination);

  const ledgerPath = join(repositoryRoot, "docs", "release", "acceptance-evidence.json");
  const ledgerText = await readFile(ledgerPath, "utf8");
  const ledger = JSON.parse(ledgerText);
  const ledgerErrors = await auditReleaseEvidence(repositoryRoot, ledger);
  if (ledgerErrors.length > 0) {
    throw new Error(`Release evidence is invalid:\n${ledgerErrors.join("\n")}`);
  }
  const summary = summarizeReleaseEvidence(ledger);
  const supportStatus = determineSupportStatus(summary, options.internalPreview);
  assertSupportMatrixTarget(process.platform, process.arch, supportStatus);
  const platformAuthenticityPolicyInput =
    options.platformSigningPolicy === undefined
      ? undefined
      : await readPlatformAuthenticityPolicy(
          await validateExternalReleaseInput(
            repositoryRoot,
            options.platformSigningPolicy,
            "platform-signing policy",
          ),
          options.platformSigningPolicySha256,
        );
  const provenance =
    supportStatus === "release-candidate"
      ? await inspectReleaseCandidateProvenance(repositoryRoot, ledger, source, gitProvenance)
      : {
          auditedSourceCommit: ledger.sourceCommit,
          buildCommit: source.commit,
          changedAttestationPaths: null,
        };

  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  const staging = join(parent, `.od-${process.pid}-${randomUUID().slice(0, 8)}`);
  await mkdir(staging);

  try {
    await withPinnedPnpm(parent, async (bootstrapPnpmCli) => {
      await withCommittedSourceSnapshot(
        repositoryRoot,
        source.commit,
        parent,
        gitProvenance,
        async (assemblySourceRoot) => {
          const snapshotLedger = await readFile(
            join(assemblySourceRoot, "docs", "release", "acceptance-evidence.json"),
            "utf8",
          );
          const snapshotLedgerObject = JSON.parse(snapshotLedger);
          if (JSON.stringify(snapshotLedgerObject) !== JSON.stringify(ledger)) {
            throw new Error(
              "The committed build snapshot does not contain the validated release ledger.",
            );
          }
          const snapshotLedgerErrors = await auditReleaseEvidence(
            assemblySourceRoot,
            snapshotLedgerObject,
          );
          if (snapshotLedgerErrors.length > 0) {
            throw new Error(
              `Committed build snapshot evidence is invalid:\n${snapshotLedgerErrors.join("\n")}`,
            );
          }
          const productManifest = await readProductManifest(assemblySourceRoot);
          await runCommand("pnpm", ["install", "--frozen-lockfile"], assemblySourceRoot, {
            pnpmCli: bootstrapPnpmCli,
          });
          await assembleRelease({
            assemblySourceRoot,
            ledger,
            ledgerDigest: createHash("sha256").update(snapshotLedger).digest("hex"),
            productManifest,
            productVersion: productManifest.version,
            provenance,
            source,
            staging,
            summary,
            supportStatus,
            platformAuthenticityPolicyInput,
          });
        },
      );
    });

    await platformAuthenticityPolicyInput?.verifyStable();
    const finalSource =
      gitProvenance === null
        ? await readSourceIdentity()
        : await readPinnedReleaseSourceIdentity(gitProvenance);
    if (gitProvenance !== null) {
      await assertPinnedReleaseGitFilesMatchCommit(gitProvenance, runningReleaseToolPaths);
      await revalidatePinnedReleaseGitProvenance(gitProvenance);
    }
    if (finalSource.dirty || finalSource.commit !== source.commit) {
      throw new Error("The source checkout changed while the bundle was assembled.");
    }
    if (supportStatus === "release-candidate") {
      const finalProvenance = await inspectReleaseCandidateProvenance(
        repositoryRoot,
        ledger,
        finalSource,
        gitProvenance,
      );
      if (JSON.stringify(finalProvenance) !== JSON.stringify(provenance)) {
        throw new Error(
          "Release provenance changed while the supported release candidate was assembled.",
        );
      }
    }
    await rename(staging, destination);
  } catch (error) {
    await rm(staging, { force: true, recursive: true });
    throw error;
  }

  return {
    destination,
    supportStatus,
    source,
    provenance,
    summary,
  };
}

async function assertCommittedReleaseRunner(source, gitProvenance = null) {
  if (
    configuredReleaseSource === undefined ||
    !isAbsolute(configuredReleaseSource) ||
    expectedReleaseCommit === undefined ||
    !/^[0-9a-f]{40}$/u.test(expectedReleaseCommit)
  ) {
    throw new Error(
      "Release assembly must execute through the committed-source CLI runner snapshot.",
    );
  }
  if (source.commit !== expectedReleaseCommit) {
    throw new Error("The source checkout changed before the committed release runner started.");
  }
  const [canonicalSource, canonicalToolRoot] = await Promise.all([
    realpath(repositoryRoot),
    realpath(releaseToolRoot),
  ]);
  validateReleaseDestination(canonicalSource, canonicalToolRoot);
  await verifyRunningReleaseToolFiles(
    canonicalSource,
    source.commit,
    runningReleaseToolPaths,
    canonicalToolRoot,
    gitProvenance,
  );
}

export function assertCleanBundleSource(source) {
  if (source.dirty) {
    throw new Error(
      "Release bundles require a clean committed checkout so assembly can run in an isolated snapshot.",
    );
  }
}

async function validateProspectiveDestination(sourceRoot, destination) {
  const [canonicalSource, canonicalDestination] = await Promise.all([
    realpath(sourceRoot),
    canonicalizeProspectivePath(destination),
  ]);
  return validateReleaseDestination(canonicalSource, canonicalDestination);
}

async function canonicalizeProspectivePath(path) {
  const missingSegments = [];
  let cursor = path;
  for (;;) {
    try {
      const existing = await realpath(cursor);
      return resolve(existing, ...missingSegments);
    } catch (error) {
      if (error === null || typeof error !== "object" || error.code !== "ENOENT") {
        throw error;
      }
      const parent = dirname(cursor);
      if (parent === cursor) {
        throw new Error("The release destination has no resolvable parent.", {
          cause: error,
        });
      }
      missingSegments.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

async function assembleRelease({
  assemblySourceRoot,
  ledger,
  ledgerDigest,
  productManifest,
  productVersion,
  provenance,
  source,
  staging,
  summary,
  supportStatus,
  platformAuthenticityPolicyInput,
}) {
  const assemblyRequire = createRequire(join(assemblySourceRoot, "package.json"));
  const assemblyPnpmCli = join(dirname(assemblyRequire.resolve("pnpm")), "bin", "pnpm.cjs");
  const { build: bundle } = assemblyRequire("esbuild");
  await runCommand("pnpm", ["--filter", "@opendelegate/admin-web", "build"], assemblySourceRoot, {
    pnpmCli: assemblyPnpmCli,
  });

  const mainDirectory = join(staging, "apps", "main");
  await mkdir(mainDirectory, { recursive: true });
  await runCommand("pnpm", createMainDeployArguments(mainDirectory), assemblySourceRoot, {
    pnpmCli: assemblyPnpmCli,
  });
  const mainNodeModules = join(mainDirectory, "node_modules");
  await removePackageManagerBinDirectories(mainNodeModules);
  await pruneRuntimeNativePackageArtifacts(mainNodeModules);
  const workerDirectory = join(staging, "apps", "worker");
  await mkdir(workerDirectory, { recursive: true });
  await runCommand("pnpm", createWorkerDeployArguments(workerDirectory), assemblySourceRoot, {
    pnpmCli: assemblyPnpmCli,
  });
  const workerNodeModules = join(workerDirectory, "node_modules");
  await removePackageManagerBinDirectories(workerNodeModules);
  await pruneRuntimeNativePackageArtifacts(workerNodeModules);

  await bundle({
    absWorkingDir: assemblySourceRoot,
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    bundle: true,
    entryPoints: ["apps/main/src/cli.ts"],
    external: ["@node-rs/argon2", "@node-rs/argon2-*", "better-sqlite3", "pg"],
    format: "esm",
    logLevel: "info",
    outfile: join(mainDirectory, "opendelegate.mjs"),
    platform: "node",
    target: "node24.18",
  });
  await bundle({
    absWorkingDir: assemblySourceRoot,
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    bundle: true,
    entryPoints: ["apps/worker/src/cli.ts"],
    external: ["better-sqlite3"],
    format: "esm",
    logLevel: "info",
    outfile: join(workerDirectory, "opendelegate-worker.mjs"),
    platform: "node",
    target: "node24.18",
  });
  const serviceHostExternalDependencies = [
    "@node-rs/argon2",
    "@node-rs/argon2-*",
    "better-sqlite3",
    "pg",
  ];
  for (const directory of [mainDirectory, workerDirectory]) {
    await bundle({
      absWorkingDir: assemblySourceRoot,
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
      bundle: true,
      entryPoints: ["apps/service-host/src/core-entry.ts"],
      external: serviceHostExternalDependencies,
      format: "esm",
      logLevel: "info",
      outfile: join(directory, "opendelegate-service-host.mjs"),
      platform: "node",
      target: "node24.18",
    });
    await bundle({
      absWorkingDir: assemblySourceRoot,
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
      bundle: true,
      entryPoints: ["apps/service-host/src/helper-entry.ts"],
      external: serviceHostExternalDependencies,
      format: "esm",
      logLevel: "info",
      outfile: join(directory, "opendelegate-session-helper.mjs"),
      platform: "node",
      target: "node24.18",
    });
  }

  const adminTarget = join(staging, "apps", "admin-web", "dist");
  await mkdir(dirname(adminTarget), { recursive: true });
  await cp(join(assemblySourceRoot, "apps", "admin-web", "dist"), adminTarget, {
    recursive: true,
  });

  const stagedNativeComponents = await stageNativeReleaseAssets({
    platform: process.platform,
    architecture: process.arch,
    sourceRoot: assemblySourceRoot,
    stagingRoot: staging,
  });
  await copyReleaseMaterials(staging, assemblySourceRoot);
  const runtimeProvenance = await copyRuntime(staging, assemblySourceRoot);
  await writeThirdPartyNotices(staging, mainDirectory, assemblySourceRoot, workerDirectory);
  await writeBundleReadmes(
    staging,
    supportStatus,
    summary,
    process.platform,
    process.arch,
    productVersion,
  );

  const buildId = createBuildId(source, supportStatus);
  await writeLaunchers(staging);
  const finalizedNativeAuthenticity = await finalizePlatformNativeAuthenticity({
    platform: process.platform,
    architecture: process.arch,
    nativeComponents: stagedNativeComponents,
    policyInput: platformAuthenticityPolicyInput,
    stagingRoot: staging,
    supportStatus,
  });
  const { nativeComponents } = finalizedNativeAuthenticity;
  await assertPortableTree(staging);

  const metadata = {
    schemaVersion: 2,
    product: "OpenDelegate",
    productVersion,
    protocolVersion: "v1",
    buildId,
    createdAt: buildTimestamp(source, supportStatus),
    timestampPolicy:
      process.env["SOURCE_DATE_EPOCH"] !== undefined
        ? "source-date-epoch"
        : supportStatus === "release-candidate"
          ? "source-commit"
          : "wall-clock",
    platform: process.platform,
    architecture: process.arch,
    bundledNodeVersion: process.versions.node,
    bundledRuntime: runtimeProvenance,
    toolchain: {
      packageManager: productManifest.packageManager,
      bundler: `esbuild@${String(productManifest.devDependencies?.esbuild)}`,
    },
    dependencyLockSha256: await sha256File(join(assemblySourceRoot, "pnpm-lock.yaml")),
    sourcePackageManifestSha256: await sha256File(join(assemblySourceRoot, "package.json")),
    runtimeExternals: await readRuntimeExternalVersions(assemblySourceRoot),
    nativeComponents,
    buildCommit: provenance.buildCommit,
    auditedSourceCommit: provenance.auditedSourceCommit,
    changedAttestationPaths: provenance.changedAttestationPaths,
    buildSourceDirty: source.dirty,
    supportStatus,
    buildMode: supportStatus.startsWith("internal-preview")
      ? "internal-preview"
      : "release-candidate",
    releaseEvidence: {
      auditedAt: ledger.auditedAt,
      releaseStatus: ledger.releaseStatus,
      sha256: ledgerDigest,
      implementation: summary.implementation,
      liveProof: summary.liveProof,
      complete: summary.complete,
    },
    entrypoints:
      process.platform === "win32"
        ? ["opendelegate.cmd", "opendelegate-worker.cmd"]
        : ["opendelegate", "opendelegate-worker", "opendelegate.cmd", "opendelegate-worker.cmd"],
    fileManifest: "payload-manifest.json",
    checksumManifest: "SHA256SUMS",
  };
  await writeFile(
    join(staging, "release-metadata.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );

  if (supportStatus.startsWith("internal-preview")) {
    await writeFile(
      join(staging, "INTERNAL_PREVIEW.md"),
      `# Unsupported OpenDelegate internal preview

This bundle is for installation and integration testing only. It is **not** a
supported OpenDelegate release and must not be published under a release tag.

The canonical acceptance ledger state when this bundle was built was:

- Implementation: ${formatCounts(summary.implementation)}
- Live proof: ${formatCounts(summary.liveProof)}

Run \`opendelegate help\` for the deterministic CLI surface. Review
\`docs/release/README.md\` and \`docs/release/PLATFORM_LAB.md\` before testing.
`,
      "utf8",
    );
  }

  await writeIntegrityManifests(staging);
  const frozenPayload = await captureFrozenPayload(staging);
  const smokeEvidence = await smokeBundle(staging, buildId, productVersion);
  await verifyFrozenPayload(staging, frozenPayload);
  await writeFile(
    join(staging, "smoke-evidence.json"),
    `${JSON.stringify(smokeEvidence, null, 2)}\n`,
    "utf8",
  );
  await verifyFinalPlatformNativeAuthenticity({
    ...finalizedNativeAuthenticity,
    policyInput: platformAuthenticityPolicyInput,
    stagingRoot: staging,
  });
  await assertPortableTree(staging);
  await writeIntegrityManifests(staging);
}

export function createMainDeployArguments(mainDirectory) {
  return [
    "--config.node-linker=hoisted",
    "--filter",
    "@opendelegate/main",
    "deploy",
    "--legacy",
    "--prod",
    mainDirectory,
  ];
}

export function createWorkerDeployArguments(workerDirectory) {
  return [
    "--config.node-linker=hoisted",
    "--filter",
    "@opendelegate/worker",
    "deploy",
    "--legacy",
    "--prod",
    workerDirectory,
  ];
}

export async function removePackageManagerBinDirectories(root) {
  await removePackageManagerBinsFromTree(root, basename(root) === "node_modules");
}

export async function pruneRuntimeNativePackageArtifacts(
  nodeModules,
  platform = process.platform,
  architecture = process.arch,
) {
  if (!supportedPlatforms.has(platform) || !supportedArchitectures.has(architecture)) {
    throw new Error(
      `Runtime native package pruning is unsupported for ${platform}/${architecture}.`,
    );
  }
  const canonicalNodeModules = await requireSafePruneDirectory(
    nodeModules,
    undefined,
    "node_modules root",
  );
  const packageDirectory = await requireSafePruneDirectory(
    join(canonicalNodeModules, "better-sqlite3"),
    canonicalNodeModules,
    "better-sqlite3 package",
  );
  const manifestPath = await requireSafePruneFile(
    join(packageDirectory, "package.json"),
    packageDirectory,
    "better-sqlite3 manifest",
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.name !== "better-sqlite3" || manifest.version !== "13.0.1") {
    throw new Error("The deployed better-sqlite3 package identity is invalid.");
  }
  const targetPrebuild = `${platform}-${architecture}.node`;
  const prebuildsDirectory = await requireSafePruneDirectory(
    join(packageDirectory, "prebuilds"),
    packageDirectory,
    "better-sqlite3 prebuild inventory",
  );
  const buildDirectory = await requireSafePruneDirectory(
    join(packageDirectory, "build"),
    packageDirectory,
    "better-sqlite3 generated build directory",
    true,
  );
  const prebuildEntries = await readdir(prebuildsDirectory, { withFileTypes: true });
  const validatedPrebuilds = [];
  let retainedTarget = false;
  for (const entry of prebuildEntries) {
    if (!entry.isFile() || !/^[a-z0-9-]+\.node$/u.test(entry.name)) {
      throw new Error(
        `The deployed better-sqlite3 prebuild inventory contains an unsupported entry: ${entry.name}.`,
      );
    }
    const path = await requireSafePruneFile(
      join(prebuildsDirectory, entry.name),
      prebuildsDirectory,
      `better-sqlite3 prebuild ${entry.name}`,
    );
    const metadata = await lstat(path);
    validatedPrebuilds.push({ name: entry.name, path });
    if (entry.name === targetPrebuild) {
      if (metadata.size <= 0) {
        throw new Error(`The target better-sqlite3 prebuild is empty: ${targetPrebuild}.`);
      }
      retainedTarget = true;
    }
  }
  if (!retainedTarget) {
    throw new Error(`The target better-sqlite3 prebuild is unavailable: ${targetPrebuild}.`);
  }
  for (const entry of validatedPrebuilds) {
    if (entry.name !== targetPrebuild) {
      await rm(entry.path, { force: true });
    }
  }
  if (buildDirectory !== undefined) {
    await rm(buildDirectory, { force: true, recursive: true });
  }
}

async function requireSafePruneDirectory(path, parent, label, optional = false) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (optional && error !== null && typeof error === "object" && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  const canonical = await realpath(path);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (parent !== undefined && !isStrictPathDescendant(parent, canonical))
  ) {
    throw new Error(`The deployed ${label} escaped its release staging boundary.`);
  }
  return canonical;
}

async function requireSafePruneFile(path, parent, label) {
  const [metadata, canonical] = await Promise.all([lstat(path), realpath(path)]);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    !isStrictPathDescendant(parent, canonical)
  ) {
    throw new Error(`The deployed ${label} escaped its release staging boundary.`);
  }
  return canonical;
}

function isStrictPathDescendant(parent, candidate) {
  const relationship = relative(resolve(parent), resolve(candidate));
  return (
    relationship !== "" &&
    !isAbsolute(relationship) &&
    relationship !== ".." &&
    !relationship.startsWith(`..${sep}`)
  );
}

async function removePackageManagerBinsFromTree(root, rootIsNodeModules) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (rootIsNodeModules && entry.name === ".bin") {
      await rm(path, { force: true, recursive: true });
      continue;
    }
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await removePackageManagerBinsFromTree(path, entry.name === "node_modules");
    }
  }
}

async function readRuntimeExternalVersions(sourceRoot) {
  const manifest = JSON.parse(
    await readFile(join(sourceRoot, "apps", "main", "package.json"), "utf8"),
  );
  const dependencies = manifest.dependencies ?? {};
  return ["@node-rs/argon2", "better-sqlite3", "pg"].map((name) => ({
    name,
    version: String(dependencies[name]),
  }));
}

export async function assertPortableTree(root) {
  const entries = await listTreeEntries(root);
  for (const path of entries) {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new Error(
        `The release payload contains an unsupported symbolic link or junction: ${relative(root, path)}.`,
      );
    }
    if (!metadata.isDirectory() && !metadata.isFile()) {
      throw new Error(
        `The release payload contains an unsupported special file: ${relative(root, path)}.`,
      );
    }
  }
}

async function copyReleaseMaterials(staging, sourceRoot) {
  for (const file of ["AGENTS.md", "CHANGELOG.md", "CONTEXT.md", "LICENSE", "SECURITY.md"]) {
    await copyFile(join(sourceRoot, file), join(staging, file));
  }
  await cp(join(sourceRoot, "docs"), join(staging, "docs"), { recursive: true });
  for (const skill of RELEASE_SKILL_DIRECTORIES) {
    await cp(join(sourceRoot, "skills", skill), join(staging, "skills", skill), {
      recursive: true,
    });
  }
}

async function copyRuntime(staging, sourceRoot) {
  const input = officialRuntimeArchiveFor(process.platform, process.arch);
  const runtimeDirectory = join(staging, "runtime");
  await mkdir(runtimeDirectory, { recursive: true });
  const extractionRoot = await mkdtemp(join(staging, ".node-runtime-"));
  const archivePath = join(extractionRoot, input.filename);
  try {
    const response = await fetch(input.url, {
      redirect: "error",
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) {
      throw new Error(`Could not retrieve the pinned Node.js archive (${response.status}).`);
    }
    const declaredLengthHeader = response.headers.get("content-length");
    if (declaredLengthHeader !== null) {
      const declaredLength = Number(declaredLengthHeader);
      if (
        !Number.isSafeInteger(declaredLength) ||
        declaredLength < 0 ||
        declaredLength > maximumNodeArchiveBytes
      ) {
        throw new Error("The pinned Node.js archive has an invalid or excessive content length.");
      }
    }
    const archive = await readBoundedResponseBody(response, maximumNodeArchiveBytes);
    const archiveSha256 = createHash("sha256").update(archive).digest("hex");
    if (archiveSha256 !== input.sha256) {
      throw new Error("The Node.js archive hash did not match the audited official input.");
    }
    await writeFile(archivePath, archive);
    await runCommand("tar", ["-xf", archivePath, "-C", extractionRoot], sourceRoot, {
      capture: true,
    });

    const extractedRoot = join(extractionRoot, input.filename.replace(/\.(?:tar\.gz|zip)$/, ""));
    const extractedExecutable =
      process.platform === "win32"
        ? join(extractedRoot, "node.exe")
        : join(extractedRoot, "bin", "node");
    const extractedLicense = join(extractedRoot, "LICENSE");
    const executableName = process.platform === "win32" ? "node.exe" : "node";
    const destination = join(runtimeDirectory, executableName);
    const [executableSha256, actualLicenseHash] = await Promise.all([
      sha256File(extractedExecutable),
      sha256File(extractedLicense),
    ]);
    await Promise.all([
      copyFile(extractedExecutable, destination),
      copyFile(extractedLicense, join(runtimeDirectory, "LICENSE")),
    ]);
    if (process.platform !== "win32") {
      await chmod(destination, 0o755);
    }
    await writeFile(
      join(runtimeDirectory, "NOTICE.md"),
      `# Bundled runtime

This platform bundle contains Node.js ${process.versions.node}. Node.js is distributed
under its own license and includes third-party software. The complete license and
notices for this exact runtime are stored next to this file as \`LICENSE\`. The
archive was downloaded from the official Node.js distribution endpoint and verified
against an audited SHA-256 value published in:

${input.shasumsUrl}
`,
      "utf8",
    );
    return {
      source: "official-nodejs-distribution",
      archive: input.filename,
      archiveUrl: input.url,
      archiveSha256,
      shasumsUrl: input.shasumsUrl,
      executableSha256,
      licenseSha256: actualLicenseHash,
    };
  } finally {
    await rm(extractionRoot, { force: true, recursive: true });
  }
}

export async function writeThirdPartyNotices(
  staging,
  mainDirectory,
  sourceRoot = repositoryRoot,
  workerDirectory,
) {
  const packages = [];
  const runtimeDirectories = [
    mainDirectory,
    ...(workerDirectory === undefined ? [] : [workerDirectory]),
  ];
  for (const runtimeDirectory of runtimeDirectories) {
    const nodeModules = join(runtimeDirectory, "node_modules");
    for (const packageDirectory of await listRuntimePackageDirectories(nodeModules)) {
      await addPackageNotice(packages, packageDirectory, staging);
    }
  }
  const adminManifestPath = join(sourceRoot, "apps", "admin-web", "package.json");
  for (const packageDirectory of await listProductionPackageDirectories(adminManifestPath)) {
    await addPackageNotice(packages, packageDirectory, staging, {
      bundledForm: "compiled-admin-asset",
      copiedLegalFilesRoot: join(staging, "licenses", "admin-web"),
      packagePath: "apps/admin-web/dist",
    });
  }
  resolvePackageLegalFiles(packages);
  packages.sort(
    (left, right) =>
      compareCodeUnits(left.name, right.name) ||
      compareCodeUnits(left.version, right.version) ||
      compareCodeUnits(left.packagePath, right.packagePath),
  );
  await writeFile(
    join(staging, "THIRD_PARTY_NOTICES.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        bundledRuntime: {
          name: "Node.js",
          version: process.versions.node,
          licenseFile: "runtime/LICENSE",
        },
        packages,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

export async function listProductionPackageDirectories(manifestPath) {
  const packageDirectories = [];
  const visitedPackageDirectories = new Set();

  const visitManifest = async (currentManifestPath) => {
    const manifest = JSON.parse(await readFile(currentManifestPath, "utf8"));
    const requiredDependencies = readDependencyNames(
      manifest.dependencies,
      "dependencies",
      currentManifestPath,
    );
    const optionalDependencies = new Set(
      readDependencyNames(
        manifest.optionalDependencies,
        "optionalDependencies",
        currentManifestPath,
      ),
    );
    const dependencyNames = [...new Set([...requiredDependencies, ...optionalDependencies])].sort(
      compareCodeUnits,
    );

    for (const dependencyName of dependencyNames) {
      const dependencyManifestPath = await resolveDependencyManifest(
        currentManifestPath,
        dependencyName,
        optionalDependencies.has(dependencyName),
      );
      if (dependencyManifestPath === undefined) {
        continue;
      }
      const packageDirectory = await realpath(dirname(dependencyManifestPath));
      if (visitedPackageDirectories.has(packageDirectory)) {
        continue;
      }
      visitedPackageDirectories.add(packageDirectory);
      packageDirectories.push(packageDirectory);
      await visitManifest(join(packageDirectory, "package.json"));
    }
  };

  await visitManifest(resolve(manifestPath));
  return packageDirectories;
}

function readDependencyNames(value, field, manifestPath) {
  if (value === undefined) {
    return [];
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} in ${manifestPath} must be an object.`);
  }
  return Object.keys(value);
}

async function resolveDependencyManifest(importerManifestPath, dependencyName, optional) {
  assertPackageDependencyName(dependencyName, importerManifestPath);
  const packageRequire = createRequire(importerManifestPath);
  try {
    return packageRequire.resolve(`${dependencyName}/package.json`);
  } catch {
    const discoveredManifest = await findDependencyManifest(importerManifestPath, dependencyName);
    if (discoveredManifest !== undefined) {
      return discoveredManifest;
    }
    try {
      const entryPath = packageRequire.resolve(dependencyName);
      const owningManifest = await findOwningPackageManifest(entryPath, dependencyName);
      if (owningManifest !== undefined) {
        return owningManifest;
      }
    } catch {
      // The explicit optional-dependency behavior below owns missing-package handling.
    }
  }
  if (optional) {
    return undefined;
  }
  throw new Error(
    `Production dependency ${dependencyName} declared by ${importerManifestPath} is not installed.`,
  );
}

function assertPackageDependencyName(dependencyName, importerManifestPath) {
  const segments = dependencyName.split("/");
  const validShape =
    !dependencyName.includes("\\") &&
    ((segments.length === 1 && !dependencyName.startsWith("@")) ||
      (segments.length === 2 && segments[0]?.startsWith("@")));
  if (
    !validShape ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(
      `Invalid production dependency name ${dependencyName} in ${importerManifestPath}.`,
    );
  }
}

async function findDependencyManifest(importerManifestPath, dependencyName) {
  const dependencySegments = dependencyName.split("/");
  let cursor = dirname(importerManifestPath);
  while (true) {
    const candidate = join(cursor, "node_modules", ...dependencySegments, "package.json");
    if (await isRegularFile(candidate)) {
      return candidate;
    }
    const parent = dirname(cursor);
    if (parent === cursor) {
      return undefined;
    }
    cursor = parent;
  }
}

async function findOwningPackageManifest(entryPath, dependencyName) {
  let cursor = dirname(entryPath);
  while (true) {
    const candidate = join(cursor, "package.json");
    if (await isRegularFile(candidate)) {
      const manifest = JSON.parse(await readFile(candidate, "utf8"));
      if (manifest.name === dependencyName) {
        return candidate;
      }
    }
    const parent = dirname(cursor);
    if (parent === cursor) {
      return undefined;
    }
    cursor = parent;
  }
}

async function isRegularFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return false;
    }
    throw error;
  }
}

export function resolvePackageLegalFiles(packages) {
  const unresolved = [];
  for (const packageEntry of packages) {
    if (packageEntry.legalFiles.length > 0) {
      continue;
    }
    const source = packages.find(
      (candidate) =>
        candidate !== packageEntry &&
        candidate.legalFiles.length > 0 &&
        candidate.license === packageEntry.license &&
        candidate.repositoryUrl !== undefined &&
        candidate.repositoryUrl === packageEntry.repositoryUrl,
    );
    if (source === undefined) {
      unresolved.push(`${packageEntry.name}@${packageEntry.version}`);
      continue;
    }
    packageEntry.legalFiles = source.legalFiles.map((entry) => ({ ...entry }));
    packageEntry.legalFilesSource = {
      name: source.name,
      version: source.version,
      packagePath: source.packagePath,
    };
  }
  if (unresolved.length > 0) {
    throw new Error(
      `Bundled packages have no retained license or notice file and no same-project license source: ${unresolved.join(", ")}.`,
    );
  }
}

async function listRuntimePackageDirectories(nodeModules) {
  const packages = [];
  const visitNodeModules = async (directory) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error !== null && typeof error === "object" && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".bin" || entry.name === ".pnpm") {
        continue;
      }
      if (entry.name.startsWith("@")) {
        const scopeDirectory = join(directory, entry.name);
        for (const scopedEntry of await readdir(scopeDirectory, { withFileTypes: true })) {
          if (scopedEntry.isDirectory()) {
            const packageDirectory = join(scopeDirectory, scopedEntry.name);
            packages.push(packageDirectory);
            await visitNodeModules(join(packageDirectory, "node_modules"));
          }
        }
        continue;
      }
      const packageDirectory = join(directory, entry.name);
      packages.push(packageDirectory);
      await visitNodeModules(join(packageDirectory, "node_modules"));
    }
  };
  await visitNodeModules(nodeModules);
  return packages;
}

async function addPackageNotice(packages, packageDirectory, staging, options = {}) {
  const manifestPath = join(packageDirectory, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    typeof manifest.name !== "string" ||
    manifest.name.startsWith("@opendelegate/") ||
    typeof manifest.version !== "string"
  ) {
    return;
  }
  const legalFiles = [];
  for (const entry of await readdir(packageDirectory, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    const path = join(packageDirectory, entry.name);
    const isNamedLegalFile = /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/iu.test(entry.name);
    const isReadmeWithLicense =
      /^readme(?:[._-].*)?$/iu.test(entry.name) && (await containsCompleteLicenseText(path));
    if (isNamedLegalFile || isReadmeWithLicense) {
      const retainedPath =
        options.copiedLegalFilesRoot === undefined
          ? path
          : join(
              options.copiedLegalFilesRoot,
              legalDirectoryName(manifest.name, manifest.version),
              entry.name,
            );
      if (options.copiedLegalFilesRoot !== undefined) {
        await mkdir(dirname(retainedPath), { recursive: true });
        if (await isRegularFile(retainedPath)) {
          if ((await sha256File(path)) !== (await sha256File(retainedPath))) {
            throw new Error(
              `Conflicting retained legal files exist for ${manifest.name}@${manifest.version}: ${entry.name}.`,
            );
          }
        } else {
          await copyFile(path, retainedPath);
        }
      }
      legalFiles.push({
        path: relative(staging, retainedPath).split(sep).join("/"),
        sha256: await sha256File(retainedPath),
      });
    }
  }
  const curatedLicense = curatedRuntimeLicenseFiles.get(`${manifest.name}@${manifest.version}`);
  if (legalFiles.length === 0 && curatedLicense !== undefined) {
    const curatedPath = join(staging, ...curatedLicense.path.split("/"));
    legalFiles.push({
      path: curatedLicense.path,
      sha256: await sha256File(curatedPath),
    });
  }
  legalFiles.sort((left, right) => compareCodeUnits(left.path, right.path));
  const repositoryUrl = packageRepositoryUrl(manifest.repository);
  packages.push({
    name: manifest.name,
    version: manifest.version,
    packagePath: options.packagePath ?? relative(staging, packageDirectory).split(sep).join("/"),
    ...(options.bundledForm === undefined ? {} : { bundledForm: options.bundledForm }),
    license:
      typeof manifest.license === "string" && manifest.license.trim() !== ""
        ? manifest.license
        : "SEE_PACKAGE_FILES",
    ...(repositoryUrl === undefined ? {} : { repositoryUrl }),
    ...(curatedLicense === undefined
      ? {}
      : {
          legalFilesSource: {
            type: "curated-versioned-upstream-copy",
            source: curatedLicense.source,
          },
        }),
    legalFiles,
  });
}

function legalDirectoryName(name, version) {
  return `${name.replaceAll("/", "__")}@${version}`.replaceAll(/[^0-9A-Za-z@._-]/g, "_");
}

async function containsCompleteLicenseText(path) {
  const content = await readFile(path, "utf8");
  return (
    /^#{1,6}\s+licen[cs]e\s*$/imu.test(content) &&
    /permission is hereby granted/iu.test(content) &&
    /the software is provided ["“]as is["”]/iu.test(content)
  );
}

function packageRepositoryUrl(repository) {
  const value =
    typeof repository === "string"
      ? repository
      : repository !== null && typeof repository === "object" && typeof repository.url === "string"
        ? repository.url
        : undefined;
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  return value
    .trim()
    .replace(/^git\+/, "")
    .replace(/\.git$/, "");
}

async function sha256File(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

export function renderWindowsLauncher() {
  return `@echo off\r
set "OPENDELEGATE_BUILD_ID="\r
set "OPENDELEGATE_VERSION="\r
"%~dp0runtime\\node.exe" "%~dp0apps\\launcher\\opendelegate.mjs" %*\r
`;
}

export function renderUnixLauncher() {
  return `#!/bin/sh
unset OPENDELEGATE_BUILD_ID OPENDELEGATE_VERSION
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$ROOT_DIR/runtime/node" "$ROOT_DIR/apps/launcher/opendelegate.mjs" "$@"
`;
}

export function renderReleaseRouter() {
  return `import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const arguments_ = process.argv.slice(2);
const worker = arguments_[0] === "worker";
const target = worker
  ? join(root, "apps", "worker", "opendelegate-worker.mjs")
  : join(root, "apps", "main", "opendelegate.mjs");
process.argv = [process.execPath, target, ...(worker ? arguments_.slice(1) : arguments_)];
await import(pathToFileURL(target).href);
`;
}

async function writeLaunchers(staging) {
  const launcherDirectory = join(staging, "apps", "launcher");
  await mkdir(launcherDirectory, { recursive: true });
  await writeFile(join(launcherDirectory, "opendelegate.mjs"), renderReleaseRouter(), "utf8");
  await writeFile(join(staging, "opendelegate.cmd"), renderWindowsLauncher(), "utf8");
  await writeFile(
    join(staging, "opendelegate-worker.cmd"),
    renderWindowsLauncher().replace(
      '"%~dp0apps\\launcher\\opendelegate.mjs" %*',
      '"%~dp0apps\\launcher\\opendelegate.mjs" worker %*',
    ),
    "utf8",
  );

  if (process.platform !== "win32") {
    const path = join(staging, "opendelegate");
    await writeFile(path, renderUnixLauncher(), "utf8");
    await chmod(path, 0o755);
    const workerPath = join(staging, "opendelegate-worker");
    await writeFile(
      workerPath,
      renderUnixLauncher().replace(
        '"$ROOT_DIR/apps/launcher/opendelegate.mjs" "$@"',
        '"$ROOT_DIR/apps/launcher/opendelegate.mjs" worker "$@"',
      ),
      "utf8",
    );
    await chmod(workerPath, 0o755);
  }
}

export function evaluateSmokeShutdown(input) {
  const markerObserved = input.stdout.includes('"event":"main.stopped"');
  const naturalExit =
    !input.shutdownTimedOut &&
    !input.forcedTermination &&
    input.exitCode === 0 &&
    input.signalCode === null;
  return {
    accepted: markerObserved && naturalExit,
    markerObserved,
    naturalExit,
    exitCode: input.exitCode,
    signal: input.signalCode,
    shutdownTimedOut: input.shutdownTimedOut,
    forcedTermination: input.forcedTermination,
  };
}

async function smokeBundle(staging, buildId, productVersion) {
  assertProductVersion(productVersion);
  const runtime = join(staging, "runtime", process.platform === "win32" ? "node.exe" : "node");
  const entrypoint = join(staging, "apps", "launcher", "opendelegate.mjs");
  const workerEntrypoint = join(staging, "apps", "worker", "opendelegate-worker.mjs");
  const releaseEnvironment = {
    ...process.env,
    OPENDELEGATE_BUILD_ID: "caller-controlled-release-candidate",
    OPENDELEGATE_TEST_EXIT_ON_STDIN_END: "1",
    OPENDELEGATE_VERSION: "999.999.999",
  };
  const result = await runCommand(runtime, [entrypoint, "help"], staging, {
    capture: true,
    environment: releaseEnvironment,
  });
  if (!result.stdout.includes("Runtime state and credentials are never written")) {
    throw new Error("The packaged CLI help smoke test returned an unexpected result.");
  }
  const backupHelp = await runCommand(runtime, [entrypoint, "backup", "help"], staging, {
    capture: true,
    environment: releaseEnvironment,
  });
  if (
    !backupHelp.stdout.includes("Main metadata backup") ||
    !backupHelp.stdout.includes("new absent target home")
  ) {
    throw new Error("The packaged backup CLI help smoke test returned an unexpected result.");
  }
  const serviceHelp = await runCommand(runtime, [entrypoint, "service", "help"], staging, {
    capture: true,
    environment: releaseEnvironment,
  });
  if (
    !serviceHelp.stdout.includes("native service lifecycle") ||
    !serviceHelp.stdout.includes("require an approved platform-specific")
  ) {
    throw new Error("The packaged service CLI help smoke test returned an unexpected result.");
  }
  const version = await runCommand(runtime, [entrypoint, "version"], staging, {
    capture: true,
    environment: releaseEnvironment,
  });
  if (version.stdout.trim() !== `OpenDelegate ${productVersion}`) {
    throw new Error("The packaged CLI version smoke returned an unexpected result.");
  }
  const workerHelp = await runCommand(runtime, [entrypoint, "worker", "help"], staging, {
    capture: true,
    environment: releaseEnvironment,
  });
  if (
    !workerHelp.stdout.includes("opendelegate worker join --grant-file") ||
    !workerHelp.stdout.includes("never accepted in argv")
  ) {
    throw new Error("The packaged Worker CLI help smoke returned an unexpected result.");
  }
  const workerVersion = await runCommand(runtime, [workerEntrypoint, "version"], staging, {
    capture: true,
    environment: releaseEnvironment,
  });
  if (workerVersion.stdout.trim() !== `OpenDelegate Worker ${productVersion}`) {
    throw new Error("The packaged Worker CLI version smoke returned an unexpected result.");
  }
  const workerSmokeHome = await mkdtemp(join(dirname(staging), ".od-worker-home-"));
  try {
    const workerStatus = await runCommand(
      runtime,
      [entrypoint, "worker", "status", "--home", workerSmokeHome],
      staging,
      {
        capture: true,
        environment: releaseEnvironment,
      },
    );
    const workerStatusBody = JSON.parse(workerStatus.stdout);
    if (workerStatusBody?.enrolled !== false || workerStatusBody?.home !== workerSmokeHome) {
      throw new Error("The packaged Worker unenrolled status smoke was invalid.");
    }
  } finally {
    await rm(workerSmokeHome, { force: true, recursive: true });
  }

  const runMainSmoke = (fixture) =>
    runPackagedMainSmoke({
      buildId,
      entrypoint,
      fixture,
      productVersion,
      releaseEnvironment,
      runtime,
      staging,
    });
  const mainSmoke =
    process.platform === "linux"
      ? await withLinuxReleaseSmokeSecretFixture(staging, runMainSmoke)
      : (await runMainSmoke({ environment: {}, initArguments: [] })).value;
  const { recoveryCodeCount, shutdownEvaluation } = mainSmoke;
  return {
    schemaVersion: 1,
    platform: process.platform,
    architecture: process.arch,
    bundledNodeVersion: process.versions.node,
    buildId,
    productVersion,
    checks: {
      cliHelp: "passed",
      backupCliHelp: "passed",
      serviceCliHelp: "passed",
      workerCliHelp: "passed",
      workerCliVersion: "passed",
      workerUnenrolledStatus: "passed",
      cleanHomeInitialization: "passed",
      mainHealth: "passed",
      adminStaticApp: "passed",
      loopbackOwnerClaim: "passed",
      ownerLogin: "passed",
      ownerSessionCookieContract: "passed",
      ownerSessionRoundTrip: "passed",
      recoveryCredentialsIssued: recoveryCodeCount,
      cleanShutdown: {
        status: "passed",
        markerObserved: shutdownEvaluation.markerObserved,
        naturalExit: shutdownEvaluation.naturalExit,
        exitCode: shutdownEvaluation.exitCode,
        signal: shutdownEvaluation.signal,
        shutdownTimedOut: shutdownEvaluation.shutdownTimedOut,
        forcedTermination: shutdownEvaluation.forcedTermination,
      },
    },
  };
}

async function runPackagedMainSmoke({
  buildId,
  entrypoint,
  fixture,
  productVersion,
  releaseEnvironment,
  runtime,
  staging,
}) {
  const smokeHome = await mkdtemp(join(dirname(staging), ".od-home-"));
  const child = spawn(
    runtime,
    [entrypoint, "init", "--home", smokeHome, ...fixture.initArguments],
    {
      cwd: staging,
      env: {
        ...releaseEnvironment,
        ...fixture.environment,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  let recoveryCodeCount;
  let shutdownTimedOut = false;
  let forcedTermination = false;
  let shutdownEvaluation;
  try {
    await waitUntil(
      () => stdout.includes('"event":"owner.claim.ready"') || hasChildExited(child),
      20_000,
    );
    if (hasChildExited(child) || !stdout.includes('"event":"owner.claim.ready"')) {
      throw new Error("The packaged init smoke test exited before readiness.");
    }

    const [health, admin, claim] = await Promise.all([
      fetch("http://127.0.0.1:4380/health/live", {
        signal: AbortSignal.timeout(5_000),
      }),
      fetch("http://127.0.0.1:4380/", {
        signal: AbortSignal.timeout(5_000),
      }),
      fetch("http://127.0.0.1:4381/", {
        signal: AbortSignal.timeout(5_000),
      }),
    ]);
    const healthBody = await health.json();
    const adminBody = await admin.text();
    const claimBody = await claim.text();
    if (
      !health.ok ||
      healthBody?.status !== "ok" ||
      healthBody?.version !== productVersion ||
      healthBody?.buildId !== buildId ||
      !admin.ok ||
      !adminBody.includes('id="root"') ||
      !claim.ok ||
      !claimBody.includes("Claim this OpenDelegate Main")
    ) {
      throw new Error("The packaged Main, Admin, and local-claim smoke surfaces did not agree.");
    }

    const claimToken = claimBody.match(/data-claim="([^"]+)"/)?.[1];
    if (claimToken === undefined) {
      throw new Error("The packaged local-claim page did not contain its one-time credential.");
    }
    const smokePassphrase = "release-smoke-correct-horse-2026";
    const claimed = await fetch("http://127.0.0.1:4381/api/v1/auth/claim", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:4381",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ claimToken, passphrase: smokePassphrase }),
      signal: AbortSignal.timeout(10_000),
    });
    const claimedBody = await claimed.json();
    recoveryCodeCount = Array.isArray(claimedBody?.recoveryCodes)
      ? claimedBody.recoveryCodes.length
      : 0;
    if (!claimed.ok || recoveryCodeCount !== 10) {
      throw new Error("The packaged loopback owner claim did not produce recovery credentials.");
    }

    const login = await fetch("http://127.0.0.1:4380/api/v1/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:4380",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ passphrase: smokePassphrase }),
      signal: AbortSignal.timeout(10_000),
    });
    const loginBody = await login.json();
    const sessionCookie = login.headers.get("set-cookie");
    if (
      !login.ok ||
      typeof loginBody?.csrfToken !== "string" ||
      typeof loginBody?.session?.ownerId !== "string" ||
      sessionCookie === null ||
      !sessionCookie.startsWith("__Host-opendelegate_session=") ||
      !/;\s*Path=\//iu.test(sessionCookie) ||
      !/;\s*HttpOnly/iu.test(sessionCookie) ||
      !/;\s*Secure/iu.test(sessionCookie) ||
      !/;\s*SameSite=Lax/iu.test(sessionCookie) ||
      /;\s*Domain=/iu.test(sessionCookie)
    ) {
      throw new Error("The packaged owner could not authenticate after local claim.");
    }
    const cookiePair = sessionCookie.split(";", 1)[0];
    const session = await fetch("http://127.0.0.1:4380/api/v1/auth/session", {
      headers: {
        cookie: cookiePair,
      },
      signal: AbortSignal.timeout(10_000),
    });
    const sessionBody = await session.json();
    if (
      !session.ok ||
      sessionBody?.session?.ownerId !== loginBody.session.ownerId ||
      typeof sessionBody?.csrfToken !== "string"
    ) {
      throw new Error("The packaged owner session cookie did not round-trip through Main.");
    }

    await Promise.all([
      stat(join(smokeHome, "config", "main.json")),
      stat(join(smokeHome, "state", "main.sqlite3")),
    ]);
  } finally {
    if (!hasChildExited(child)) {
      child.stdin.end();
    }
    await waitUntil(() => hasChildExited(child), 5_000).catch(async () => {
      shutdownTimedOut = true;
      if (!hasChildExited(child)) {
        forcedTermination = true;
        child.kill("SIGKILL");
      }
      await waitUntil(() => hasChildExited(child), 5_000);
    });
    shutdownEvaluation = evaluateSmokeShutdown({
      stdout,
      exitCode: child.exitCode,
      signalCode: child.signalCode,
      shutdownTimedOut,
      forcedTermination,
    });
    await rm(smokeHome, { force: true, recursive: true });
  }
  if (!shutdownEvaluation.accepted) {
    throw new Error(
      "The packaged Main did not complete a natural, zero-exit shutdown with a main.stopped marker.",
    );
  }
  return {
    observedOutput: [stdout, stderr],
    value: {
      recoveryCodeCount,
      shutdownEvaluation,
    },
  };
}

function hasChildExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitUntil(predicate, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${String(timeoutMilliseconds)}ms.`);
    }
    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, 50);
    });
  }
}

function assertReleaseHost() {
  if (process.versions.node !== REQUIRED_RELEASE_NODE_VERSION) {
    throw new Error(
      `Release bundles require the pinned Node.js ${REQUIRED_RELEASE_NODE_VERSION} runtime; received ${process.versions.node}.`,
    );
  }
  if (!supportedPlatforms.has(process.platform)) {
    throw new Error(`Unsupported release platform: ${process.platform}.`);
  }
  if (!supportedArchitectures.has(process.arch)) {
    throw new Error(`Unsupported release architecture: ${process.arch}.`);
  }
}

async function assertPathAbsent(path) {
  try {
    await stat(path);
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error("The release destination already exists; refusing to overwrite it.");
}

async function assertGitCommitExists(sourceRoot, commit, label, gitProvenance = null) {
  try {
    await runBoundProvenanceGit(
      gitProvenance,
      ["cat-file", "-e", `${commit}^{commit}`],
      sourceRoot,
      {
        capture: true,
      },
    );
  } catch (error) {
    throw new Error(`The ${label} does not exist as a Git commit in this repository.`, {
      cause: error,
    });
  }
}

export async function readSourceIdentity(sourceRoot = repositoryRoot) {
  const commit = (
    await runProvenanceGit(["rev-parse", "HEAD"], sourceRoot, { capture: true })
  ).stdout.trim();
  const status = (
    await runProvenanceGit(
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"],
      sourceRoot,
      { capture: true },
    )
  ).stdout;
  const commitEpoch = Number(
    (
      await runProvenanceGit(["show", "-s", "--format=%ct", commit], sourceRoot, {
        capture: true,
      })
    ).stdout.trim(),
  );
  if (!Number.isSafeInteger(commitEpoch) || commitEpoch < 0) {
    throw new Error("Git returned an invalid source commit timestamp.");
  }
  return { commit, commitEpoch, dirty: status !== "" };
}

function createBuildId(source, supportStatus) {
  const dirtySuffix = source.dirty ? "-dirty" : "";
  return `${supportStatus}-${source.commit.slice(0, 12)}${dirtySuffix}-${process.platform}-${process.arch}`;
}

function buildTimestamp(source, supportStatus) {
  const epoch = process.env["SOURCE_DATE_EPOCH"];
  if (epoch === undefined) {
    return supportStatus === "release-candidate"
      ? new Date(source.commitEpoch * 1000).toISOString()
      : new Date().toISOString();
  }
  const seconds = Number(epoch);
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new Error("SOURCE_DATE_EPOCH must be a non-negative integer.");
  }
  return new Date(seconds * 1000).toISOString();
}

async function pinBuildGitProvenance(options, dependencies = {}) {
  const hasExecutable = options.gitExecutable !== undefined;
  const hasDigest = options.gitExecutableSha256 !== undefined;
  if (hasExecutable !== hasDigest) {
    throw new Error("The Git executable path and lowercase SHA-256 must be provided together.");
  }
  if (!hasExecutable) {
    if (!options.internalPreview || options.platformSigningPolicy !== undefined) {
      throw new Error(
        "Supported or credential-bearing release builds require a pinned Git executable.",
      );
    }
    return null;
  }
  return (dependencies.pinGitProvenance ?? pinReleaseGitProvenance)({
    expectedExecutableSha256: options.gitExecutableSha256,
    executablePath: options.gitExecutable,
    repositoryRoot,
  });
}

function formatCounts(counts) {
  return Object.entries(counts)
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([status, count]) => `${status}=${count}`)
    .join(", ");
}

async function runProvenanceGit(arguments_, cwd, options = {}) {
  return runCommand("git", arguments_, cwd, {
    ...options,
    environment: {
      ...process.env,
      ...options.environment,
      GIT_NO_REPLACE_OBJECTS: "1",
    },
  });
}

async function runBoundProvenanceGit(gitProvenance, arguments_, cwd, options = {}) {
  if (gitProvenance === null) {
    return runProvenanceGit(arguments_, cwd, options);
  }
  return runPinnedReleaseGit(gitProvenance, arguments_);
}

export async function resolveExternalPnpmCli(sourceRoot, candidate) {
  if (typeof candidate !== "string" || !isAbsolute(candidate)) {
    throw new Error("A pnpm command requires an explicit absolute verified CLI path.");
  }
  const [canonicalSource, canonicalCandidate] = await Promise.all([
    realpath(sourceRoot),
    realpath(candidate),
  ]);
  validateReleaseDestination(canonicalSource, canonicalCandidate);
  const metadata = await lstat(canonicalCandidate);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("The pnpm CLI must resolve to a regular file outside the source checkout.");
  }
  return canonicalCandidate;
}

async function runCommand(command, arguments_, cwd, options = {}) {
  const externalPnpmCli =
    command === "pnpm" ? await resolveExternalPnpmCli(repositoryRoot, options.pnpmCli) : undefined;
  const executable = externalPnpmCli === undefined ? command : process.execPath;
  const executableArguments =
    externalPnpmCli === undefined ? arguments_ : [externalPnpmCli, ...arguments_];
  const child = spawn(executable, executableArguments, {
    cwd,
    env: options.environment ?? process.env,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  if (options.capture) {
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
  }
  const exitCode = await new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolvePromise(code));
  });
  if (exitCode !== 0) {
    throw new Error(
      `${command} ${arguments_.join(" ")} failed with exit code ${String(exitCode)}${stderr === "" ? "" : `:\n${stderr}`}`,
    );
  }
  return { stderr, stdout };
}

async function listFiles(directory) {
  const paths = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await listFiles(path)));
    } else if (entry.isFile()) {
      paths.push(path);
    } else {
      throw new Error("Release integrity manifests reject non-regular filesystem entries.");
    }
  }
  return paths.sort(compareCodeUnits);
}

async function listTreeEntries(directory) {
  const paths = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    paths.push(path);
    if (entry.isDirectory()) {
      paths.push(...(await listTreeEntries(path)));
    }
  }
  return paths.sort(compareCodeUnits);
}

function printHelp() {
  process.stdout.write(`Build an OpenDelegate platform bundle.

Usage:
  node tooling/build-release.mjs --destination ABSOLUTE_PATH --git-executable ABSOLUTE_PATH --git-executable-sha256 LOWERCASE_SHA256
  node tooling/build-release.mjs --destination ABSOLUTE_PATH --internal-preview
  node tooling/build-release.mjs --destination ABSOLUTE_PATH --git-executable ABSOLUTE_PATH --git-executable-sha256 LOWERCASE_SHA256 --platform-signing-policy ABSOLUTE_PATH --platform-signing-policy-sha256 LOWERCASE_SHA256

An incomplete first-milestone ledger can only produce a clearly marked unsupported
internal preview. Existing destinations and paths inside the source checkout are
always rejected.
`);
}

async function runCommittedReleaseCli(options, rawArguments, dependencies = {}) {
  const gitProvenance = await pinBuildGitProvenance(options, dependencies);
  const source =
    gitProvenance === null
      ? await readSourceIdentity(releaseToolRoot)
      : await readPinnedReleaseSourceIdentity(gitProvenance);
  assertCleanBundleSource(source);
  if (gitProvenance !== null) {
    await assertPinnedReleaseGitFilesMatchCommit(gitProvenance, runningReleaseToolPaths);
    await revalidatePinnedReleaseGitProvenance(gitProvenance);
  }
  const runnerParent = await mkdtemp(join(tmpdir(), "opendelegate-release-runner-"));
  try {
    const runnerRoot = await createCommittedSourceSnapshot(
      releaseToolRoot,
      source.commit,
      runnerParent,
      gitProvenance,
    );
    const runnerFile = join(runnerRoot, "tooling", "build-release.mjs");
    const child = spawn(process.execPath, [runnerFile, ...rawArguments], {
      cwd: releaseToolRoot,
      env: {
        ...process.env,
        [releaseRunnerSourceEnvironment]: releaseToolRoot,
        [releaseRunnerCommitEnvironment]: source.commit,
      },
      stdio: "inherit",
      windowsHide: true,
    });
    const exitCode = await new Promise((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolvePromise(code));
    });
    if (exitCode !== 0) {
      throw new Error(
        `The committed release runner exited without producing a bundle (exit ${String(exitCode)}).`,
      );
    }
  } finally {
    await rm(runnerParent, { force: true, recursive: true });
  }
}

if (await isDirectReleaseInvocation(process.argv[1])) {
  try {
    const arguments_ = parseReleaseArguments(process.argv.slice(2));
    if (arguments_.help) {
      printHelp();
    } else if (expectedReleaseCommit === undefined && configuredReleaseSource === undefined) {
      await runCommittedReleaseCli(arguments_, process.argv.slice(2));
    } else {
      const result = await buildRelease(arguments_);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Release build failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
