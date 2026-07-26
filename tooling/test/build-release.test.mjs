import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  PINNED_PNPM_ARCHIVE_INTEGRITY,
  PINNED_PNPM_VERSION,
  REQUIRED_RELEASE_NODE_VERSION,
  RELEASE_SKILL_DIRECTORIES,
  assertCleanBundleSource,
  assertPortableTree,
  assertSupportMatrixTarget,
  collectShaBoundAttestationPaths,
  createCommittedSourceSnapshot,
  createChecksumManifest,
  createMainDeployArguments,
  createWorkerDeployArguments,
  createPayloadManifest,
  determineSupportStatus,
  evaluateSmokeShutdown,
  inspectReleaseCandidateProvenance,
  isDirectReleaseInvocation,
  listProductionPackageDirectories,
  officialRuntimeArchiveFor,
  parseRawGitDiff,
  parseReleaseArguments,
  pruneRuntimeNativePackageArtifacts,
  readBoundedResponseBody,
  readSourceIdentity,
  removePackageManagerBinDirectories,
  resolveExternalPnpmCli,
  renderBundleReadme,
  renderUnixLauncher,
  renderWindowsLauncher,
  renderReleaseRouter,
  resolvePackageLegalFiles,
  validateReleaseDestination,
  validateReleaseDestinationName,
  validateReleaseAttestationDiff,
  verifyPinnedPnpmArchive,
  verifyRunningReleaseToolFiles,
  withCommittedSourceSnapshot,
  writeBundleReadmes,
  writeIntegrityManifests,
  writeThirdPartyNotices,
} from "../build-release.mjs";
import { stageNativeReleaseAssets } from "../native-release-assets.mjs";
import { withLinuxReleaseSmokeSecretFixture } from "../release-smoke-secret.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const execFile = promisify(execFileCallback);
const auditedCommit = "a".repeat(40);
const zeroObject = "0".repeat(40);
const changedObject = "b".repeat(40);

test("release bundles carry both agent-facing installation skills", () => {
  assert.deepEqual(RELEASE_SKILL_DIRECTORIES, ["opendelegate-init", "opendelegate-join"]);
});

test("target-native release assets stage stable production paths without freezing hashes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-native-release-assets-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const sourceRoot = join(root, "source");
  await mkdir(sourceRoot);

  for (const platform of ["win32", "linux", "darwin"]) {
    const stagingRoot = join(root, `staging-${platform}`);
    await mkdir(stagingRoot);
    const writeNative = async (outputRoot, filename, content) => {
      await mkdir(outputRoot, { recursive: true });
      const path = join(outputRoot, filename);
      await writeFile(path, content, "utf8");
      return path;
    };
    const result = await stageNativeReleaseAssets({
      platform,
      architecture: "x64",
      sourceRoot,
      stagingRoot,
      builders: {
        async linux({ outputRoot }) {
          const directory = join(outputRoot, "libexec");
          await mkdir(directory, { recursive: true });
          const helperExecutable = join(directory, "opendelegate-linux-computer-use");
          const fixtureExecutable = join(directory, "opendelegate-linux-computer-use-fixture");
          await writeFile(helperExecutable, "linux-helper\n", "utf8");
          await writeFile(fixtureExecutable, "linux-fixture\n", "utf8");
          return { helperExecutable, fixtureExecutable };
        },
        async macosComputerUse({ outputRoot }) {
          return {
            helperExecutable: await writeNative(
              outputRoot,
              "opendelegate-macos-computer-use",
              "mac-helper\n",
            ),
            fixtureExecutable: await writeNative(
              outputRoot,
              "opendelegate-computer-use-fixture",
              "mac-fixture\n",
            ),
          };
        },
        async macosKeychain({ outputRoot }) {
          return {
            helperExecutable: await writeNative(
              outputRoot,
              "opendelegate-keychain-helper",
              "keychain-helper\n",
            ),
          };
        },
        async windows({ outputRoot }) {
          return {
            helperExecutable: await writeNative(
              outputRoot,
              "opendelegate-windows-computer-use-helper.exe",
              "windows-helper\n",
            ),
            fixtureExecutable: await writeNative(
              outputRoot,
              "opendelegate-windows-computer-use-fixture.exe",
              "windows-fixture\n",
            ),
          };
        },
        async serviceHost({ outputRoot, hostPlatform }) {
          const suffix = hostPlatform === "win32" ? ".exe" : "";
          return {
            coreExecutable: await writeNative(
              outputRoot,
              `opendelegate-service-host${suffix}`,
              `${hostPlatform}-core-host\n`,
            ),
            helperExecutable: await writeNative(
              outputRoot,
              `opendelegate-session-helper${suffix}`,
              `${hostPlatform}-session-helper\n`,
            ),
          };
        },
      },
    });

    assert.equal(result.platform, platform);
    assert.equal(result.architecture, "x64");
    assert.equal(
      result.components.every((component) => !("sha256" in component)),
      true,
    );
    assert.equal(
      result.components.every(
        (component) => !component.path.includes("\\") && !component.path.startsWith("/"),
      ),
      true,
    );
    for (const component of result.components) {
      const stagedBytes = await readFile(join(stagingRoot, ...component.path.split("/")));
      assert.equal(
        stagedBytes.toString("utf8"),
        component.kind === "core-service-host"
          ? `${platform}-core-host\n`
          : component.kind === "session-helper-host"
            ? `${platform}-session-helper\n`
            : platform === "darwin" && component.kind === "secret-store-helper"
              ? "keychain-helper\n"
              : platform === "win32" && component.kind === "computer-use-helper"
                ? "windows-helper\n"
                : platform === "win32"
                  ? "windows-fixture\n"
                  : platform === "linux" && component.kind === "computer-use-helper"
                    ? "linux-helper\n"
                    : platform === "linux"
                      ? "linux-fixture\n"
                      : component.kind === "computer-use-helper"
                        ? "mac-helper\n"
                        : "mac-fixture\n",
      );
    }
    await assert.rejects(
      access(join(stagingRoot, "native-components.json")),
      (error) => error?.code === "ENOENT",
    );
  }
});

test("native release assets reject private build paths in UTF-8 and UTF-16LE", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-native-path-disclosure-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const sourceRoot = join(root, "source");
  await mkdir(sourceRoot);

  for (const disclosure of ["source-utf8", "source-case-utf8", "build-utf16le"]) {
    const stagingRoot = join(root, `staging-${disclosure}`);
    await mkdir(stagingRoot);
    await assert.rejects(
      stageNativeReleaseAssets({
        platform: "win32",
        architecture: "x64",
        sourceRoot,
        stagingRoot,
        builders: {
          async windows({ outputRoot }) {
            await mkdir(outputRoot, { recursive: true });
            const helperExecutable = join(outputRoot, "helper.exe");
            const fixtureExecutable = join(outputRoot, "fixture.exe");
            const leakedPath =
              disclosure === "source-utf8"
                ? sourceRoot
                : disclosure === "source-case-utf8"
                  ? sourceRoot.replace(/[a-z]/giu, (character) =>
                      character === character.toUpperCase()
                        ? character.toLowerCase()
                        : character.toUpperCase(),
                    )
                  : outputRoot;
            const encoding = disclosure === "build-utf16le" ? "utf16le" : "utf8";
            await writeFile(helperExecutable, Buffer.from(leakedPath, encoding));
            await writeFile(fixtureExecutable, "safe fixture\n");
            return { helperExecutable, fixtureExecutable };
          },
          async serviceHost({ outputRoot }) {
            await mkdir(outputRoot, { recursive: true });
            const coreExecutable = join(outputRoot, "core.exe");
            const helperExecutable = join(outputRoot, "session.exe");
            await writeFile(coreExecutable, "safe core\n");
            await writeFile(helperExecutable, "safe session\n");
            return { coreExecutable, helperExecutable };
          },
        },
      }),
      /private build-host path/u,
    );
  }
});

