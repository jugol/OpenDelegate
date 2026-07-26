import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const checkoutDirectory = resolve(scriptDirectory, "..", "..", "..", "..");
const helperSource = join(scriptDirectory, "opendelegate_linux_computer_use_helper.py");
const fixtureSource = join(scriptDirectory, "opendelegate_linux_computer_use_fixture.py");

export async function stageLinuxComputerUseNative(options = {}) {
  if ((options.hostPlatform ?? process.platform) !== "linux") {
    throw new Error("The Linux native Computer Use payload can only be staged on Linux.");
  }
  const outputRoot = validateExternalOutputRoot(options.outputRoot);
  const python = options.pythonExecutable ?? "/usr/bin/python3";
  if (!isAbsolute(python)) {
    throw new Error("The Python executable must be an absolute path.");
  }
  await assertRegularSource(helperSource);
  await assertRegularSource(fixtureSource);
  const cacheRoot = join(outputRoot, ".python-cache");
  const binRoot = join(outputRoot, "libexec");
  const helperExecutable = join(binRoot, "opendelegate-linux-computer-use");
  const fixtureExecutable = join(binRoot, "opendelegate-linux-computer-use-fixture");
  await mkdir(binRoot, { recursive: true, mode: 0o755 });
  try {
    await execFileAsync(python, ["-m", "py_compile", helperSource, fixtureSource], {
      encoding: "utf8",
      env: { PYTHONPYCACHEPREFIX: cacheRoot },
      maxBuffer: 64 * 1024,
      timeout: 30_000,
    });
    await Promise.all([
      copyFile(helperSource, helperExecutable),
      copyFile(fixtureSource, fixtureExecutable),
    ]);
    await Promise.all([chmod(helperExecutable, 0o755), chmod(fixtureExecutable, 0o755)]);
    return Object.freeze({
      helperExecutable,
      helperSha256: await sha256File(helperExecutable),
      fixtureExecutable,
      fixtureSha256: await sha256File(fixtureExecutable),
    });
  } finally {
    await rm(cacheRoot, { force: true, recursive: true });
  }
}

function validateExternalOutputRoot(value) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    throw new Error("Linux native stage output must be an absolute path.");
  }
  const output = resolve(value);
  const relationship = relative(checkoutDirectory, output);
  if (relationship === "" || (!relationship.startsWith("..") && !isAbsolute(relationship))) {
    throw new Error("Linux native stage output must remain outside the source checkout.");
  }
  return output;
}

async function assertRegularSource(path) {
  const [canonical, metadata] = await Promise.all([realpath(path), lstat(path)]);
  if (canonical !== path || !metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("The Linux native source payload is unsafe.");
  }
}

async function sha256File(path) {
  const bytes = await readFile(path);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  const outputIndex = process.argv.indexOf("--output-root");
  const outputRoot = outputIndex < 0 ? undefined : process.argv[outputIndex + 1];
  stageLinuxComputerUseNative({ outputRoot })
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : "Linux native staging failed."}\n`,
      );
      process.exitCode = 1;
    });
}
