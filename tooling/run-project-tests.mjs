import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalizeTemporaryEnvironment } from "./release-tooling-io.mjs";

const currentFile = fileURLToPath(import.meta.url);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

export async function isDirectProjectTestInvocation(invokedPath, modulePath = currentFile) {
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

export async function runProjectTests(dependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  const packageManagerPath = dependencies.packageManagerPath ?? process.env.npm_execpath;
  if (
    typeof packageManagerPath !== "string" ||
    !isAbsolute(packageManagerPath) ||
    packageManagerPath.includes("\0")
  ) {
    throw new Error("The project test runner requires the absolute package-manager entrypoint.");
  }
  const temporary = await canonicalizeTemporaryEnvironment(
    dependencies.environment ?? process.env,
    {
      ...dependencies,
      platform,
      temporaryDirectory:
        dependencies.temporaryDirectory ?? (platform === "darwin" ? () => "/tmp" : undefined),
    },
  );
  const executable = dependencies.executablePath ?? process.execPath;
  const commands = [
    [packageManagerPath, "run", "test:tooling"],
    ...(platform === "win32"
      ? [
          [
            packageManagerPath,
            "--recursive",
            "--filter",
            "!@opendelegate/main",
            "--workspace-concurrency=2",
            "--if-present",
            "run",
            "test",
          ],
          [packageManagerPath, "--filter", "@opendelegate/main", "run", "test:serial"],
        ]
      : [[packageManagerPath, "--recursive", "--if-present", "run", "test"]]),
  ];
  for (const arguments_ of commands) {
    const exitCode = await runChild(executable, arguments_, {
      dependencies,
      environment: temporary.environment,
    });
    if (exitCode !== 0) {
      return exitCode;
    }
  }
  return 0;
}

function runChild(executable, arguments_, { dependencies, environment }) {
  const child = (dependencies.spawnChild ?? spawn)(executable, arguments_, {
    cwd: dependencies.repositoryRoot ?? repositoryRoot,
    env: environment,
    stdio: "inherit",
    windowsHide: true,
  });
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`The project test runner exited from signal ${signal}.`));
        return;
      }
      resolvePromise(code ?? 1);
    });
  });
}

if (await isDirectProjectTestInvocation(process.argv[1])) {
  try {
    process.exitCode = await runProjectTests();
  } catch (error) {
    const message = error instanceof Error ? error.message : "The project test runner failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