test("native release assets reject a private physical path behind a source alias", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-native-path-alias-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const physicalSource = join(root, "physical-source");
  const sourceRoot = join(root, "source-alias");
  const stagingRoot = join(root, "staging");
  await mkdir(physicalSource);
  await mkdir(stagingRoot);
  await symlink(physicalSource, sourceRoot, process.platform === "win32" ? "junction" : "dir");
  const physicalDisclosure = await realpath(sourceRoot);

  await assert.rejects(
    stageNativeReleaseAssets({
      platform: "win32",
      architecture: "x64",
      sourceRoot,
      stagingRoot,
      builders: {
        async windows({ outputRoot }) {
          await mkdir(outputRoot, { recursive: true });
          const helperExecutable = join(outputRoot, "helper.exe");
          const fixtureExecutable = join(outputRoot, "fixture.exe");
          await writeFile(helperExecutable, physicalDisclosure, "utf8");
          await writeFile(fixtureExecutable, "safe fixture\n");
          return { helperExecutable, fixtureExecutable };
        },
        async serviceHost({ outputRoot }) {
          await mkdir(outputRoot, { recursive: true });
          const coreExecutable = join(outputRoot, "core.exe");
          const helperExecutable = join(outputRoot, "session.exe");
          await writeFile(coreExecutable, "safe core\n");
          await writeFile(helperExecutable, "safe session\n");
          return { coreExecutable, helperExecutable };
        },
      },
    }),
    /private build-host path/u,
  );
});

function attestationLedger() {
  const reference = (path, character) => ({ path, sha256: character.repeat(64) });
  return {
    sourceCommit: auditedCommit,
    releaseStatus: "candidate",
    criteria: [
      {
        implementationStatus: "verified",
        liveProofStatus: "verified",
        evidence: [
          "docs/release/evidence/implementation.json",
          "docs/release/evidence/live.json",
          "docs/release/evidence/generic-only.json",
        ],
        verification: {
          implementation: {
            sourceCommit: auditedCommit,
            attestationId: "implementation-proof",
            evidence: [reference("docs/release/evidence/implementation.json", "1")],
          },
          liveProof: {
            sourceCommit: auditedCommit,
            attestationId: "live-proof",
            evidence: [reference("docs/release/evidence/live.json", "2")],
          },
        },
      },
    ],
    candidateAttestation: {
      sourceCommit: auditedCommit,
      attestationId: "candidate-proof",
      evidence: [reference("docs/release/evidence/candidate.json", "3")],
    },
  };
}

function modified(path, overrides = {}) {
  return {
    oldMode: "100644",
    newMode: "100644",
    oldObject: auditedCommit,
    newObject: changedObject,
    status: "M",
    score: "",
    path,
    ...overrides,
  };
}

async function git(root, arguments_) {
  const result = await execFile("git", arguments_, { cwd: root, windowsHide: true });
  return result.stdout.trim();
}

test("release arguments require an explicit absolute destination", () => {
  const signingPolicy = resolve("platform-signing-policy.json");
  const signingPolicySha256 = "a".repeat(64);
  const gitExecutable = resolve("git");
  const gitExecutableSha256 = "b".repeat(64);
  assert.throws(() => parseReleaseArguments([]), /--destination is required/);
  assert.deepEqual(
    parseReleaseArguments([
      "--destination",
      resolve("release"),
      "--internal-preview",
      "--git-executable",
      gitExecutable,
      "--git-executable-sha256",
      gitExecutableSha256,
      "--platform-signing-policy",
      signingPolicy,
      "--platform-signing-policy-sha256",
      signingPolicySha256,
    ]),
    {
      destination: resolve("release"),
      gitExecutable,
      gitExecutableSha256,
      help: false,
      internalPreview: true,
      platformSigningPolicy: signingPolicy,
      platformSigningPolicySha256: signingPolicySha256,
    },
  );
  assert.deepEqual(
    parseReleaseArguments(["--destination", resolve("preview"), "--internal-preview"]),
    {
      destination: resolve("preview"),
      help: false,
      internalPreview: true,
    },
  );
  assert.throws(
    () => parseReleaseArguments(["--destination", resolve("release")]),
    /require --git-executable/u,
  );
  assert.throws(
    () =>
      parseReleaseArguments([
        "--destination",
        resolve("release"),
        "--platform-signing-policy",
        "relative-policy.json",
      ]),
    /platform-signing-policy must be an absolute path/u,
  );
  assert.throws(
    () =>
      parseReleaseArguments([
        "--destination",
        resolve("release"),
        "--platform-signing-policy",
        signingPolicy,
      ]),
    /policy path and lowercase SHA-256 must be provided together/u,
  );
  assert.throws(
    () =>
      parseReleaseArguments([
        "--destination",
        resolve("release"),
        "--platform-signing-policy-sha256",
        signingPolicySha256,
      ]),
    /policy path and lowercase SHA-256 must be provided together/u,
  );
  assert.throws(
    () =>
      parseReleaseArguments([
        "--destination",
        resolve("release"),
        "--platform-signing-policy",
        signingPolicy,
        "--platform-signing-policy-sha256",
        signingPolicySha256.toUpperCase(),
      ]),
    /must be a lowercase SHA-256/u,
  );
  assert.throws(() => parseReleaseArguments(["--wat"]), /Unknown release-build option/);
});

test("release CLI detection follows canonical filesystem paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-release-cli-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const realDirectory = join(root, "real");
  const aliasDirectory = join(root, "alias");
  const modulePath = join(realDirectory, "build-release.mjs");
  await mkdir(realDirectory);
  await writeFile(modulePath, "export {};\n", "utf8");
  await symlink(realDirectory, aliasDirectory, process.platform === "win32" ? "junction" : "dir");

  assert.equal(
    await isDirectReleaseInvocation(join(aliasDirectory, "build-release.mjs"), modulePath),
    true,
  );
  assert.equal(await isDirectReleaseInvocation(undefined, modulePath), false);
  assert.equal(await isDirectReleaseInvocation(join(root, "missing.mjs"), modulePath), false);
});

test("Linux packaged smoke credentials stay outside the bundle and are always removed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-linux-smoke-secret-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const staging = join(root, "staging");
  await mkdir(staging);
  await writeFile(join(staging, "payload.txt"), "safe payload\n", "utf8");
  let fixtureRoot;

  const value = await withLinuxReleaseSmokeSecretFixture(staging, async (fixture) => {
    assert.deepEqual(fixture.initArguments.slice(0, 1), ["--secret-backend-config"]);
    const configPath = fixture.initArguments[1];
    fixtureRoot = resolve(configPath, "..");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(Object.keys(config), ["backend", "credentialName", "vaultRoot"]);
    assert.equal(config.backend, "linux-systemd-credential-vault");
    assert.equal(config.credentialName, "opendelegate-release-smoke-vault-key");
    assert.equal(config.vaultRoot.startsWith(fixtureRoot), true);
    assert.equal(fixture.environment.CREDENTIALS_DIRECTORY.startsWith(fixtureRoot), true);
    const credential = await readFile(
      join(fixture.environment.CREDENTIALS_DIRECTORY, config.credentialName),
    );
    assert.equal(credential.byteLength, 32);
    return {
      observedOutput: ["safe stdout", "safe stderr"],
      value: "completed",
    };
  });

  assert.equal(value, "completed");
  await assert.rejects(access(fixtureRoot), (error) => error?.code === "ENOENT");

  await assert.rejects(
    withLinuxReleaseSmokeSecretFixture(staging, async (fixture) => {
      const config = JSON.parse(await readFile(fixture.initArguments[1], "utf8"));
      const credential = await readFile(
        join(fixture.environment.CREDENTIALS_DIRECTORY, config.credentialName),
      );
      await writeFile(join(staging, "leaked-key.bin"), credential);
      return { observedOutput: [], value: undefined };
    }),
    /credential material entered the release payload/u,
  );
});

