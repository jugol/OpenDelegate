import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { canonicalizeTemporaryEnvironment } from "./release-tooling-io.mjs";

const currentFile = fileURLToPath(import.meta.url);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

export async function isDirectToolingTestInvocation(invokedPath, modulePath = currentFile) {
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

export async function runToolingTests(dependencies = {}) {
  const temporary = await canonicalizeTemporaryEnvironment(
    dependencies.environment ?? process.env,
    dependencies,
  );
  const child = (dependencies.spawnChild ?? spawn)(
    dependencies.executablePath ?? process.execPath,
    ["--experimental-strip-types", "--test", "tooling/test/*.test.mjs"],
    {
      cwd: dependencies.repositoryRoot ?? repositoryRoot,
      env: temporary.environment,
      stdio: "inherit",
      windowsHide: true,
    },
  );

  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`The tooling test runner exited from signal ${signal}.`));
        return;
      }
      resolvePromise(code ?? 1);
    });
  });
}

if (await isDirectToolingTestInvocation(process.argv[1])) {
  try {
    process.exitCode = await runToolingTests();
  } catch (error) {
    const message = error instanceof Error ? error.message : "The tooling test runner failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
