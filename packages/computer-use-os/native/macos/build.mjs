import { execFile } from "node:child_process";
import { access, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const checkoutDirectory = resolve(scriptDirectory, "..", "..", "..", "..");
const supportedArchitectures = new Set(["arm64", "x64"]);

export async function buildMacOsComputerUseNative(options = {}) {
  if ((options.hostPlatform ?? process.platform) !== "darwin") {
    throw new Error("The macOS native Computer Use helper can only be built on macOS.");
  }
  const architecture = options.architecture ?? process.arch;
  if (!supportedArchitectures.has(architecture) || architecture !== process.arch) {
    throw new Error(
      "The macOS native Computer Use build must match the current host architecture.",
    );
  }
  const outputRoot = await validateExternalOutputRoot(options.outputRoot);
  await mkdir(outputRoot, { recursive: true });
  const scratchPath = join(outputRoot, ".swift-build");
  const xcrunPath = options.xcrunPath ?? "/usr/bin/xcrun";
  const common = [
    "swift",
    "build",
    "--package-path",
    scriptDirectory,
    "--scratch-path",
    scratchPath,
    "--configuration",
    "release",
    "--arch",
    architecture,
  ];
  for (const product of ["opendelegate-macos-computer-use", "opendelegate-computer-use-fixture"]) {
    await execFileAsync(xcrunPath, [...common, "--product", product], {
      cwd: scriptDirectory,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
    });
  }
  const { stdout } = await execFileAsync(xcrunPath, [...common, "--show-bin-path"], {
    cwd: scriptDirectory,
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    timeout: 30_000,
  });
  const binaryDirectory = resolve(stdout.trim());
  const helperExecutable = join(binaryDirectory, "opendelegate-macos-computer-use");
  const fixtureExecutable = join(binaryDirectory, "opendelegate-computer-use-fixture");
  await Promise.all([access(helperExecutable), access(fixtureExecutable)]);
  return Object.freeze({
    architecture,
    outputRoot,
    helperExecutable,
    fixtureExecutable,
  });
}

async function validateExternalOutputRoot(value) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    throw new Error("The macOS native build output root must be an absolute path.");
  }
  const [physicalCheckout, physicalOutput] = await Promise.all([
    realpath(checkoutDirectory),
    resolvePhysicalCandidate(value),
  ]);
  const relationship = relative(physicalCheckout, physicalOutput);
  if (relationship === "" || (!relationship.startsWith("..") && !isAbsolute(relationship))) {
    throw new Error("macOS native build output must remain outside the source checkout.");
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
  buildMacOsComputerUseNative()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : "macOS native build failed."}\n`,
      );
      process.exitCode = 1;
    });
}