test("workspace bin entrypoints are committed executable before pnpm links them", async () => {
  const { stdout } = await execFile(
    "git",
    ["ls-files", "--stage", "--", "apps/main/src/cli.ts", "apps/worker/src/cli.ts"],
    { cwd: repositoryRoot },
  );

  assert.match(stdout, /^100755 [0-9a-f]+ 0\tapps\/main\/src\/cli\.ts$/mu);
  assert.match(stdout, /^100755 [0-9a-f]+ 0\tapps\/worker\/src\/cli\.ts$/mu);
});

test("the release runtime pin matches local and hosted build configuration", async () => {
  assert.equal(
    (await readFile(join(repositoryRoot, ".node-version"), "utf8")).trim(),
    REQUIRED_RELEASE_NODE_VERSION,
  );
  assert.match(
    await readFile(join(repositoryRoot, ".github", "workflows", "ci.yml"), "utf8"),
    new RegExp(`node-version: ${REQUIRED_RELEASE_NODE_VERSION.replaceAll(".", String.raw`\.`)}`),
  );
});

test("every bundle mode requires a clean committed source", () => {
  assert.doesNotThrow(() => assertCleanBundleSource({ commit: auditedCommit, dirty: false }));
  assert.throws(
    () => assertCleanBundleSource({ commit: auditedCommit, dirty: true }),
    /clean committed checkout/u,
  );
});

test("the reviewed package-manager and dependency execution policies stay pinned", async () => {
  const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  const workspace = await readFile(join(repositoryRoot, "pnpm-workspace.yaml"), "utf8");
  const lockfile = await readFile(join(repositoryRoot, "pnpm-lock.yaml"), "utf8");

  assert.equal(manifest.packageManager, `pnpm@${PINNED_PNPM_VERSION}`);
  assert.equal(manifest.devDependencies?.pnpm, PINNED_PNPM_VERSION);
  assert.equal(manifest.engines?.pnpm, ">=11.15.1 <12");
  for (const workflow of ["ci.yml", "security.yml"]) {
    assert.match(
      await readFile(join(repositoryRoot, ".github", "workflows", workflow), "utf8"),
      /version:\s*11\.15\.1/u,
    );
  }
  assert.match(workspace, /^minimumReleaseAge:\s*1440\s*$/mu);
  assert.match(workspace, /^minimumReleaseAgeStrict:\s*true\s*$/mu);
  assert.match(workspace, /^trustLockfile:\s*false\s*$/mu);
  assert.match(workspace, /^\s+better-sqlite3@13\.0\.1:\s*true\s*$/mu);
  assert.match(workspace, /^\s+esbuild@0\.28\.1:\s*true\s*$/mu);
  assert.doesNotMatch(workspace, /set this to true or false/u);
  assert.equal(
    lockfile.includes(
      `pnpm@${PINNED_PNPM_VERSION}:\n    resolution: {integrity: ${PINNED_PNPM_ARCHIVE_INTEGRITY}}`,
    ),
    true,
  );
  assert.throws(
    () => verifyPinnedPnpmArchive(Buffer.from("untrusted pnpm archive", "utf8")),
    /hash did not match/u,
  );
});

test("package-manager downloads stop at the streaming byte limit", async () => {
  const exact = await readBoundedResponseBody(new Response(new Uint8Array([1, 2, 3, 4])), 4);
  assert.deepEqual([...exact], [1, 2, 3, 4]);

  let cancelled = false;
  const oversized = new Response(
    new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(6));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  await assert.rejects(readBoundedResponseBody(oversized, 5), /exceeds its byte limit/u);
  assert.equal(cancelled, true);
  await assert.rejects(readBoundedResponseBody(new Response(null), 5), /no bounded readable body/u);
});

test("pnpm execution cannot resolve from the live source checkout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-external-pnpm-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const externalCli = join(root, "pnpm.cjs");
  await writeFile(externalCli, "export {};\n", "utf8");

  assert.equal(
    await resolveExternalPnpmCli(repositoryRoot, externalCli),
    await realpath(externalCli),
  );
  await assert.rejects(
    resolveExternalPnpmCli(
      repositoryRoot,
      join(repositoryRoot, "node_modules", "pnpm", "bin", "pnpm.cjs"),
    ),
    /outside the source checkout/u,
  );
});

test("Main deployment opts into pnpm's pinned non-injected workspace behavior", () => {
  assert.deepEqual(createMainDeployArguments("release/apps/main"), [
    "--config.node-linker=hoisted",
    "--filter",
    "@opendelegate/main",
    "deploy",
    "--legacy",
    "--prod",
    "release/apps/main",
  ]);
});

test("Worker deployment uses the same pinned portable production layout", () => {
  assert.deepEqual(createWorkerDeployArguments("release/apps/worker"), [
    "--config.node-linker=hoisted",
    "--filter",
    "@opendelegate/worker",
    "deploy",
    "--legacy",
    "--prod",
    "release/apps/worker",
  ]);
});

test("release deployment removes package-manager bins without following their links", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-deploy-bin-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const nodeModules = join(root, "node_modules");
  const packageDirectory = join(nodeModules, "runtime-package");
  const nestedBin = join(packageDirectory, "node_modules", ".bin");
  const packageDataBin = join(packageDirectory, "assets", ".bin");
  const linkTarget = join(root, "retained-target");
  await mkdir(nestedBin, { recursive: true });
  await mkdir(packageDataBin, { recursive: true });
  await mkdir(linkTarget);
  await writeFile(join(packageDirectory, "index.js"), "export {};\n", "utf8");
  await writeFile(join(nestedBin, "tool"), "unused executable shim\n", "utf8");
  await writeFile(join(packageDataBin, "retained.bin"), "package data\n", "utf8");
  await writeFile(join(linkTarget, "retained.txt"), "retained\n", "utf8");
  await symlink(
    linkTarget,
    join(nodeModules, ".bin"),
    process.platform === "win32" ? "junction" : "dir",
  );

  await removePackageManagerBinDirectories(nodeModules);

  assert.equal(await readFile(join(packageDirectory, "index.js"), "utf8"), "export {};\n");
  assert.equal(await readFile(join(packageDataBin, "retained.bin"), "utf8"), "package data\n");
  assert.equal(await readFile(join(linkTarget, "retained.txt"), "utf8"), "retained\n");
  await assert.rejects(readFile(join(nodeModules, ".bin", "retained.txt"), "utf8"), {
    code: "ENOENT",
  });
  await assert.rejects(readFile(join(nestedBin, "tool"), "utf8"), { code: "ENOENT" });
});

test("release deployment retains only the target better-sqlite3 prebuild", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-native-package-prune-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const nodeModules = join(root, "node_modules");
  const packageDirectory = join(nodeModules, "better-sqlite3");
  const prebuilds = join(packageDirectory, "prebuilds");
  const buildDirectory = join(packageDirectory, "build");
  await mkdir(prebuilds, { recursive: true });
  await mkdir(buildDirectory);
  await writeFile(
    join(packageDirectory, "package.json"),
    JSON.stringify({ name: "better-sqlite3", version: "13.0.1" }),
    "utf8",
  );
  await writeFile(join(packageDirectory, "LICENSE"), "MIT fixture\n", "utf8");
  await writeFile(
    join(buildDirectory, "better_sqlite3.vcxproj"),
    "C:\\Users\\builder\\AppData\\Local\\node-gyp\\Cache\\24.18.0\n",
    "utf8",
  );
  await writeFile(join(prebuilds, "darwin-arm64.node"), "darwin", "utf8");
  await writeFile(join(prebuilds, "linux-x64.node"), "linux", "utf8");
  await writeFile(join(prebuilds, "win32-x64.node"), "windows", "utf8");

  await pruneRuntimeNativePackageArtifacts(nodeModules, "win32", "x64");

  assert.equal(await readFile(join(prebuilds, "win32-x64.node"), "utf8"), "windows");
  assert.equal(await readFile(join(packageDirectory, "LICENSE"), "utf8"), "MIT fixture\n");
  await assert.rejects(readFile(join(prebuilds, "darwin-arm64.node"), "utf8"), {
    code: "ENOENT",
  });
  await assert.rejects(readFile(join(prebuilds, "linux-x64.node"), "utf8"), {
    code: "ENOENT",
  });
  await assert.rejects(readFile(join(buildDirectory, "better_sqlite3.vcxproj"), "utf8"), {
    code: "ENOENT",
  });
});

