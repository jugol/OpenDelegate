import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const supportedPlatforms = new Set(["darwin", "linux", "win32"]);
const supportedArchitectures = new Set(["arm64", "x64"]);

export async function stageNativeReleaseAssets(options) {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  if (!supportedPlatforms.has(platform) || !supportedArchitectures.has(architecture)) {
    throw new Error(`Native release assets are unsupported for ${platform}/${architecture}.`);
  }
  const sourceRoot = requireAbsolutePath(options.sourceRoot, "source root");
  const stagingRoot = requireAbsolutePath(options.stagingRoot, "staging root");
  assertOutside(sourceRoot, stagingRoot, "Native release staging");
  const builders = options.builders ?? {};
  const buildRoot = await mkdtemp(join(dirname(stagingRoot), ".od-native-build-"));
  try {
    const components =
      platform === "win32"
        ? await stageWindows({
            architecture,
            buildRoot,
            builders,
            platform,
            sourceRoot,
            stagingRoot,
          })
        : platform === "darwin"
          ? await stageMacOs({
              architecture,
              buildRoot,
              builders,
              platform,
              sourceRoot,
              stagingRoot,
            })
          : await stageLinux({
              architecture,
              buildRoot,
              builders,
              platform,
              sourceRoot,
              stagingRoot,
            });
    const result = Object.freeze({
      schemaVersion: 1,
      platform,
      architecture,
      components: Object.freeze(components),
    });
    await writeFile(
      join(stagingRoot, "native-components.json"),
      `${JSON.stringify(result, null, 2)}\n`,
      "utf8",
    );
    return result;
  } finally {
    await rm(buildRoot, { force: true, recursive: true });
  }
}

async function stageWindows(input) {
  const computerUseBuilder =
    input.builders.windows ??
    (await importSourceBuilder(
      input.sourceRoot,
      "packages/computer-use-os/native/windows/build.mjs",
      "buildWindowsComputerUseNative",
    ));
  const serviceHostBuilder =
    input.builders.serviceHost ??
    (await importSourceBuilder(
      input.sourceRoot,
      "packages/platform-services/native/service-host/build.mjs",
      "buildNativeServiceHosts",
    ));
  const [result, serviceHosts] = await Promise.all([
    computerUseBuilder({
      architecture: input.architecture === "arm64" ? "ARM64" : "x64",
      outputRoot: join(input.buildRoot, "computer-use"),
    }),
    serviceHostBuilder({
      architecture: input.architecture,
      hostPlatform: "win32",
      outputRoot: join(input.buildRoot, "service-host"),
    }),
  ]);
  return await copyComponents(input, [
    {
      kind: "core-service-host",
      source: serviceHosts.coreExecutable,
      path: "bin/opendelegate-service-host.exe",
    },
    {
      kind: "session-helper-host",
      source: serviceHosts.helperExecutable,
      path: "bin/opendelegate-session-helper.exe",
    },
    {
      kind: "computer-use-helper",
      source: result.helperExecutable,
      path: "libexec/opendelegate-windows-computer-use-helper.exe",
    },
    {
      kind: "computer-use-fixture",
      source: result.fixtureExecutable,
      path: "libexec/opendelegate-windows-computer-use-fixture.exe",
    },
  ]);
}

async function stageLinux(input) {
  const builder =
    input.builders.linux ??
    (await importSourceBuilder(
      input.sourceRoot,
      "packages/computer-use-os/native/linux/stage.mjs",
      "stageLinuxComputerUseNative",
    ));
  const serviceHostBuilder =
    input.builders.serviceHost ??
    (await importSourceBuilder(
      input.sourceRoot,
      "packages/platform-services/native/service-host/build.mjs",
      "buildNativeServiceHosts",
    ));
  const [result, serviceHosts] = await Promise.all([
    builder({
      hostPlatform: "linux",
      outputRoot: join(input.buildRoot, "computer-use"),
    }),
    serviceHostBuilder({
      architecture: input.architecture,
      hostPlatform: "linux",
      outputRoot: join(input.buildRoot, "service-host"),
    }),
  ]);
  return await copyComponents(input, [
    {
      kind: "core-service-host",
      source: serviceHosts.coreExecutable,
      path: "bin/opendelegate-service-host",
    },
    {
      kind: "session-helper-host",
      source: serviceHosts.helperExecutable,
      path: "bin/opendelegate-session-helper",
    },
    {
      kind: "computer-use-helper",
      source: result.helperExecutable,
      path: "libexec/opendelegate-linux-computer-use",
    },
    {
      kind: "computer-use-fixture",
      source: result.fixtureExecutable,
      path: "libexec/opendelegate-linux-computer-use-fixture",
    },
  ]);
}

