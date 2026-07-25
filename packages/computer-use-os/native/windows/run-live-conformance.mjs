import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  createWindowsNamedPipeAuthenticatedHelperPort,
  createWindowsNativeComputerUseDriver,
  runNativeDriverConformanceLab,
} from "../../src/index.ts";
import { buildWindowsComputerUseNative } from "./build.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(scriptDirectory, "..", "..");
const checkoutDirectory = resolve(packageDirectory, "..", "..");
const execFileAsync = promisify(execFile);

async function main() {
  if (process.platform !== "win32") {
    throw new Error("The Windows native conformance command requires a real Windows host.");
  }
  const options = parseArguments(process.argv.slice(2));
  await validateEvidenceDirectory(options.evidenceDirectory);
  const runId = randomUUID();
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "opendelegate-windows-cu-"));
  const resultFile = join(temporaryDirectory, "fixture-result.json");
  const fixtureTitle = `OpenDelegate Computer Use Fixture - ${runId}`;
  const pipePath = String.raw`\\.\pipe\OpenDelegate\computer-use-lab-${runId}`;
  const ipcSecret = options.useOwnerPicker
    ? randomBytes(32)
    : Buffer.from(Array.from({ length: 32 }, (_value, index) => index + 1));
  const helperInstanceId = "helper-1";
  const serviceEpoch = 7;
  const sessionIdentity = options.useOwnerPicker
    ? `windows-session:${process.pid}:local-lab-binding`
    : "windows-session:known-vector";
  let fixture;
  let helper;
  let completion;
  try {
    const binaries = await buildWindowsComputerUseNative({
      outputRoot: join(temporaryDirectory, "native-build"),
    });
    fixture = spawn(binaries.fixtureExecutable, ["--run-id", runId, "--result-file", resultFile], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: false,
    });
    const fixtureErrors = boundedOutput(fixture.stderr, 16 * 1024);
    await wait(750);
    requireRunning(fixture, "The deterministic Windows fixture did not start.");

    helper = spawn(
      binaries.helperExecutable,
      [
        "serve",
        "--pipe",
        pipePath,
        "--device-id",
        "device-native-driver-conformance",
        "--helper-instance-id",
        helperInstanceId,
        "--service-epoch",
        String(serviceEpoch),
        "--session-identity",
        sessionIdentity,
        "--release-version",
        "0.1.0-alpha.1",
        "--capture-mode",
        options.useOwnerPicker ? "picker" : "fixture-window",
        "--fixture-window-title",
        fixtureTitle,
        "--fixture-result-file",
        resultFile,
        "--secret-descriptor",
        "3",
        "--parent-process-id",
        String(process.pid),
        ...(options.useOwnerPicker ? [] : ["--lab-fixture-capture", "--lab-known-secret-vector"]),
      ],
      {
        stdio: ["ignore", "ignore", "pipe", "pipe"],
        windowsHide: false,
      },
    );
    const helperErrors = boundedOutput(helper.stderr, 16 * 1024);
    const secretPipe = helper.stdio[3];
    if (secretPipe === null || typeof secretPipe.write !== "function") {
      throw new Error("The native helper Secret bootstrap pipe was not created.");
    }
    secretPipe.write(ipcSecret);
    secretPipe.end();

    const port = createWindowsNamedPipeAuthenticatedHelperPort({
      pipePath,
      deviceId: "device-native-driver-conformance",
      secretReference: "secret://windows-computer-use-lab/ipc",
      secrets: {
        async resolve() {
          // Buffer.slice() aliases the original allocation. The authenticated
          // port deliberately zeroes every resolved Secret, so return an
          // independent disposable copy for each readiness retry.
          return Buffer.from(ipcSecret);
        },
      },
      timeoutMs: 15_000,
      ...(options.useOwnerPicker
        ? {}
        : {
            nonceSource: () =>
              Buffer.from(Array.from({ length: 32 }, (_value, index) => index + 160)),
          }),
    });
    await waitForHelper(
      port,
      {
        protocolVersion: 1,
        expectedHelperInstanceId: helperInstanceId,
        expectedServiceEpoch: serviceEpoch,
        expectedSessionIdentity: sessionIdentity,
        expectedReleaseVersion: "0.1.0-alpha.1",
        kind: "probe",
      },
      helper,
      helperErrors,
    );
    requireRunning(helper, "The native Windows user-session helper did not stay running.");

    const report = await runNativeDriverConformanceLab({
      osFamily: "windows",
      createDriver: () =>
        createWindowsNativeComputerUseDriver({
          helper: port,
          expectedHelperInstanceId: helperInstanceId,
          expectedServiceEpoch: serviceEpoch,
          expectedSessionIdentity: sessionIdentity,
          releaseVersion: "0.1.0-alpha.1",
        }),
    });

    await mkdir(options.evidenceDirectory, { recursive: true });
    const windowsVersion = await readWindowsVersion();
    const evidence = Object.freeze({
      schemaVersion: 1,
      kind: "windows-computer-use-local-engineering-run",
      supportClaim: false,
      sourceCommit: options.sourceCommit ?? "uncommitted-local-engineering-state",
      capturedAt: new Date().toISOString(),
      platform: {
        osFamily: "windows",
        osRelease: windowsVersion.completeBuild ?? release(),
        kernelRelease: release(),
        architecture: process.arch,
        ...(windowsVersion.productName === undefined
          ? {}
          : { registryProductName: windowsVersion.productName }),
        ...(windowsVersion.displayVersion === undefined
          ? {}
          : { displayVersion: windowsVersion.displayVersion }),
      },
      backendId: report.backendId,
      captureAuthorization: options.useOwnerPicker
        ? "owner-selected-windows-graphics-capture-picker"
        : "explicit-nonrelease-direct-fixture-window",
      checks: {
        fixtureVisibleSuccess: true,
        windowsGraphicsCapturePng: true,
        uiAutomationStructuredObservation: true,
        uiAutomationAndSendInputImplementationPresent: true,
        cancellationStoppedInput: report.cancellationStoppedInput,
        emergencyStopStoppedInput: report.emergencyStopStoppedInput,
      },
      screenshot: {
        mediaType: report.pngEvidence.mediaType,
        width: report.pngEvidence.width,
        height: report.pngEvidence.height,
        sha256: report.pngEvidence.sha256,
      },
      fixtureResult: {
        filename: basename(report.resultFile.filename),
        sha256: sha256(report.resultFile.bytes),
      },
      binaries: {
        helperSha256: await sha256File(binaries.helperExecutable),
        fixtureSha256: await sha256File(binaries.fixtureExecutable),
        codeSigningProof: "not-recorded",
      },
      remainingReleaseGates: [
        "publisher code-signing and immutable bundle provenance",
        "clean-host service installation and reboot/login/logout recovery",
        "owner-picker consent withdrawal and permission-denial proof",
        "locked session, session switch, UAC secure desktop, and UIPI denial proof",
        "display/DPI change, helper crash, and partial SendInput fault injection",
        "release-ledger linkage at one immutable source commit",
      ],
    });
    await writeFile(
      join(options.evidenceDirectory, "windows-computer-use-engineering-evidence.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    completion = {
      passed: true,
      supportClaim: false,
      evidenceDirectory: options.evidenceDirectory,
    };
    void fixtureErrors;
    void helperErrors;
  } finally {
    ipcSecret.fill(0);
    await Promise.all([terminateAndWait(helper), terminateAndWait(fixture)]);
    await rm(temporaryDirectory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
  process.stdout.write(`${JSON.stringify(completion)}\n`);
}

function parseArguments(arguments_) {
  let evidenceDirectory;
  let useOwnerPicker = true;
  let sourceCommit;
  for (let index = 0; index < arguments_.length; ++index) {
    const argument = arguments_[index];
    if (argument === "--evidence-directory") {
      evidenceDirectory = arguments_[++index];
    } else if (argument === "--nonrelease-direct-fixture-capture") {
      useOwnerPicker = false;
    } else if (argument === "--source-commit") {
      sourceCommit = arguments_[++index];
    } else {
      throw new Error("The Windows native conformance command arguments are invalid.");
    }
  }
  if (typeof evidenceDirectory !== "string" || !isAbsolute(evidenceDirectory)) {
    throw new Error("An absolute external --evidence-directory is required.");
  }
  if (sourceCommit !== undefined && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(sourceCommit)) {
    throw new Error("--source-commit must be a complete lowercase Git object ID.");
  }
  return {
    evidenceDirectory: resolve(evidenceDirectory),
    useOwnerPicker,
    sourceCommit,
  };
}

async function validateEvidenceDirectory(directory) {
  const [physicalCheckout, physicalDirectory] = await Promise.all([
    realpath(checkoutDirectory),
    resolvePhysicalCandidate(directory),
  ]);
  const relativePath = relative(physicalCheckout, physicalDirectory);
  if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
    throw new Error("Live evidence must be written outside the source checkout.");
  }
}