test("native package pruning rejects linked roots without touching external targets", async (t) => {
  for (const linkedRoot of ["node-modules", "package", "prebuilds", "build"]) {
    const root = await mkdtemp(join(tmpdir(), `opendelegate-native-package-link-${linkedRoot}-`));
    t.after(() => rm(root, { force: true, recursive: true }));
    const ordinaryNodeModules = join(root, "node_modules");
    const external = join(root, "external");
    const nodeModules =
      linkedRoot === "node-modules" ? join(root, "linked-node-modules") : ordinaryNodeModules;
    const packageDirectory = join(nodeModules, "better-sqlite3");
    const externalPackage = join(external, "better-sqlite3");
    const physicalPackage = linkedRoot === "package" ? externalPackage : packageDirectory;
    const physicalPrebuilds =
      linkedRoot === "prebuilds" ? join(external, "prebuilds") : join(physicalPackage, "prebuilds");
    const physicalBuild =
      linkedRoot === "build" ? join(external, "build") : join(physicalPackage, "build");

    if (linkedRoot === "node-modules") {
      await mkdir(externalPackage, { recursive: true });
      await symlink(external, nodeModules, process.platform === "win32" ? "junction" : "dir");
    } else {
      await mkdir(ordinaryNodeModules, { recursive: true });
      if (linkedRoot === "package") {
        await mkdir(externalPackage, { recursive: true });
        await symlink(
          externalPackage,
          packageDirectory,
          process.platform === "win32" ? "junction" : "dir",
        );
      } else {
        await mkdir(packageDirectory, { recursive: true });
      }
    }
    await mkdir(physicalPrebuilds, { recursive: true });
    await mkdir(physicalBuild, { recursive: true });
    await writeFile(
      join(physicalPackage, "package.json"),
      JSON.stringify({ name: "better-sqlite3", version: "13.0.1" }),
      "utf8",
    );
    await writeFile(join(physicalPrebuilds, "win32-x64.node"), "windows", "utf8");
    await writeFile(join(physicalPrebuilds, "linux-x64.node"), "linux", "utf8");
    await writeFile(join(physicalBuild, "sentinel.txt"), "outside staging\n", "utf8");

    if (linkedRoot === "prebuilds") {
      await symlink(
        physicalPrebuilds,
        join(packageDirectory, "prebuilds"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } else if (linkedRoot === "build") {
      await symlink(
        physicalBuild,
        join(packageDirectory, "build"),
        process.platform === "win32" ? "junction" : "dir",
      );
    }

    await assert.rejects(
      pruneRuntimeNativePackageArtifacts(nodeModules, "win32", "x64"),
      /escaped its release staging boundary/u,
    );
    assert.equal(await readFile(join(physicalPrebuilds, "linux-x64.node"), "utf8"), "linux");
    assert.equal(await readFile(join(physicalBuild, "sentinel.txt"), "utf8"), "outside staging\n");
  }
});

test("native package pruning fails closed without one exact non-empty target prebuild", async (t) => {
  for (const targetContent of [undefined, ""]) {
    const root = await mkdtemp(join(tmpdir(), "opendelegate-native-package-invalid-"));
    t.after(() => rm(root, { force: true, recursive: true }));
    const nodeModules = join(root, "node_modules");
    const packageDirectory = join(nodeModules, "better-sqlite3");
    const prebuilds = join(packageDirectory, "prebuilds");
    await mkdir(prebuilds, { recursive: true });
    await writeFile(
      join(packageDirectory, "package.json"),
      JSON.stringify({ name: "better-sqlite3", version: "13.0.1" }),
      "utf8",
    );
    await writeFile(join(prebuilds, "linux-x64.node"), "linux", "utf8");
    if (targetContent !== undefined) {
      await writeFile(join(prebuilds, "win32-x64.node"), targetContent, "utf8");
    }

    await assert.rejects(
      pruneRuntimeNativePackageArtifacts(nodeModules, "win32", "x64"),
      /target better-sqlite3 prebuild is (?:empty|unavailable)/u,
    );
  }
});

test("native package pruning is pinned to the reviewed better-sqlite3 layout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-native-package-version-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const nodeModules = join(root, "node_modules");
  const packageDirectory = join(nodeModules, "better-sqlite3");
  const prebuilds = join(packageDirectory, "prebuilds");
  await mkdir(prebuilds, { recursive: true });
  await writeFile(
    join(packageDirectory, "package.json"),
    JSON.stringify({ name: "better-sqlite3", version: "13.0.2" }),
    "utf8",
  );
  await writeFile(join(prebuilds, "win32-x64.node"), "windows", "utf8");

  await assert.rejects(
    pruneRuntimeNativePackageArtifacts(nodeModules, "win32", "x64"),
    /package identity is invalid/u,
  );
});

test("every supported release target has a pinned official Node.js archive", () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    for (const architecture of ["arm64", "x64"]) {
      const input = officialRuntimeArchiveFor(platform, architecture);
      assert.match(input.url, /^https:\/\/nodejs\.org\/dist\/v24\.18\.0\//);
      assert.match(input.shasumsUrl, /\/SHASUMS256\.txt$/);
      assert.match(input.sha256, /^[0-9a-f]{64}$/);
    }
  }
  assert.throws(
    () => officialRuntimeArchiveFor("freebsd", "x64"),
    /No audited Node.js runtime input/,
  );
});

test("platform packages may reference a retained same-project license file", () => {
  const packages = [
    {
      name: "@example/native-win32",
      version: "1.0.0",
      packagePath: "node_modules/@example/native-win32",
      license: "MIT",
      repositoryUrl: "https://github.com/example/project",
      legalFiles: [],
    },
    {
      name: "@example/core",
      version: "1.0.0",
      packagePath: "node_modules/@example/core",
      license: "MIT",
      repositoryUrl: "https://github.com/example/project",
      legalFiles: [{ path: "node_modules/@example/core/LICENSE", sha256: "a".repeat(64) }],
    },
  ];

  resolvePackageLegalFiles(packages);

  assert.deepEqual(packages[0].legalFiles, packages[1].legalFiles);
  assert.deepEqual(packages[0].legalFilesSource, {
    name: "@example/core",
    version: "1.0.0",
    packagePath: "node_modules/@example/core",
  });
});

test("a missing unrelated license file fails closed", () => {
  assert.throws(
    () =>
      resolvePackageLegalFiles([
        {
          name: "missing-license",
          version: "1.0.0",
          packagePath: "node_modules/missing-license",
          license: "MIT",
          repositoryUrl: "https://github.com/example/missing",
          legalFiles: [],
        },
      ]),
    /no retained license or notice file and no same-project license source/,
  );
});

