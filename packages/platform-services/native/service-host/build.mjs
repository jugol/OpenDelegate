import { execFile } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const checkoutDirectory = resolve(scriptDirectory, "..", "..", "..", "..");

export async function buildNativeServiceHosts(options = {}) {
  const platform = options.hostPlatform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  if (!["win32", "darwin", "linux"].includes(platform)) {
    throw new Error("The native service host platform is unsupported.");
  }
  if (!["arm64", "x64"].includes(architecture) || architecture !== process.arch) {
    throw new Error("Native service hosts must be built for the current host architecture.");
  }
  if (platform !== process.platform) {
    throw new Error("Native service hosts require a target-native build host.");
  }
  const outputRoot =
    options.outputRoot ?? (await mkdtemp(join(tmpdir(), "opendelegate-service-host-build-")));
  await validateExternalOutputRoot(outputRoot);
  await mkdir(outputRoot, { recursive: true });

  let coreExecutable;
  let helperExecutable;
  if (platform === "win32") {
    const msbuild = options.msbuildPath ?? (await locateMsBuild());
    const msbuildArchitecture = architecture === "arm64" ? "ARM64" : "x64";
    await execFileAsync(
      msbuild,
      [
        join(scriptDirectory, "OpenDelegate.ServiceHost.vcxproj"),
        "/m",
        "/p:Configuration=Release",
        `/p:Platform=${msbuildArchitecture}`,
        `/p:OpenDelegateOutputRoot=${outputRoot}`,
        "/v:minimal",
        "/nologo",
      ],
      {
        cwd: scriptDirectory,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: 10 * 60 * 1000,
        windowsHide: true,
      },
    );
    const directory = join(outputRoot, "Release", msbuildArchitecture);
    coreExecutable = join(directory, "opendelegate-service-host.exe");
    helperExecutable = join(directory, "opendelegate-session-helper.exe");
    await copyFile(coreExecutable, helperExecutable);
  } else {
    const directory = join(outputRoot, "Release", architecture);
    await mkdir(directory, { recursive: true, mode: 0o755 });
    coreExecutable = join(directory, "opendelegate-service-host");
    helperExecutable = join(directory, "opendelegate-session-helper");
    const compiler =
      options.compilerPath ?? (platform === "darwin" ? "/usr/bin/xcrun" : "/usr/bin/cc");
    const arguments_ =
      platform === "darwin"
        ? [
            "clang",
            "-std=c17",
            "-O2",
            "-Wall",
            "-Wextra",
            "-Werror",
            join(scriptDirectory, "posix-launcher.c"),
            "-lbsm",
            "-o",
            coreExecutable,
          ]
        : [
            "-std=c17",
            "-O2",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-fPIE",
            "-pie",
            join(scriptDirectory, "posix-launcher.c"),
            "-o",
            coreExecutable,
          ];
    await execFileAsync(compiler, arguments_, {
      cwd: scriptDirectory,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      timeout: 120_000,
    });
    await copyFile(coreExecutable, helperExecutable);
  }
  await Promise.all([access(coreExecutable), access(helperExecutable)]);
  for (const executable of [coreExecutable, helperExecutable]) {
    const result = await execFileAsync(executable, ["--self-test"], {
      cwd: dirname(executable),
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      timeout: 10_000,
      windowsHide: true,
    });
    if (result.stdout.trim() !== "OpenDelegate native service launcher 1") {
      throw new Error("The native service launcher self-test failed.");
    }
  }
  return Object.freeze({ platform, architecture, coreExecutable, helperExecutable });
}

async function validateExternalOutputRoot(outputRoot) {
  if (typeof outputRoot !== "string" || !isAbsolute(outputRoot) || outputRoot.includes("\0")) {
    throw new Error("The native service build output root must be an absolute path.");
  }
  const [physicalCheckout, physicalOutput] = await Promise.all([
    realpath(checkoutDirectory),
    resolvePhysicalCandidate(outputRoot),
  ]);
  const relationship = relative(physicalCheckout, physicalOutput);
  if (relationship === "" || (!relationship.startsWith("..") && !isAbsolute(relationship))) {
    throw new Error("Native service build output must remain outside the source checkout.");
  }
}

async function resolvePhysicalCandidate(candidate) {
  let existing = resolve(candidate);
  const missing = [];
  for (;;) {
    try {
      return resolve(await realpath(existing), ...missing.reverse());
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
      const parent = dirname(existing);
      if (parent === existing) {
        throw error;
      }
      missing.push(existing.slice(parent.length + 1));
      existing = parent;
    }
  }
}

async function locateMsBuild() {
  const vswhere = String.raw`C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe`;
  await access(vswhere);
  const { stdout } = await execFileAsync(
    vswhere,
    [
      "-latest",
      "-products",
      "*",
      "-requires",
      "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
      "-property",
      "installationPath",
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024, timeout: 10_000, windowsHide: true },
  );
  const path = join(stdout.trim(), "MSBuild", "Current", "Bin", "MSBuild.exe");
  await access(path);
  return path;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildNativeServiceHosts()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : "Native service host build failed."}\n`,
      );
      process.exitCode = 1;
    });
}