async function stageMacOs(input) {
  const computerUseBuilder =
    input.builders.macosComputerUse ??
    (await importSourceBuilder(
      input.sourceRoot,
      "packages/computer-use-os/native/macos/build.mjs",
      "buildMacOsComputerUseNative",
    ));
  const keychainBuilder =
    input.builders.macosKeychain ??
    (await importSourceBuilder(
      input.sourceRoot,
      "packages/secrets/native/macos/build.mjs",
      "buildMacOsKeychainHelper",
    ));
  const serviceHostBuilder =
    input.builders.serviceHost ??
    (await importSourceBuilder(
      input.sourceRoot,
      "packages/platform-services/native/service-host/build.mjs",
      "buildNativeServiceHosts",
    ));
  const [computerUse, keychain, serviceHosts] = await Promise.all([
    computerUseBuilder({
      architecture: input.architecture,
      outputRoot: join(input.buildRoot, "computer-use"),
    }),
    keychainBuilder({
      architecture: input.architecture,
      outputRoot: join(input.buildRoot, "keychain"),
    }),
    serviceHostBuilder({
      architecture: input.architecture,
      hostPlatform: "darwin",
      outputRoot: join(input.buildRoot, "service-host"),
    }),
  ]);
  return await copyComponents(input, [
    {
      kind: "core-service-host",
      source: serviceHosts.coreExecutable,
      path: "bin/opendelegate-service-host",
    },
    {
      kind: "session-helper-host",
      source: serviceHosts.helperExecutable,
      path: "bin/opendelegate-session-helper",
    },
    {
      kind: "computer-use-helper",
      source: computerUse.helperExecutable,
      path: "libexec/opendelegate-macos-computer-use",
    },
    {
      kind: "computer-use-fixture",
      source: computerUse.fixtureExecutable,
      path: "libexec/opendelegate-macos-computer-use-fixture",
    },
    {
      kind: "secret-store-helper",
      source: keychain.helperExecutable,
      path: "runtime/native/opendelegate-keychain-helper",
    },
  ]);
}

async function copyComponents(input, entries) {
  return await Promise.all(
    entries.map(async (entry) => {
      const source = await requireSafeBuildOutput(entry.source, input.buildRoot);
      const bytes = await readFile(source);
      await assertNoBuildPathDisclosure(bytes, [input.buildRoot, input.sourceRoot], input.platform);
      const destination = join(input.stagingRoot, ...entry.path.split("/"));
      await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
      await writeFile(destination, bytes, { mode: 0o755 });
      if (process.platform !== "win32") {
        await chmod(destination, 0o755);
      }
      const stagedBytes = await readFile(destination);
      if (!stagedBytes.equals(bytes)) {
        throw new Error("A staged native release component changed while it was being verified.");
      }
      return Object.freeze({
        kind: entry.kind,
        path: entry.path,
        sha256: `sha256:${createHash("sha256").update(stagedBytes).digest("hex")}`,
      });
    }),
  );
}

async function assertNoBuildPathDisclosure(bytes, roots, platform) {
  const privatePathSpellings = new Set();
  for (const root of roots) {
    for (const canonical of new Set([resolve(root), await realpath(root)])) {
      for (const spelling of pathSpellings(canonical, platform)) {
        privatePathSpellings.add(spelling);
      }
    }
  }
  const comparableBytes = platform === "win32" ? foldAsciiCase(bytes) : bytes;
  for (const value of privatePathSpellings) {
    for (const encoding of ["utf8", "utf16le"]) {
      const encoded = Buffer.from(value, encoding);
      const comparable = platform === "win32" ? foldAsciiCase(encoded) : encoded;
      if (comparableBytes.indexOf(comparable) !== -1) {
        throw new Error("A native release component contains a private build-host path.");
      }
    }
  }
}

function pathSpellings(value, platform) {
  const spellings = new Set([value]);
  if (platform === "win32") {
    const windowsPath = value.replaceAll("/", "\\");
    spellings.add(windowsPath);
    if (/^[a-z]:\\/iu.test(windowsPath)) {
      spellings.add(`\\\\?\\${windowsPath}`);
    } else if (windowsPath.startsWith("\\\\") && !windowsPath.startsWith("\\\\?\\")) {
      spellings.add(`\\\\?\\UNC\\${windowsPath.slice(2)}`);
    }
  }
  for (const spelling of [...spellings]) {
    spellings.add(spelling.replaceAll("\\", "/"));
    spellings.add(spelling.replaceAll("/", "\\"));
  }
  return spellings;
}

function foldAsciiCase(value) {
  const folded = Buffer.from(value);
  for (let index = 0; index < folded.length; index += 1) {
    if (folded[index] >= 0x41 && folded[index] <= 0x5a) {
      folded[index] += 0x20;
    }
  }
  return folded;
}

async function requireSafeBuildOutput(value, buildRoot) {
  const path = requireAbsolutePath(value, "native build output");
  const [canonicalRoot, canonicalPath, metadata] = await Promise.all([
    realpath(buildRoot),
    realpath(path),
    lstat(path),
  ]);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    !isStrictDescendant(canonicalRoot, canonicalPath)
  ) {
    throw new Error("A native build output escaped its isolated build root.");
  }
  return canonicalPath;
}

async function importSourceBuilder(sourceRoot, relativePath, exportName) {
  const modulePath = join(sourceRoot, ...relativePath.split("/"));
  const canonicalSource = await realpath(sourceRoot);
  const canonicalModule = await realpath(modulePath);
  if (!isStrictDescendant(canonicalSource, canonicalModule)) {
    throw new Error("A native builder escaped the committed source snapshot.");
  }
  const module = await import(pathToFileURL(canonicalModule).href);
  const builder = module[exportName];
  if (typeof builder !== "function") {
    throw new Error(`Native builder ${exportName} is unavailable.`);
  }
  return builder;
}

function requireAbsolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    throw new Error(`The native release ${label} must be an absolute path.`);
  }
  return resolve(value);
}

function assertOutside(parent, candidate, label) {
  const relationship = relative(resolve(parent), resolve(candidate));
  if (
    relationship === "" ||
    (!isAbsolute(relationship) && relationship !== ".." && !relationship.startsWith(`..${sep}`))
  ) {
    throw new Error(`${label} must remain outside the source checkout.`);
  }
}

function isStrictDescendant(parent, candidate) {
  const relationship = relative(resolve(parent), resolve(candidate));
  return (
    relationship !== "" &&
    !isAbsolute(relationship) &&
    relationship !== ".." &&
    !relationship.startsWith(`..${sep}`)
  );
}