test("the exact standardwebhooks release retains its curated upstream license", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-standardwebhooks-license-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const staging = join(root, "staging");
  const mainDirectory = join(staging, "apps", "main");
  const packageDirectory = join(mainDirectory, "node_modules", "standardwebhooks");
  const sourceRoot = join(root, "source");
  const adminManifestDirectory = join(sourceRoot, "apps", "admin-web");
  const curatedLicensePath =
    "docs/legal/runtime-license-overrides/standardwebhooks-1.0.0-LICENSE.txt";
  await mkdir(packageDirectory, { recursive: true });
  await mkdir(adminManifestDirectory, { recursive: true });
  await mkdir(join(staging, "docs", "legal", "runtime-license-overrides"), {
    recursive: true,
  });
  await writeFile(
    join(packageDirectory, "package.json"),
    JSON.stringify({
      name: "standardwebhooks",
      version: "1.0.0",
      license: "MIT",
      repository: "https://github.com/standard-webhooks/standard-webhooks",
    }),
    "utf8",
  );
  await writeFile(
    join(adminManifestDirectory, "package.json"),
    JSON.stringify({ name: "admin-fixture", version: "1.0.0", dependencies: {} }),
    "utf8",
  );
  await copyFile(
    join(repositoryRoot, ...curatedLicensePath.split("/")),
    join(staging, curatedLicensePath),
  );

  await writeThirdPartyNotices(staging, mainDirectory, sourceRoot);

  const inventory = JSON.parse(await readFile(join(staging, "THIRD_PARTY_NOTICES.json"), "utf8"));
  const standardWebhooks = inventory.packages.find(
    (packageEntry) => packageEntry.name === "standardwebhooks",
  );
  assert.deepEqual(standardWebhooks?.legalFilesSource, {
    type: "curated-versioned-upstream-copy",
    source:
      "https://raw.githubusercontent.com/standard-webhooks/standard-webhooks/c7cd8a9eadf9879d6dca345e168dc8d15d19e487/libraries/LICENSE",
  });
  assert.equal(standardWebhooks?.legalFiles.length, 1);
  assert.equal(standardWebhooks?.legalFiles[0]?.path, curatedLicensePath);
  assert.equal(
    standardWebhooks?.legalFiles[0]?.sha256,
    createHash("sha256")
      .update(await readFile(join(staging, curatedLicensePath)))
      .digest("hex"),
  );

  await writeFile(
    join(packageDirectory, "package.json"),
    JSON.stringify({
      name: "standardwebhooks",
      version: "1.0.1",
      license: "MIT",
      repository: "https://github.com/standard-webhooks/standard-webhooks",
    }),
    "utf8",
  );
  await assert.rejects(
    writeThirdPartyNotices(staging, mainDirectory, sourceRoot),
    /standardwebhooks@1\.0\.1/,
  );
});

test("release output cannot overwrite or enter the source checkout", () => {
  const source = resolve("repository");
  assert.throws(
    () => validateReleaseDestination(source, join(source, "dist")),
    /outside the source checkout/,
  );
  assert.throws(
    () => validateReleaseDestination(source, "relative-release"),
    /must be an absolute path/,
  );
  assert.equal(
    validateReleaseDestination(source, resolve(source, "..", "release")),
    resolve(source, "..", "release"),
  );
  if (process.platform === "win32") {
    assert.equal(validateReleaseDestination("C:\\source", "D:\\release"), "D:\\release");
  }
});

test("an internal preview is unmistakable from its destination name", () => {
  assert.throws(
    () => validateReleaseDestinationName(resolve("OpenDelegate-0.1.0"), true),
    /must contain 'internal-preview'/,
  );
  assert.doesNotThrow(() =>
    validateReleaseDestinationName(resolve("OpenDelegate-0.1.0-internal-preview-win32-x64"), true),
  );
  assert.doesNotThrow(() =>
    validateReleaseDestinationName(resolve("OpenDelegate-0.1.0-win32-x64"), false),
  );
});

test("an incomplete ledger can only create an explicitly unsupported preview", () => {
  const incomplete = { complete: false, releaseStatus: "blocked" };
  assert.throws(
    () => determineSupportStatus(incomplete, false),
    /first-milestone release gate is blocked/,
  );
  assert.equal(determineSupportStatus(incomplete, true), "internal-preview-blocked");
  const complete = { complete: true, releaseStatus: "candidate" };
  assert.equal(determineSupportStatus(complete, false), "release-candidate");
  assert.equal(determineSupportStatus(complete, true), "internal-preview-complete");
  assert.throws(
    () => determineSupportStatus({ complete: true, releaseStatus: "released" }, false),
    /promotion attestation/,
  );
  assert.throws(
    () => determineSupportStatus({ complete: false, releaseStatus: "candidate" }, true),
    /inconsistent/,
  );
});

test("release candidates are limited to the exact declared support-matrix targets", () => {
  for (const [platform, architecture] of [
    ["darwin", "arm64"],
    ["linux", "x64"],
    ["win32", "x64"],
  ]) {
    assert.doesNotThrow(() =>
      assertSupportMatrixTarget(platform, architecture, "release-candidate"),
    );
  }
  for (const [platform, architecture] of [
    ["darwin", "x64"],
    ["linux", "arm64"],
    ["win32", "arm64"],
  ]) {
    assert.throws(
      () => assertSupportMatrixTarget(platform, architecture, "release-candidate"),
      /may create an internal preview only/,
    );
    assert.doesNotThrow(() =>
      assertSupportMatrixTarget(platform, architecture, "internal-preview-complete"),
    );
  }
});

test("attestation diff permits only the ledger and SHA-bound verification artifacts", () => {
  const ledger = attestationLedger();
  assert.deepEqual(collectShaBoundAttestationPaths(ledger), [
    "docs/release/evidence/candidate.json",
    "docs/release/evidence/implementation.json",
    "docs/release/evidence/live.json",
  ]);

  assert.deepEqual(
    validateReleaseAttestationDiff(ledger, [
      modified("docs/release/acceptance-evidence.json"),
      modified("docs/release/evidence/implementation.json", {
        oldMode: "000000",
        oldObject: zeroObject,
        status: "A",
      }),
      modified("docs/release/evidence/live.json"),
      modified("docs/release/evidence/candidate.json", {
        oldMode: "000000",
        oldObject: zeroObject,
        status: "A",
      }),
    ]),
    [
      "docs/release/acceptance-evidence.json",
      "docs/release/evidence/candidate.json",
      "docs/release/evidence/implementation.json",
      "docs/release/evidence/live.json",
    ],
  );
});

test("attestation metadata ordering is locale-independent", () => {
  const ledger = attestationLedger();
  ledger.candidateAttestation.evidence.push(
    { path: "docs/release/evidence/z.json", sha256: "4".repeat(64) },
    { path: "docs/release/evidence/ä.json", sha256: "5".repeat(64) },
  );
  assert.deepEqual(collectShaBoundAttestationPaths(ledger).slice(-2), [
    "docs/release/evidence/z.json",
    "docs/release/evidence/ä.json",
  ]);
});

test("generic criterion evidence never authorizes an attestation diff", () => {
  assert.throws(
    () =>
      validateReleaseAttestationDiff(attestationLedger(), [
        modified("docs/release/acceptance-evidence.json"),
        modified("docs/release/evidence/generic-only.json", {
          oldMode: "000000",
          oldObject: zeroObject,
          status: "A",
        }),
      ]),
    /not SHA-bound by criterion verification or candidateAttestation/u,
  );
});

test("attestation diff rejects source, ordinary documentation, schemas, and unreferenced files", () => {
  for (const path of [
    "tooling/build-release.mjs",
    "docs/release/README.md",
    "docs/release/acceptance-evidence.schema.json",
    "docs/release/evidence/unreferenced.json",
  ]) {
    assert.throws(
      () =>
        validateReleaseAttestationDiff(attestationLedger(), [
          modified("docs/release/acceptance-evidence.json"),
          modified(path),
        ]),
      path.startsWith("docs/release/evidence/")
        ? /not SHA-bound/u
        : /may change only docs\/release\/acceptance-evidence\.json/u,
      path,
    );
  }
});

