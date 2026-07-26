import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const checkoutDirectory = resolve(scriptDirectory, "..", "..", "..", "..");
const allowedArchitectures = new Set(["ARM64", "x64"]);

export async function buildWindowsComputerUseNative(options = {}) {
  if (process.platform !== "win32") {
    throw new Error("The Windows native Computer Use helper can only be built on Windows.");
  }
  const architecture = options.architecture ?? (process.arch === "arm64" ? "ARM64" : "x64");
  if (!allowedArchitectures.has(architecture)) {
    throw new Error("The Windows native Computer Use architecture is unsupported.");
  }
  const outputRoot =
    options.outputRoot ?? (await mkdtemp(join(tmpdir(), "opendelegate-windows-cu-build-")));
  await validateExternalOutputRoot(outputRoot);
  await mkdir(outputRoot, { recursive: true });
  const msbuild = options.msbuildPath ?? (await locateMsBuild());
  const projects = [
    "OpenDelegate.WindowsComputerUseHelper.vcxproj",
    "OpenDelegate.WindowsComputerUseFixture.vcxproj",
  ];
  for (const project of projects) {
    await execFileAsync(
      msbuild,
      [
        join(scriptDirectory, project),
        "/m",
        "/p:Configuration=Release",
        `/p:Platform=${architecture}`,
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
  }
  const outputDirectory = join(outputRoot, "Release", architecture);
  const helperExecutable = join(outputDirectory, "opendelegate-windows-computer-use-helper.exe");
  const fixtureExecutable = join(outputDirectory, "opendelegate-windows-computer-use-fixture.exe");
  await Promise.all([access(helperExecutable), access(fixtureExecutable)]);
  await execFileAsync(helperExecutable, ["crypto-self-test"], {
    cwd: outputDirectory,
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    timeout: 10_000,
    windowsHide: true,
  });
  await execFileAsync(helperExecutable, ["parent-auth-self-test"], {
    cwd: outputDirectory,
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    timeout: 10_000,
    windowsHide: true,
  });
  const configurationArguments = [
    "serve",
    "--pipe",
    String.raw`\\.\pipe\OpenDelegate\native-build-auth-self-test`,
    "--device-id",
    "device-native-build-self-test",
    "--helper-instance-id",
    "helper-native-build-self-test",
    "--service-epoch",
    "1",
    "--session-identity",
    "windows:native-build-self-test",
    "--release-version",
    "0.0.0-self-test",
    "--capture-mode",
    "picker",
    "--secret-descriptor",
    "3",
  ];
  await expectExitCode(helperExecutable, configurationArguments, 64, outputDirectory);
  await expectExitCode(
    helperExecutable,
    [
      ...configurationArguments,
      "--parent-process-id",
      String(process.pid),
      "--lab-allow-owner-client",
    ],
    64,
    outputDirectory,
  );
  await expectSpawnExitCode(
    helperExecutable,
    [...configurationArguments, "--parent-process-id", String(process.pid)],
    65,
    outputDirectory,
  );
  return Object.freeze({
    architecture,
    outputRoot,
    outputDirectory,
    helperExecutable,
    fixtureExecutable,
  });
}

async function expectSpawnExitCode(executable, arguments_, expectedExitCode, cwd) {
  const child = spawn(executable, arguments_, {
    cwd,
    stdio: ["ignore", "ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdio[3]?.end();
  const stderr = [];
  let stderrBytes = 0;
  child.stderr?.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes <= 64 * 1024) {
      stderr.push(chunk);
    }
  });
  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("The Windows native helper authentication self-test timed out."));
    }, 10_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  for (const chunk of stderr) {
    chunk.fill(0);
  }
  if (exitCode !== expectedExitCode) {
    throw new Error("The Windows native helper authentication contract self-test failed.");
  }
}

async function expectExitCode(executable, arguments_, expectedExitCode, cwd) {
  try {
    await execFileAsync(executable, arguments_, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      timeout: 10_000,
      windowsHide: true,
    });
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === expectedExitCode) {
      return;
    }
    throw new Error("The Windows native helper authentication contract self-test failed.", {
      cause: error,
    });
  }
  throw new Error("The Windows native helper unexpectedly accepted an unsafe configuration.");
}

async function validateExternalOutputRoot(outputRoot) {
  if (typeof outputRoot !== "string" || !isAbsolute(outputRoot)) {
    throw new Error("The Windows native build output root must be an absolute path.");
  }
  const [physicalCheckout, physicalOutputRoot] = await Promise.all([
    realpath(checkoutDirectory),
    resolvePhysicalCandidate(outputRoot),
  ]);
  const relativePath = relative(physicalCheckout, physicalOutputRoot);
  if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
    throw new Error("Windows native build output must remain outside the source checkout.");
  }
}

async function resolvePhysicalCandidate(candidate) {
  let existingAncestor = resolve(candidate);
  const missingSegments = [];
  for (;;) {
    try {
      const physicalAncestor = await realpath(existingAncestor);
      return resolve(physicalAncestor, ...missingSegments.reverse());
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

async function locateMsBuild() {
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  const vswhereCandidates = [
    programFilesX86 === undefined
      ? undefined
      : join(programFilesX86, "Microsoft Visual Studio", "Installer", "vswhere.exe"),
    String.raw`C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe`,
  ].filter((value) => value !== undefined);
  for (const vswhere of vswhereCandidates) {
    try {
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
        {
          encoding: "utf8",
          maxBuffer: 64 * 1024,
          timeout: 10_000,
          windowsHide: true,
        },
      );
      const installationPath = stdout.trim();
      if (installationPath !== "") {
        const candidate = resolve(installationPath, "MSBuild", "Current", "Bin", "MSBuild.exe");
        await access(candidate);
        return candidate;
      }
    } catch {
      // Continue to the next fixed, local discovery route.
    }
  }
  throw new Error(
    "Visual Studio Build Tools with the Desktop development with C++ workload is required.",
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildWindowsComputerUseNative()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    })
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : "Windows native build failed."}\n`,
      );
      process.exitCode = 1;
    });
}
