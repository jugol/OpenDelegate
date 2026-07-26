import { execFile } from "node:child_process";
import { access, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const checkoutDirectory = resolve(scriptDirectory, "..", "..", "..", "..");
const source = join(scriptDirectory, "opendelegate-keychain-helper.swift");
const supportedArchitectures = new Set(["arm64", "x64"]);

export async function buildMacOsKeychainHelper(options = {}) {
  if ((options.hostPlatform ?? process.platform) !== "darwin") {
    throw new Error("The macOS Keychain helper can only be built on macOS.");
  }
  const architecture = options.architecture ?? process.arch;
  if (!supportedArchitectures.has(architecture) || architecture !== process.arch) {
    throw new Error("The macOS Keychain helper build must match the current host architecture.");
  }
  const outputRoot = await validateExternalOutputRoot(options.outputRoot);
  await mkdir(outputRoot, { recursive: true });
  const helperExecutable = join(outputRoot, "opendelegate-keychain-helper");
  await execFileAsync(
    options.xcrunPath ?? "/usr/bin/xcrun",
    [
      "swiftc",
      "-O",
      "-target",
      `${architecture}-apple-macos14.0`,
      "-framework",
      "Security",
      ...createMacOsSwiftPathRemappingArguments(checkoutDirectory, outputRoot),
      "-o",
      helperExecutable,
      source,
    ],
    {
      cwd: scriptDirectory,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 5 * 60 * 1000,
    },
  );
  await access(helperExecutable);
  return Object.freeze({ architecture, outputRoot, helperExecutable });
}

export function createMacOsSwiftPathRemappingArguments(sourceRoot, buildRoot) {
  return Object.freeze([
    "-file-prefix-map",
    `${requireAbsoluteMappingRoot(sourceRoot)}=/opendelegate/source`,
    "-file-prefix-map",
    `${requireAbsoluteMappingRoot(buildRoot)}=/opendelegate/build`,
    "-prefix-serialized-debugging-options",
    "-file-compilation-dir",
    "/opendelegate/source",
  ]);
}

function requireAbsoluteMappingRoot(value) {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    value.includes("\0") ||
    value.includes("=")
  ) {
    throw new Error("macOS Swift path remapping requires unambiguous absolute paths.");
  }
  return resolve(value);
}

async function validateExternalOutputRoot(value) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    throw new Error("The macOS Keychain build output root must be an absolute path.");
  }
  const [physicalCheckout, physicalOutput] = await Promise.all([
    realpath(checkoutDirectory),
    resolvePhysicalCandidate(value),
  ]);
  const relationship = relative(physicalCheckout, physicalOutput);
  if (relationship === "" || (!relationship.startsWith("..") && !isAbsolute(relationship))) {
    throw new Error("macOS Keychain build output must remain outside the source checkout.");
  }
  return physicalOutput;
}

async function resolvePhysicalCandidate(candidate) {
  let existingAncestor = resolve(candidate);
  const missingSegments = [];
  for (;;) {
    try {
      return resolve(await realpath(existingAncestor), ...missingSegments.reverse());
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) {
        throw error;
      }
      missingSegments.push(existingAncestor.slice(parent.length + 1));
      existingAncestor = parent;
    }
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildMacOsKeychainHelper()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : "macOS Keychain build failed."}\n`,
      );
      process.exitCode = 1;
    });
}
