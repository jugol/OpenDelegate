import { REQUIRED_RELEASE_NODE_VERSION } from "./build-release.mjs";
import { assertSha256, hashStableRegularFile, requireExactKeys } from "./release-tooling-io.mjs";

const runnerDetails = new WeakMap();

export async function pinReleaseRunnerIdentity(input) {
  requireExactKeys(
    input,
    ["expectedExecutableSha256", "hashRuntimeExecutable", "runner"],
    "pinned release-runner input",
  );
  assertSha256(input.expectedExecutableSha256, "release-runner executable pin");
  if (typeof input.hashRuntimeExecutable !== "function") {
    throw new Error("The release-runner executable hasher is unavailable.");
  }
  requireExactKeys(input.runner, ["architecture", "nodeVersion", "platform"], "release runner");
  if (
    input.runner.nodeVersion !== REQUIRED_RELEASE_NODE_VERSION ||
    typeof input.runner.platform !== "string" ||
    input.runner.platform.length < 1 ||
    typeof input.runner.architecture !== "string" ||
    input.runner.architecture.length < 1
  ) {
    throw new Error(
      `Release authorization requires the pinned Node.js ${REQUIRED_RELEASE_NODE_VERSION} runner.`,
    );
  }
  const executable = await input.hashRuntimeExecutable();
  assertExecutable(executable, input.expectedExecutableSha256);
  const description = Object.freeze({
    architecture: input.runner.architecture,
    nodeVersion: input.runner.nodeVersion,
    platform: input.runner.platform,
    runtimeExecutableSha256: executable.sha256,
  });
  const handle = Object.freeze({ description });
  runnerDetails.set(
    handle,
    Object.freeze({
      expectedExecutableSha256: input.expectedExecutableSha256,
      hashRuntimeExecutable: input.hashRuntimeExecutable,
      runner: input.runner,
      description,
    }),
  );
  return handle;
}

export async function revalidateReleaseRunnerIdentity(handle) {
  const details = runnerDetails.get(handle);
  if (details === undefined) {
    throw new Error("An opaque pinned release-runner identity is required.");
  }
  if (
    details.runner.nodeVersion !== details.description.nodeVersion ||
    details.runner.platform !== details.description.platform ||
    details.runner.architecture !== details.description.architecture
  ) {
    throw new Error("The release-runner identity changed during authorization.");
  }
  const executable = await details.hashRuntimeExecutable();
  assertExecutable(executable, details.expectedExecutableSha256);
}

export async function hashCurrentNodeExecutable() {
  return hashStableRegularFile(process.execPath);
}

function assertExecutable(value, expectedSha256) {
  if (
    typeof value !== "object" ||
    value === null ||
    value.sha256 !== expectedSha256 ||
    !Number.isSafeInteger(value.size) ||
    value.size < 1
  ) {
    throw new Error("The release-runner executable does not match its required SHA-256 pin.");
  }
}