test("attestation diff rejects destructive statuses, rename or copy detection, and special modes", () => {
  const cases = [
    {
      entry: modified("docs/release/evidence/live.json", {
        newMode: "000000",
        newObject: zeroObject,
        status: "D",
      }),
      pattern: /may not delete files/u,
    },
    {
      entry: modified("docs/release/evidence/live-renamed.json", {
        oldPath: "docs/release/evidence/live.json",
        status: "R",
      }),
      pattern: /may not contain Git renames or copies/u,
    },
    {
      entry: modified("docs/release/evidence/candidate-copy.json", {
        oldPath: "docs/release/evidence/candidate.json",
        status: "C",
      }),
      pattern: /may not contain Git renames or copies/u,
    },
    {
      entry: modified("docs/release/evidence/live.json", {
        oldMode: "120000",
        status: "T",
      }),
      pattern: /may not change file types/u,
    },
    {
      entry: modified("docs/release/evidence/live.json", { newMode: "100755" }),
      pattern: /regular mode-100644/u,
    },
    {
      entry: modified("docs/release/evidence/live.json", { newMode: "120000" }),
      pattern: /regular mode-100644/u,
    },
    {
      entry: modified("docs/release/evidence/live.json", { newMode: "160000" }),
      pattern: /regular mode-100644/u,
    },
  ];

  for (const { entry, pattern } of cases) {
    assert.throws(
      () =>
        validateReleaseAttestationDiff(attestationLedger(), [
          modified("docs/release/acceptance-evidence.json"),
          entry,
        ]),
      pattern,
    );
  }
  assert.throws(
    () =>
      validateReleaseAttestationDiff(attestationLedger(), [
        modified("docs/release/evidence/live.json"),
      ]),
    /attestation commit must modify docs\/release\/acceptance-evidence\.json/u,
  );
});

test("raw Git attestation diff parser retains rename identity and exact file modes", () => {
  const raw = [
    `:100644 100644 ${auditedCommit} ${changedObject} M`,
    "docs/release/acceptance-evidence.json",
    `:100644 100644 ${auditedCommit} ${changedObject} R100`,
    "docs/release/evidence/old.json",
    "docs/release/evidence/new.json",
    "",
  ].join("\0");
  assert.deepEqual(parseRawGitDiff(raw), [
    modified("docs/release/acceptance-evidence.json"),
    {
      oldMode: "100644",
      newMode: "100644",
      oldObject: auditedCommit,
      newObject: changedObject,
      status: "R",
      score: "100",
      oldPath: "docs/release/evidence/old.json",
      path: "docs/release/evidence/new.json",
    },
  ]);
});

test("candidate provenance resolves a real audited ancestor and restricted attestation commit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-provenance-git-"));
  t.after(async () => {
    await rm(root, { force: true, recursive: true });
  });
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "user.name", "OpenDelegate test"]);
  await git(root, ["config", "user.email", "test@opendelegate.invalid"]);
  await mkdir(join(root, "docs", "release", "evidence"), { recursive: true });
  await writeFile(join(root, ".gitignore"), ".env.*\n", "utf8");
  await writeFile(
    join(root, "docs", "release", "acceptance-evidence.json"),
    '{"releaseStatus":"blocked"}\n',
    "utf8",
  );
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "audited source"]);
  const sourceCommit = await git(root, ["rev-parse", "HEAD"]);

  await writeFile(
    join(root, "docs", "release", "acceptance-evidence.json"),
    `{"releaseStatus":"candidate","sourceCommit":"${sourceCommit}"}\n`,
    "utf8",
  );
  await writeFile(join(root, "docs", "release", "evidence", "live.json"), "{}\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "release attestation"]);
  const buildCommit = await git(root, ["rev-parse", "HEAD"]);

  const ledger = attestationLedger();
  ledger.sourceCommit = sourceCommit;
  ledger.criteria[0].verification.implementation.sourceCommit = sourceCommit;
  ledger.criteria[0].verification.liveProof.sourceCommit = sourceCommit;
  ledger.candidateAttestation.sourceCommit = sourceCommit;
  assert.deepEqual(
    await inspectReleaseCandidateProvenance(root, ledger, {
      commit: buildCommit,
      dirty: false,
    }),
    {
      auditedSourceCommit: sourceCommit,
      buildCommit,
      changedAttestationPaths: [
        "docs/release/acceptance-evidence.json",
        "docs/release/evidence/live.json",
      ],
    },
  );

  await git(root, ["replace", sourceCommit, buildCommit]);
  assert.deepEqual(
    await inspectReleaseCandidateProvenance(root, ledger, {
      commit: buildCommit,
      dirty: false,
    }),
    {
      auditedSourceCommit: sourceCommit,
      buildCommit,
      changedAttestationPaths: [
        "docs/release/acceptance-evidence.json",
        "docs/release/evidence/live.json",
      ],
    },
  );
  await git(root, ["replace", "-d", sourceCommit]);

  await git(root, ["config", "status.showUntrackedFiles", "no"]);
  await mkdir(join(root, "apps", "main", "src"), { recursive: true });
  await writeFile(join(root, "apps", "main", "src", "untracked.ts"), "export {};\n", "utf8");
  assert.equal((await readSourceIdentity(root)).dirty, true);

  await mkdir(join(root, "apps", "admin-web"), { recursive: true });
  await writeFile(join(root, "apps", "admin-web", ".env.production"), "SECRET=value\n", "utf8");
  const snapshotParent = await mkdtemp(join(tmpdir(), "opendelegate-snapshot-parent-"));
  t.after(async () => {
    await rm(snapshotParent, { force: true, recursive: true });
  });
  await git(root, ["replace", buildCommit, sourceCommit]);
  const snapshot = await createCommittedSourceSnapshot(root, buildCommit, snapshotParent);
  await git(root, ["replace", "-d", buildCommit]);
  assert.deepEqual(
    JSON.parse(
      await readFile(join(snapshot, "docs", "release", "acceptance-evidence.json"), "utf8"),
    ),
    { releaseStatus: "candidate", sourceCommit },
  );
  await assert.rejects(
    readFile(join(snapshot, "apps", "main", "src", "untracked.ts"), "utf8"),
    /ENOENT/u,
  );
  await assert.rejects(
    readFile(join(snapshot, "apps", "admin-web", ".env.production"), "utf8"),
    /ENOENT/u,
  );
  await rm(join(root, "apps"), { force: true, recursive: true });

  const missingLedger = structuredClone(ledger);
  missingLedger.sourceCommit = "f".repeat(40);
  await assert.rejects(
    inspectReleaseCandidateProvenance(root, missingLedger, {
      commit: buildCommit,
      dirty: false,
    }),
    /audited source commit A does not exist as a Git commit/u,
  );

  const sourceTree = await git(root, ["rev-parse", `${sourceCommit}^{tree}`]);
  const siblingCommit = await git(root, ["commit-tree", sourceTree, "-m", "unrelated source"]);
  const siblingLedger = structuredClone(ledger);
  siblingLedger.sourceCommit = siblingCommit;
  await assert.rejects(
    inspectReleaseCandidateProvenance(root, siblingLedger, {
      commit: buildCommit,
      dirty: false,
    }),
    /audited source commit A must be an ancestor/u,
  );
});