async function resolvePhysicalCandidate(candidate) {
  let existingAncestor = candidate;
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
      missingSegments.push(basename(existingAncestor));
      existingAncestor = parent;
    }
  }
}

async function waitForHelper(port, command, helper, helperErrors) {
  let lastError;
  for (let attempt = 0; attempt < 30; ++attempt) {
    if (helper.exitCode !== null || helper.signalCode !== null) {
      throw new Error(
        `The native helper exited before readiness (exit ${helper.exitCode ?? "signal"}).`,
      );
    }
    try {
      return await port.execute(command);
    } catch (error) {
      lastError = error;
      await wait(250);
    }
  }
  throw new Error(
    `${lastError instanceof Error ? lastError.message : "The native helper readiness probe failed."} ${helperErrors().trim()}`,
  );
}

function boundedOutput(stream, maximumBytes) {
  let value = Buffer.alloc(0);
  stream?.on("data", (chunk) => {
    if (value.length < maximumBytes) {
      value = Buffer.concat([value, chunk]).subarray(0, maximumBytes);
    }
  });
  return () => value.toString("utf8");
}

function requireRunning(child, message) {
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(message);
  }
}

async function terminateAndWait(child) {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise((resolveExit) => {
    child.once("exit", resolveExit);
  });
  try {
    child.kill();
  } catch {
    // The process may have exited between the state check and termination.
  }
  await Promise.race([exited, wait(5_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill();
    } catch {
      // The process is already terminating.
    }
    await Promise.race([exited, wait(5_000)]);
  }
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error("A Windows native conformance child did not terminate.");
  }
}