test("isolated bundle assembly preserves live dependency state on success and failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-isolated-source-"));
  const snapshotParent = await mkdtemp(join(tmpdir(), "opendelegate-isolated-parent-"));
  t.after(async () => {
    await Promise.all([
      rm(root, { force: true, recursive: true }),
      rm(snapshotParent, { force: true, recursive: true }),
    ]);
  });
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "user.name", "OpenDelegate test"]);
  await git(root, ["config", "user.email", "test@opendelegate.invalid"]);
  await mkdir(join(root, "tooling"));
  await writeFile(join(root, ".gitattributes"), "* text=auto eol=lf\n", "utf8");
  await writeFile(join(root, ".gitignore"), "node_modules/\n", "utf8");
  await writeFile(join(root, "package.json"), '{"name":"isolated-source"}\n', "utf8");
  await writeFile(join(root, "tooling", "build-release.mjs"), "export const tree = 'A';\n");
  await writeFile(
    join(root, "tooling", "check-release-evidence.mjs"),
    "export const tree = 'A';\n",
  );
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "isolated source"]);
  const commit = await git(root, ["rev-parse", "HEAD"]);
  const toolPaths = ["tooling/build-release.mjs", "tooling/check-release-evidence.mjs"];
  await verifyRunningReleaseToolFiles(root, commit, toolPaths);
  await writeFile(join(root, "tooling", "build-release.mjs"), "export const tree = 'B';\n");
  await writeFile(
    join(root, "tooling", "check-release-evidence.mjs"),
    "export const tree = 'B';\n",
  );
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "concurrent clean checkout"]);
  const concurrentCommit = await git(root, ["rev-parse", "HEAD"]);
  await assert.rejects(
    verifyRunningReleaseToolFiles(root, commit, toolPaths),
    /does not match captured build commit/u,
  );
  const loadedToolRoot = await createCommittedSourceSnapshot(root, commit, snapshotParent);
  await assert.rejects(
    verifyRunningReleaseToolFiles(root, concurrentCommit, toolPaths, loadedToolRoot),
    /does not match captured build commit/u,
  );
  await git(root, ["checkout", "--detach", commit]);
  await verifyRunningReleaseToolFiles(root, commit, toolPaths);

  const workspaceStatePath = join(root, "node_modules", ".pnpm-workspace-state-v1.json");
  await mkdir(join(root, "node_modules"));
  await writeFile(workspaceStatePath, '{"mode":"development"}\n', "utf8");

  let successfulSnapshot = "";
  const result = await withCommittedSourceSnapshot(
    root,
    commit,
    snapshotParent,
    async (snapshot) => {
      successfulSnapshot = snapshot;
      const isolatedStatePath = join(snapshot, "node_modules", ".pnpm-workspace-state-v1.json");
      await mkdir(join(snapshot, "node_modules"));
      await writeFile(isolatedStatePath, '{"mode":"production"}\n', "utf8");
      return "assembled";
    },
  );
  assert.equal(result, "assembled");
  assert.equal(await readFile(workspaceStatePath, "utf8"), '{"mode":"development"}\n');
  await assert.rejects(readFile(successfulSnapshot, "utf8"), { code: "ENOENT" });

  let failedSnapshot = "";
  await assert.rejects(
    withCommittedSourceSnapshot(root, commit, snapshotParent, async (snapshot) => {
      failedSnapshot = snapshot;
      await mkdir(join(snapshot, "node_modules"));
      await writeFile(
        join(snapshot, "node_modules", ".pnpm-workspace-state-v1.json"),
        '{"mode":"production"}\n',
        "utf8",
      );
      throw new Error("simulated assembly failure");
    }),
    /simulated assembly failure/u,
  );
  assert.equal(await readFile(workspaceStatePath, "utf8"), '{"mode":"development"}\n');
  await assert.rejects(readFile(failedSnapshot, "utf8"), { code: "ENOENT" });
});

test("bundle guidance is launcher-first and never presents source-checkout commands", () => {
  const readme = renderBundleReadme(
    "internal-preview-blocked",
    {
      implementation: { partial: 36 },
      liveProof: { "blocked-external": 15, "not-run": 21 },
    },
    "win32",
    "arm64",
    "0.1.0-alpha.1",
  );

  assert.match(readme, /unsupported internal preview/u);
  assert.match(readme, /win32\/arm64/u);
  assert.match(readme, /opendelegate\.cmd init/u);
  assert.match(readme, /skills\/opendelegate-init\/SKILL\.md/u);
  assert.match(readme, /Implementation: partial=36/u);
  assert.match(readme, /THIRD_PARTY_NOTICES\.json/u);
  assert.doesNotMatch(readme, /THIRD_PARTY_NOTICES\.md/u);
  assert.doesNotMatch(readme, /pnpm (?:install|check|build)/u);
  assert.doesNotMatch(readme, /CONTRIBUTING\.md/u);
});

test("assembled bundle documentation includes complete localized launcher guidance", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-bundle-readmes-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const summary = {
    implementation: { partial: 36 },
    liveProof: { "blocked-external": 15, "not-run": 21 },
  };
  const readmes = [
    {
      activeLanguage: "English",
      filename: "README.md",
      locale: "en",
      unsupported: /This bundle is unsupported and must not be published under a release tag/u,
      candidate:
        /This candidate is not a supported release until it is promoted through the documented release channel/u,
    },
    {
      activeLanguage: "한국어",
      filename: "README.ko.md",
      locale: "ko",
      unsupported: /이 번들은 지원되지 않으며 릴리스 태그로 게시해서는 안 됩니다/u,
      candidate: /이 후보는 문서화된 릴리스 채널을 통해 승격되기 전까지 지원 릴리스가 아닙니다/u,
    },
    {
      activeLanguage: "日本語",
      filename: "README.ja.md",
      locale: "ja",
      unsupported: /このバンドルはサポート対象外であり、リリースタグで公開してはいけません/u,
      candidate:
        /この候補は、文書化されたリリースチャネルを通じて昇格されるまで、サポート対象のリリースではありません/u,
    },
    {
      activeLanguage: "Français",
      filename: "README.fr.md",
      locale: "fr",
      unsupported:
        /Ce bundle n’est pas pris en charge et ne doit pas être publié sous un tag de release/u,
      candidate:
        /Ce candidat n’est pas une version prise en charge tant qu’il n’a pas été promu par le canal de publication documenté/u,
    },
    {
      activeLanguage: "Español",
      filename: "README.es.md",
      locale: "es",
      unsupported:
        /Este bundle no tiene soporte y no debe publicarse bajo una etiqueta de release/u,
      candidate:
        /Este candidato no es una versión con soporte hasta que se promocione mediante el canal de publicación documentado/u,
    },
    {
      activeLanguage: "简体中文",
      filename: "README.zh-CN.md",
      locale: "zh-CN",
      unsupported: /此捆绑包不受支持，且不得在 Release tag 下发布/u,
      candidate: /在通过文档所述的发布渠道完成提升之前，此候选版本不属于受支持的 Release/u,
    },
  ];

  await writeBundleReadmes(
    root,
    "internal-preview-blocked",
    summary,
    "win32",
    "arm64",
    "0.1.0-alpha.1",
  );
  await writeIntegrityManifests(root);

  const payload = JSON.parse(await readFile(join(root, "payload-manifest.json"), "utf8"));
  const checksums = await readFile(join(root, "SHA256SUMS"), "utf8");
  for (const readme of readmes) {
    const content = await readFile(join(root, readme.filename), "utf8");
    assert.match(
      content,
      new RegExp(
        String.raw`\*\*\[${readme.activeLanguage}\]\(${readme.filename.replaceAll(".", String.raw`\.`)}\)\*\*`,
        "u",
      ),
    );
    for (const filename of readmes.map((entry) => entry.filename)) {
      assert.match(content, new RegExp(filename.replaceAll(".", String.raw`\.`), "u"));
    }
    assert.match(content, readme.unsupported);
    assert.match(content, /Support status: `internal-preview-blocked`/u);
    assert.match(content, /opendelegate\.cmd init/u);
    assert.match(content, /skills\/opendelegate-init\/SKILL\.md/u);
    assert.match(content, /Implementation: partial=36/u);
    assert.match(content, /Live proof: blocked-external=15, not-run=21/u);
    assert.match(content, /docs\/release\/README\.md/u);
    assert.match(content, /SECURITY\.md/u);
    assert.match(content, /THIRD_PARTY_NOTICES\.json/u);
    assert.equal(
      payload.files.some((file) => file.path === readme.filename),
      true,
      `${readme.filename} is missing from payload-manifest.json`,
    );
    assert.match(
      checksums,
      new RegExp(String.raw`\s{2}${readme.filename.replaceAll(".", String.raw`\.`)}$`, "mu"),
    );

    const candidate = renderBundleReadme(
      "release-candidate",
      summary,
      "linux",
      "x64",
      "0.1.0-alpha.1",
      readme.locale,
    );
    assert.match(candidate, readme.candidate);
    assert.match(candidate, /Support status: `release-candidate`/u);
    assert.match(candidate, /\.\/opendelegate init/u);
    assert.doesNotMatch(candidate, /INTERNAL_PREVIEW\.md/u);

    const completePreview = renderBundleReadme(
      "internal-preview-complete",
      summary,
      "darwin",
      "arm64",
      "0.1.0-alpha.1",
      readme.locale,
    );
    assert.match(completePreview, readme.unsupported);
    assert.match(completePreview, /Support status: `internal-preview-complete`/u);
    assert.match(completePreview, /INTERNAL_PREVIEW\.md/u);
  }
});