function wait(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function sha256File(path) {
  await access(path);
  return sha256(await readFile(path));
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function readWindowsVersion() {
  const [productName, displayVersion, buildNumber, updateBuildRevision] = await Promise.all([
    queryWindowsVersionValue("ProductName"),
    queryWindowsVersionValue("DisplayVersion"),
    queryWindowsVersionValue("CurrentBuildNumber"),
    queryWindowsVersionValue("UBR"),
  ]);
  const parsedRevision =
    updateBuildRevision === undefined
      ? undefined
      : updateBuildRevision.startsWith("0x")
        ? Number.parseInt(updateBuildRevision.slice(2), 16)
        : Number.parseInt(updateBuildRevision, 10);
  return {
    productName,
    displayVersion,
    completeBuild:
      buildNumber !== undefined &&
      parsedRevision !== undefined &&
      Number.isSafeInteger(parsedRevision)
        ? `10.0.${buildNumber}.${parsedRevision}`
        : undefined,
  };
}

async function queryWindowsVersionValue(name) {
  try {
    const { stdout } = await execFileAsync(
      "reg.exe",
      ["query", String.raw`HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion`, "/v", name],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        timeout: 5_000,
        windowsHide: true,
      },
    );
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const match = new RegExp(String.raw`^\s*${escapedName}\s+\S+\s+(.+?)\s*$`, "imu").exec(stdout);
    return match?.[1];
  } catch {
    return undefined;
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Windows native conformance failed."}\n`,
  );
  process.exitCode = 1;
});