test("compiled Admin assets retain their complete production dependency licenses", async () => {
  const adminManifestPath = join(repositoryRoot, "apps", "admin-web", "package.json");
  const productionPackageDirectories = await listProductionPackageDirectories(adminManifestPath);
  const productionManifests = await Promise.all(
    productionPackageDirectories.map(async (directory) =>
      JSON.parse(await readFile(join(directory, "package.json"), "utf8")),
    ),
  );
  const expectedPackages = [
    "@fontsource-variable/inter",
    "lucide-react",
    "react",
    "react-dom",
    "scheduler",
  ];
  const expectedLicenses = new Map([
    ["@fontsource-variable/inter", "OFL-1.1"],
    ["lucide-react", "ISC"],
    ["react", "MIT"],
    ["react-dom", "MIT"],
    ["scheduler", "MIT"],
  ]);
  assert.deepEqual(
    productionManifests.map((manifest) => manifest.name).sort(),
    [...expectedPackages].sort(),
  );
  for (const developmentPackage of ["vite", "vitest", "@playwright/test"]) {
    assert.equal(
      productionManifests.some((manifest) => manifest.name === developmentPackage),
      false,
    );
  }

  const staging = await mkdtemp(join(tmpdir(), "opendelegate-admin-legal-"));
  const mainDirectory = join(staging, "apps", "main");
  await mkdir(join(mainDirectory, "node_modules"), { recursive: true });
  await writeThirdPartyNotices(staging, mainDirectory);
  const inventory = JSON.parse(await readFile(join(staging, "THIRD_PARTY_NOTICES.json"), "utf8"));
  const adminPackages = inventory.packages.filter(
    (packageEntry) => packageEntry.bundledForm === "compiled-admin-asset",
  );
  assert.deepEqual(
    adminPackages.map((packageEntry) => packageEntry.name).sort(),
    [...expectedPackages].sort(),
  );

  for (const packageEntry of adminPackages) {
    assert.equal(packageEntry.packagePath, "apps/admin-web/dist");
    assert.equal(packageEntry.license, expectedLicenses.get(packageEntry.name));
    assert.notEqual(packageEntry.legalFiles.length, 0);
    for (const legalFile of packageEntry.legalFiles) {
      assert.match(legalFile.path, /^licenses\/admin-web\//u);
      const bytes = await readFile(join(staging, ...legalFile.path.split("/")));
      assert.equal(createHash("sha256").update(bytes).digest("hex"), legalFile.sha256);
    }
  }
  assert.equal(
    inventory.packages.some((packageEntry) => packageEntry.name === "vite"),
    false,
  );
  assert.equal(
    inventory.packages.some((packageEntry) => packageEntry.name === "vitest"),
    false,
  );
});

test("checksum manifests are deterministic and exclude themselves", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-checksums-"));
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "z.txt"), "z", "utf8");
  await writeFile(join(root, "ä.txt"), "umlaut", "utf8");
  await writeFile(join(root, "nested", "a.txt"), "a", "utf8");
  await writeFile(join(root, "SHA256SUMS"), "old", "utf8");

  const manifest = await createChecksumManifest(root);
  const lines = manifest.trim().split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0] ?? "", /\s{2}nested\/a\.txt$/);
  assert.match(lines[1] ?? "", /\s{2}z\.txt$/);
  assert.match(lines[2] ?? "", /\s{2}ä\.txt$/u);
  assert.doesNotMatch(manifest, /SHA256SUMS/);

  await writeFile(join(root, "result.txt"), manifest, "utf8");
  assert.equal((await readFile(join(root, "result.txt"), "utf8")).endsWith("\n"), true);

  const payload = await createPayloadManifest(root);
  assert.equal(
    payload.files.some((file) => file.path === "SHA256SUMS"),
    false,
  );
  assert.equal(
    payload.files.some((file) => file.path === "nested/a.txt"),
    true,
  );
  assert.equal(
    payload.totalBytes,
    payload.files.reduce((sum, file) => sum + file.size, 0),
  );
  const orderedExclusions = await createPayloadManifest(root, new Set(["ä.txt", "z.txt"]));
  assert.deepEqual(orderedExclusions.excludedSelfReferences, ["z.txt", "ä.txt"]);
});

test("integrity manifests can be regenerated after packaged smoke evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-integrity-pass-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(join(root, "release-metadata.json"), "{}\n", "utf8");

  await writeIntegrityManifests(root);
  const provisional = JSON.parse(await readFile(join(root, "payload-manifest.json"), "utf8"));
  assert.equal(
    provisional.files.some((file) => file.path === "smoke-evidence.json"),
    false,
  );

  await writeFile(join(root, "smoke-evidence.json"), '{"checks":"passed"}\n', "utf8");
  await writeIntegrityManifests(root);
  const finalManifest = JSON.parse(await readFile(join(root, "payload-manifest.json"), "utf8"));
  assert.equal(
    finalManifest.files.some((file) => file.path === "smoke-evidence.json"),
    true,
  );
  const checksums = await readFile(join(root, "SHA256SUMS"), "utf8");
  assert.match(checksums, /\s{2}payload-manifest\.json$/mu);
  assert.match(checksums, /\s{2}smoke-evidence\.json$/mu);
});

test("release launchers clear caller-controlled identity variables", () => {
  const windows = renderWindowsLauncher();
  const unix = renderUnixLauncher();
  const router = renderReleaseRouter();

  assert.match(windows, /set "OPENDELEGATE_BUILD_ID="/u);
  assert.match(windows, /set "OPENDELEGATE_VERSION="/u);
  assert.doesNotMatch(windows, /release-candidate|0\.1\.0/u);
  assert.match(unix, /unset OPENDELEGATE_BUILD_ID OPENDELEGATE_VERSION/u);
  assert.doesNotMatch(unix, /export OPENDELEGATE_(?:BUILD_ID|VERSION)/u);
  assert.match(windows, /apps\\launcher\\opendelegate\.mjs/u);
  assert.match(unix, /apps\/launcher\/opendelegate\.mjs/u);
  assert.match(router, /arguments_\[0\] === "worker"/u);
  assert.match(router, /apps", "worker", "opendelegate-worker\.mjs/u);
});

test("release smoke accepts only a natural zero exit with the shutdown marker", () => {
  assert.deepEqual(
    evaluateSmokeShutdown({
      stdout: '{"event":"main.stopped"}\n',
      exitCode: 0,
      signalCode: null,
      shutdownTimedOut: false,
      forcedTermination: false,
    }),
    {
      accepted: true,
      markerObserved: true,
      naturalExit: true,
      exitCode: 0,
      signal: null,
      shutdownTimedOut: false,
      forcedTermination: false,
    },
  );

  for (const rejected of [
    {
      stdout: '{"event":"main.stopped"}\n',
      exitCode: null,
      signalCode: "SIGKILL",
      shutdownTimedOut: true,
      forcedTermination: true,
    },
    {
      stdout: '{"event":"main.stopped"}\n',
      exitCode: 0,
      signalCode: null,
      shutdownTimedOut: true,
      forcedTermination: false,
    },
    {
      stdout: '{"event":"main.stopped"}\n',
      exitCode: 1,
      signalCode: null,
      shutdownTimedOut: false,
      forcedTermination: false,
    },
    {
      stdout: "",
      exitCode: 0,
      signalCode: null,
      shutdownTimedOut: false,
      forcedTermination: false,
    },
  ]) {
    const result = evaluateSmokeShutdown(rejected);
    assert.equal(result.accepted, false);
    assert.equal(result.naturalExit && result.markerObserved, false);
  }
});

test("portable release payloads reject directory symlinks or Windows junctions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-portable-tree-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const target = join(root, "target");
  await mkdir(target);
  await writeFile(join(target, "file.txt"), "target\n", "utf8");
  await symlink(target, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");

  await assert.rejects(assertPortableTree(root), /symbolic link or junction/u);
});
