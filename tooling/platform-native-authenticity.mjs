import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import { discoverThirdPartyNativeComponents } from "./native-payload-inventory.mjs";

const supportedPlatforms = new Set(["darwin", "linux", "win32"]);
const supportedArchitectures = new Set(["arm64", "x64"]);
const candidateStatus = "release-candidate";
const previewStatuses = new Set(["internal-preview-blocked", "internal-preview-complete"]);
const sha256Pattern = /^[0-9a-f]{64}$/u;
const windowsCertificatePattern = /^[0-9A-F]{40}$/u;
const teamIdPattern = /^[0-9A-Z]{10}$/u;
const maximumPolicyBytes = 64 * 1024;
const maximumEntitlementsBytes = 64 * 1024;
const maximumNativeComponentBytes = 512 * 1024 * 1024;
const maximumSigningToolBytes = 512 * 1024 * 1024;
const maximumToolOutputBytes = 64 * 1024;
const manifestNames = Object.freeze(["native-components.json", "platform-authenticity.json"]);
const verifiedPolicyInputs = new WeakSet();

const expectedNativeComponents = Object.freeze({
  darwin: Object.freeze([
    Object.freeze({ kind: "core-service-host", path: "bin/opendelegate-service-host" }),
    Object.freeze({ kind: "session-helper-host", path: "bin/opendelegate-session-helper" }),
    Object.freeze({
      kind: "computer-use-helper",
      path: "libexec/opendelegate-macos-computer-use",
    }),
    Object.freeze({
      kind: "computer-use-fixture",
      path: "libexec/opendelegate-macos-computer-use-fixture",
    }),
    Object.freeze({
      kind: "secret-store-helper",
      path: "runtime/native/opendelegate-keychain-helper",
    }),
  ]),
  linux: Object.freeze([
    Object.freeze({ kind: "core-service-host", path: "bin/opendelegate-service-host" }),
    Object.freeze({ kind: "session-helper-host", path: "bin/opendelegate-session-helper" }),
    Object.freeze({
      kind: "computer-use-helper",
      path: "libexec/opendelegate-linux-computer-use",
    }),
    Object.freeze({
      kind: "computer-use-fixture",
      path: "libexec/opendelegate-linux-computer-use-fixture",
    }),
  ]),
  win32: Object.freeze([
    Object.freeze({ kind: "core-service-host", path: "bin/opendelegate-service-host.exe" }),
    Object.freeze({
      kind: "session-helper-host",
      path: "bin/opendelegate-session-helper.exe",
    }),
    Object.freeze({
      kind: "computer-use-helper",
      path: "libexec/opendelegate-windows-computer-use-helper.exe",
    }),
    Object.freeze({
      kind: "computer-use-fixture",
      path: "libexec/opendelegate-windows-computer-use-fixture.exe",
    }),
  ]),
});

export async function readPlatformAuthenticityPolicy(path, expectedSha256) {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) {
    throw new Error("The platform-signing policy must use an absolute path.");
  }
  if (typeof expectedSha256 !== "string" || !sha256Pattern.test(expectedSha256)) {
    throw new Error("The platform-signing policy requires a lowercase pre-pinned SHA-256.");
  }
  const lexicalPath = resolve(path);
  const [lexicalMetadata, canonicalPath] = await Promise.all([
    lstat(lexicalPath),
    realpath(lexicalPath),
  ]);
  const canonicalMetadata = await lstat(canonicalPath);
  if (
    !lexicalMetadata.isFile() ||
    lexicalMetadata.isSymbolicLink() ||
    !canonicalMetadata.isFile() ||
    canonicalMetadata.isSymbolicLink() ||
    canonicalMetadata.size > maximumPolicyBytes
  ) {
    throw new Error("The platform-signing policy must be a bounded regular file.");
  }
  const bytes = await readPinnedPolicyBytes(canonicalPath);
  if (sha256(bytes) !== expectedSha256) {
    throw new Error("The platform-signing policy digest does not match its pre-pinned SHA-256.");
  }
  let value;
  try {
    value = deepFreezeJson(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    throw new Error("The platform-signing policy is not valid JSON.", { cause: error });
  }
  const input = Object.freeze({
    path: canonicalPath,
    policy: value,
    sha256: expectedSha256,
    async verifyStable() {
      try {
        const finalBytes = await readPinnedPolicyBytes(canonicalPath);
        if (sha256(finalBytes) !== expectedSha256) {
          throw new Error("The policy digest changed.");
        }
      } catch (error) {
        throw new Error(
          "The platform-signing policy changed while the release bundle was assembled.",
          {
            cause: error,
          },
        );
      }
    },
  });
  verifiedPolicyInputs.add(input);
  return input;
}

export async function finalizePlatformNativeAuthenticity(options) {
  const platform = requirePlatform(options.platform);
  const architecture = requireArchitecture(options.architecture);
  const stagingRoot = await requireRegularDirectory(options.stagingRoot, "native staging root");
  const nativeComponents = validateNativeComponents(
    options.nativeComponents,
    platform,
    architecture,
  );
  const supportStatus = requireSupportStatus(options.supportStatus);
  for (const name of manifestNames) {
    await assertPathAbsent(join(stagingRoot, name), name);
  }

  const componentFiles = [];
  for (const component of nativeComponents.components) {
    componentFiles.push({
      ...component,
      absolutePath: await requireContainedRegularFile(stagingRoot, component.path),
    });
  }
  const thirdPartyFiles = [];
  for (const component of await discoverThirdPartyNativeComponents({
    ownedPaths: nativeComponents.components.map(({ path }) => path),
    platform,
    stagingRoot,
  })) {
    thirdPartyFiles.push({
      ...component,
      absolutePath: await requireContainedRegularFile(stagingRoot, component.path),
    });
  }
  for (const component of [...componentFiles, ...thirdPartyFiles]) {
    component.inputSha256 = `sha256:${await sha256StableFile(
      component.absolutePath,
      maximumNativeComponentBytes,
      "native component input",
    )}`;
  }

  const policy = await resolveEffectivePolicy({
    input: options.policyInput,
    platform,
    supportStatus,
  });
  const runner = options.runner ?? createRealPlatformSigningRunner();
  let tool = null;
  let publicIdentity = null;
  let verification;
  if (policy.mode === "developer-id" || policy.mode === "authenticode") {
    ({ publicIdentity, tool } = await authenticateComponents({
      componentFiles,
      platform,
      policy,
      runner,
      stagingRoot,
    }));
    verification = "signed";
  } else if (policy.mode === "ad-hoc" || policy.mode === "self-signed") {
    ({ publicIdentity, tool } = await authenticateComponents({
      componentFiles,
      platform,
      policy,
      runner,
      stagingRoot,
    }));
    verification = policy.mode;
  } else {
    verification = policy.mode === "publisher-only" ? "publisher-only" : "unsigned";
  }
  let thirdPartyVerification = verification === "signed" ? "resigned" : verification;
  if (
    policy.mode === "developer-id" ||
    policy.mode === "authenticode" ||
    policy.mode === "ad-hoc" ||
    policy.mode === "self-signed"
  ) {
    await authenticateThirdPartyComponents({
      componentFiles: thirdPartyFiles,
      platform,
      policy,
      runner,
      stagingRoot,
    });
    await verifyAuthenticatedComponents({
      componentFiles,
      platform,
      policy,
      runner,
      stagingRoot,
    });
    await verifyFinalThirdPartyComponents({
      componentFiles: thirdPartyFiles,
      platform,
      policy,
      runner,
      stagingRoot,
    });
  }

  const components = [];
  for (const component of componentFiles) {
    const digest = `sha256:${await sha256StableFile(
      component.absolutePath,
      maximumNativeComponentBytes,
      "native component",
    )}`;
    components.push(
      Object.freeze({
        kind: component.kind,
        path: component.path,
        inputSha256: component.inputSha256,
        sha256: digest,
        verification,
      }),
    );
  }
  const finalizedNativeComponents = Object.freeze({
    schemaVersion: 1,
    platform,
    architecture,
    components: Object.freeze(
      components.map(({ kind, path, sha256 }) => Object.freeze({ kind, path, sha256 })),
    ),
  });
  const thirdPartyComponents = [];
  for (const component of thirdPartyFiles) {
    const digest = `sha256:${await sha256StableFile(
      component.absolutePath,
      maximumNativeComponentBytes,
      "third-party native component",
    )}`;
    const upstreamVerified =
      component.kind === "bundled-node-runtime" &&
      policy.thirdParty?.runtime.policy === "upstream-signed-pinned";
    thirdPartyComponents.push(
      Object.freeze({
        kind: component.kind,
        path: component.path,
        inputSha256: component.inputSha256,
        sha256: digest,
        verification: upstreamVerified ? "upstream-verified" : thirdPartyVerification,
        publicIdentity: upstreamVerified ? policy.thirdParty.runtime.publicIdentity : null,
      }),
    );
  }
  const supportEligible = supportStatus === candidateStatus;
  const platformAuthenticity = Object.freeze({
    schemaVersion: 1,
    target: Object.freeze({ platform, architecture }),
    supportEligible,
    status: supportEligible ? "verified" : policy.mode,
    policy: supportEligible ? policy.mode : "unsupported-preview",
    policySha256: policy.sha256,
    tool,
    publicIdentity,
    components: Object.freeze(components),
    thirdPartyComponents: Object.freeze(thirdPartyComponents),
  });

  await verifyPolicyInputStable(options.policyInput);
  await writeManifestPair(stagingRoot, finalizedNativeComponents, platformAuthenticity);
  return Object.freeze({
    nativeComponents: finalizedNativeComponents,
    platformAuthenticity,
  });
}

export async function verifyFinalPlatformNativeAuthenticity(options) {
  const nativeComponents = options.nativeComponents;
  const platformAuthenticity = options.platformAuthenticity;
  const platform = requirePlatform(nativeComponents?.platform);
  const architecture = requireArchitecture(nativeComponents?.architecture);
  const stagingRoot = await requireRegularDirectory(options.stagingRoot, "native staging root");
  validateFinalizedManifests(nativeComponents, platformAuthenticity, platform, architecture);
  await assertExactJsonManifest(stagingRoot, "native-components.json", nativeComponents);
  await assertExactJsonManifest(stagingRoot, "platform-authenticity.json", platformAuthenticity);
  const policy = await resolveEffectivePolicy({
    input: options.policyInput,
    platform,
    supportStatus: platformAuthenticity.supportEligible
      ? candidateStatus
      : "internal-preview-complete",
  });
  if (policy.sha256 !== platformAuthenticity.policySha256) {
    throw new Error("The final native seal does not match its pinned policy digest.");
  }

  const componentFiles = [];
  for (const component of nativeComponents.components) {
    componentFiles.push({
      ...component,
      absolutePath: await requireContainedRegularFile(stagingRoot, component.path),
    });
  }
  const discoveredThirdParty = await discoverThirdPartyNativeComponents({
    ownedPaths: nativeComponents.components.map(({ path }) => path),
    platform,
    stagingRoot,
  });
  if (
    JSON.stringify(discoveredThirdParty) !==
    JSON.stringify(
      platformAuthenticity.thirdPartyComponents.map(({ kind, path }) => ({ kind, path })),
    )
  ) {
    throw new Error("The third-party native inventory changed before final payload sealing.");
  }
  const thirdPartyFiles = [];
  for (const component of platformAuthenticity.thirdPartyComponents) {
    thirdPartyFiles.push({
      ...component,
      absolutePath: await requireContainedRegularFile(stagingRoot, component.path),
    });
  }
  const mode = platformAuthenticity.supportEligible
    ? platformAuthenticity.policy
    : platformAuthenticity.status;
  if (
    mode === "developer-id" ||
    mode === "authenticode" ||
    mode === "ad-hoc" ||
    mode === "self-signed"
  ) {
    if (
      platformAuthenticity.tool.version !== policy.tool.version ||
      platformAuthenticity.tool.sha256 !== policy.tool.sha256 ||
      JSON.stringify(platformAuthenticity.publicIdentity) !== JSON.stringify(policy.publicIdentity)
    ) {
      throw new Error("The final native seal does not match its signing tool or public identity.");
    }
    const runtimeRecord = platformAuthenticity.thirdPartyComponents.find(
      ({ kind }) => kind === "bundled-node-runtime",
    );
    if (
      JSON.stringify(runtimeRecord.publicIdentity) !==
      JSON.stringify(policy.thirdParty.runtime.publicIdentity)
    ) {
      throw new Error("The final native seal does not match its upstream runtime identity.");
    }
    await verifyAuthenticatedComponents({
      componentFiles,
      platform,
      policy,
      runner: options.runner ?? createRealPlatformSigningRunner(),
      stagingRoot,
    });
    await verifyFinalThirdPartyComponents({
      componentFiles: thirdPartyFiles,
      platform,
      policy,
      runner: options.runner ?? createRealPlatformSigningRunner(),
      stagingRoot,
    });
  }

  for (const component of [...componentFiles, ...thirdPartyFiles]) {
    component.absolutePath = await requireContainedRegularFile(stagingRoot, component.path);
    const digest = `sha256:${await sha256StableFile(
      component.absolutePath,
      maximumNativeComponentBytes,
      "native component",
    )}`;
    if (digest !== component.sha256) {
      throw new Error(
        `Native component ${component.path} digest no longer matches its frozen native manifest.`,
      );
    }
  }
}

export function createRealPlatformSigningRunner({ execute = executeSigningTool } = {}) {
  if (typeof execute !== "function") {
    throw new Error("The platform signing process boundary must be callable.");
  }
  const invoke = (command, input) =>
    executePinnedSigningTool({
      command,
      enforceProtectedPath: execute === executeSigningTool,
      execute,
      platform: input.platform,
      tool: requireRunnerTool(input),
    });
  return Object.freeze({
    async readToolVersion(input) {
      const result = await invoke(
        {
          arguments: input.platform === "win32" ? ["/?"] : ["--version"],
          environment: signingEnvironment(input.platform),
          file: input.toolPath,
          operation: "tool-version",
        },
        input,
      );
      return parseToolVersion(result);
    },
    async signAndVerify(input) {
      const executeForTool = (command) => invoke(command, input);
      if (input.platform === "darwin") {
        await signAndVerifyMacOs(input, executeForTool);
        return;
      }
      if (input.platform === "win32") {
        await signAndVerifyWindows(input, executeForTool);
        return;
      }
      throw new Error("Linux has no platform-native signing operation in the first milestone.");
    },
    async verify(input) {
      const executeForTool = (command) => invoke(command, input);
      if (input.platform === "darwin") {
        await verifyMacOsSignature(input, executeForTool);
        return;
      }
      if (input.platform === "win32") {
        await verifyWindowsSignature(input, executeForTool);
        return;
      }
      throw new Error("Linux has no platform-native signing operation in the first milestone.");
    },
  });
}

async function authenticateComponents({ componentFiles, platform, policy, runner, stagingRoot }) {
  if (
    runner === null ||
    typeof runner !== "object" ||
    typeof runner.readToolVersion !== "function" ||
    typeof runner.signAndVerify !== "function" ||
    typeof runner.verify !== "function"
  ) {
    throw new Error("The platform signing runner does not implement the required boundary.");
  }
  const pinnedTool = await requirePinnedSigningTool(policy.tool);
  const toolPath = pinnedTool.path;
  const version = await runner.readToolVersion({
    platform,
    toolIdentity: pinnedTool.identity,
    toolPath,
    toolSha256: pinnedTool.sha256,
  });
  if (version !== policy.tool.version) {
    throw new Error("The platform signing tool version does not match its allowlist.");
  }
  const beforeDigest = await sha256StableFile(
    toolPath,
    maximumSigningToolBytes,
    "platform signing tool",
  );
  if (beforeDigest !== pinnedTool.sha256) {
    throw new Error("The platform signing tool changed after its allowlist was verified.");
  }
  for (const component of componentFiles) {
    await runner.signAndVerify(signingRunnerInput(component, platform, policy, pinnedTool));
  }
  for (const component of componentFiles) {
    component.absolutePath = await requireContainedRegularFile(stagingRoot, component.path);
    await verifyComponentWithoutMutation({
      component,
      input: signingRunnerInput(component, platform, policy, pinnedTool),
      runner,
      stagingRoot,
    });
  }
  if (
    (await sha256StableFile(toolPath, maximumSigningToolBytes, "platform signing tool")) !==
    beforeDigest
  ) {
    throw new Error(
      "The platform signing tool changed while native components were authenticated.",
    );
  }
  return {
    tool: Object.freeze({
      name: platform === "darwin" ? "codesign" : "signtool",
      version,
      sha256: beforeDigest,
    }),
    publicIdentity: policy.publicIdentity,
  };
}

async function authenticateThirdPartyComponents({
  componentFiles,
  platform,
  policy,
  runner,
  stagingRoot,
}) {
  if (policy.thirdParty === undefined) {
    throw new Error("Signed payloads require an explicit third-party native policy.");
  }
  if (
    runner === null ||
    typeof runner !== "object" ||
    typeof runner.readToolVersion !== "function" ||
    typeof runner.signAndVerify !== "function" ||
    typeof runner.verify !== "function"
  ) {
    throw new Error("The platform signing runner does not implement the required boundary.");
  }
  const pinnedTool = await requirePinnedSigningTool(policy.tool);
  const version = await runner.readToolVersion({
    platform,
    toolIdentity: pinnedTool.identity,
    toolPath: pinnedTool.path,
    toolSha256: pinnedTool.sha256,
  });
  if (version !== policy.tool.version) {
    throw new Error("The platform signing tool version does not match its allowlist.");
  }
  const entitlements = await requirePinnedEntitlements(
    policy.thirdParty.nativeLibraries.entitlements,
  );
  for (const component of componentFiles) {
    component.absolutePath = await requireContainedRegularFile(stagingRoot, component.path);
    if (component.kind === "bundled-node-runtime") {
      await verifyComponentWithoutMutation({
        component,
        input: signingRunnerInput(
          component,
          platform,
          {
            mode: platform === "darwin" ? "developer-id" : "authenticode",
            publicIdentity: policy.thirdParty.runtime.publicIdentity,
            tool: policy.tool,
          },
          pinnedTool,
        ),
        runner,
        stagingRoot,
      });
    } else {
      await runner.signAndVerify(
        signingRunnerInput(component, platform, policy, pinnedTool, entitlements?.path),
      );
    }
  }
  for (const component of componentFiles) {
    component.absolutePath = await requireContainedRegularFile(stagingRoot, component.path);
    const verificationPolicy =
      component.kind === "bundled-node-runtime"
        ? {
            mode: platform === "darwin" ? "developer-id" : "authenticode",
            publicIdentity: policy.thirdParty.runtime.publicIdentity,
            tool: policy.tool,
          }
        : policy;
    await verifyComponentWithoutMutation({
      component,
      input: signingRunnerInput(
        component,
        platform,
        verificationPolicy,
        pinnedTool,
        component.kind === "bundled-node-runtime" ? undefined : entitlements?.path,
      ),
      runner,
      stagingRoot,
    });
  }
  await assertPinnedFileUnchanged(pinnedTool, maximumSigningToolBytes, "platform signing tool");
  if (entitlements !== null) {
    await assertPinnedFileUnchanged(
      entitlements,
      maximumEntitlementsBytes,
      "macOS entitlements file",
    );
  }
}

async function verifyFinalThirdPartyComponents({
  componentFiles,
  platform,
  policy,
  runner,
  stagingRoot,
}) {
  requireVerificationRunner(runner);
  if (policy.thirdParty === undefined) {
    throw new Error("The final native seal requires its third-party signing policy.");
  }
  const pinnedTool = await requirePinnedSigningTool(policy.tool);
  const version = await runner.readToolVersion({
    platform,
    toolIdentity: pinnedTool.identity,
    toolPath: pinnedTool.path,
    toolSha256: pinnedTool.sha256,
  });
  if (version !== policy.tool.version) {
    throw new Error("The platform signing tool version does not match its allowlist.");
  }
  const entitlements = await requirePinnedEntitlements(
    policy.thirdParty.nativeLibraries.entitlements,
  );
  for (const component of componentFiles) {
    component.absolutePath = await requireContainedRegularFile(stagingRoot, component.path);
    const upstreamRuntime = component.kind === "bundled-node-runtime";
    const verificationPolicy = upstreamRuntime
      ? {
          mode: platform === "darwin" ? "developer-id" : "authenticode",
          publicIdentity: policy.thirdParty.runtime.publicIdentity,
          tool: policy.tool,
        }
      : policy;
    await verifyComponentWithoutMutation({
      component,
      input: signingRunnerInput(
        component,
        platform,
        verificationPolicy,
        pinnedTool,
        upstreamRuntime ? undefined : entitlements?.path,
      ),
      runner,
      stagingRoot,
    });
  }
  await assertPinnedFileUnchanged(pinnedTool, maximumSigningToolBytes, "platform signing tool");
  if (entitlements !== null) {
    await assertPinnedFileUnchanged(
      entitlements,
      maximumEntitlementsBytes,
      "macOS entitlements file",
    );
  }
}

async function requirePinnedEntitlements(policy) {
  if (policy === undefined || policy === null || policy.mode === "none") {
    return null;
  }
  const inspected = await inspectStableRegularFile(
    policy.path,
    maximumEntitlementsBytes,
    "macOS entitlements file",
  );
  if (inspected.sha256 !== policy.sha256) {
    throw new Error("The macOS entitlements digest does not match its policy pin.");
  }
  return inspected;
}

async function assertPinnedFileUnchanged(expected, maximumBytes, label) {
  const actual = await inspectStableRegularFile(expected.path, maximumBytes, label);
  if (
    actual.sha256 !== expected.sha256 ||
    !sameRecordedFileIdentity(actual.identity, expected.identity)
  ) {
    throw new Error(`The ${label} changed during native authentication.`);
  }
}

async function verifyAuthenticatedComponents({
  componentFiles,
  platform,
  policy,
  runner,
  stagingRoot,
}) {
  requireVerificationRunner(runner);
  const pinnedTool = await requirePinnedSigningTool(policy.tool);
  const version = await runner.readToolVersion({
    platform,
    toolIdentity: pinnedTool.identity,
    toolPath: pinnedTool.path,
    toolSha256: pinnedTool.sha256,
  });
  if (version !== policy.tool.version) {
    throw new Error("The platform signing tool version does not match its allowlist.");
  }
  for (const component of componentFiles) {
    component.absolutePath = await requireContainedRegularFile(stagingRoot, component.path);
    await verifyComponentWithoutMutation({
      component,
      input: signingRunnerInput(component, platform, policy, pinnedTool),
      runner,
      stagingRoot,
    });
  }
  if (
    (await sha256StableFile(pinnedTool.path, maximumSigningToolBytes, "platform signing tool")) !==
    pinnedTool.sha256
  ) {
    throw new Error(
      "The platform signing tool changed while final native authenticity was verified.",
    );
  }
}

async function verifyComponentWithoutMutation({ component, input, runner, stagingRoot }) {
  const before = await sha256StableFile(
    component.absolutePath,
    maximumNativeComponentBytes,
    "native component before signature verification",
  );
  await runner.verify(input);
  component.absolutePath = await requireContainedRegularFile(stagingRoot, component.path);
  const after = await sha256StableFile(
    component.absolutePath,
    maximumNativeComponentBytes,
    "native component after signature verification",
  );
  if (after !== before) {
    throw new Error(`Signature verification mutated native component ${component.path}.`);
  }
}

function requireVerificationRunner(runner) {
  if (
    runner === null ||
    typeof runner !== "object" ||
    typeof runner.readToolVersion !== "function" ||
    typeof runner.verify !== "function"
  ) {
    throw new Error("The platform signing runner does not implement the verification boundary.");
  }
}

function signingRunnerInput(component, platform, policy, pinnedTool, entitlementsPath) {
  return {
    absolutePath: component.absolutePath,
    entitlementsPath,
    mode: policy.mode,
    platform,
    publicIdentity: policy.publicIdentity,
    relativePath: component.path,
    toolIdentity: pinnedTool.identity,
    toolPath: pinnedTool.path,
    toolSha256: pinnedTool.sha256,
  };
}

async function resolveEffectivePolicy({ input, platform, supportStatus }) {
  const candidate = supportStatus === candidateStatus;
  const externalPolicy = input !== undefined;
  await verifyPolicyInputStable(input);
  const value = externalPolicy ? input.policy : undefined;
  let normalized;
  if (candidate && platform === "linux") {
    if (value !== undefined) {
      throw new Error("Linux release candidates use the built-in publisher-only native policy.");
    }
    normalized = Object.freeze({
      schemaVersion: 1,
      platform,
      mode: "publisher-only",
    });
  } else if (!candidate && value === undefined) {
    normalized = Object.freeze({
      schemaVersion: 1,
      platform,
      mode: "unsigned",
    });
  } else {
    if (value === undefined) {
      throw new Error(
        `${platform} release candidates require an explicit platform-signing policy.`,
      );
    }
    normalized = normalizeSigningPolicy(value, platform, candidate);
  }
  return Object.freeze({
    ...normalized,
    sha256: externalPolicy
      ? input.sha256
      : sha256(Buffer.from(`${JSON.stringify(normalized)}\n`, "utf8")),
  });
}

async function verifyPolicyInputStable(input) {
  if (input === undefined) {
    return;
  }
  if (
    input === null ||
    typeof input !== "object" ||
    !verifiedPolicyInputs.has(input) ||
    typeof input.verifyStable !== "function"
  ) {
    throw new Error(
      "An external platform-signing policy requires an opaque pre-pinned policy input.",
    );
  }
  await input.verifyStable();
}

function normalizeSigningPolicy(value, platform, candidate) {
  requireExactObject(
    value,
    ["schemaVersion", "platform", "mode", "tool", "identity", "thirdParty"],
    "policy",
  );
  if (value.schemaVersion !== 1 || value.platform !== platform) {
    throw new Error("The platform-signing policy target is invalid.");
  }
  if (platform === "darwin") {
    const expectedMode = candidate ? "developer-id" : "ad-hoc";
    if (value.mode !== expectedMode) {
      throw new Error(
        `A ${candidate ? "candidate" : "preview"} macOS policy must use ${expectedMode}.`,
      );
    }
    const tool = normalizeTool(value.tool);
    if (value.mode === "ad-hoc") {
      if (value.identity !== null) {
        throw new Error("An ad-hoc macOS preview cannot declare a production identity.");
      }
      const thirdParty = normalizeThirdPartyPolicy(value.thirdParty, platform);
      return Object.freeze({
        schemaVersion: 1,
        platform,
        mode: value.mode,
        tool,
        identity: null,
        publicIdentity: null,
        thirdParty,
      });
    }
    requireExactObject(value.identity, ["selector", "teamId"], "Apple public identity");
    if (
      typeof value.identity.selector !== "string" ||
      !value.identity.selector.startsWith("Developer ID Application: ") ||
      !teamIdPattern.test(value.identity.teamId) ||
      !value.identity.selector.endsWith(` (${value.identity.teamId})`) ||
      value.identity.selector.length > 200 ||
      hasControlCharacters(value.identity.selector)
    ) {
      throw new Error("The Apple Developer ID public identity is invalid.");
    }
    const publicIdentity = Object.freeze({
      type: "apple-developer-id-application",
      selector: value.identity.selector,
      teamId: value.identity.teamId,
    });
    const thirdParty = normalizeThirdPartyPolicy(value.thirdParty, platform);
    assertDistinctProductAndUpstreamIdentities(publicIdentity, thirdParty.runtime.publicIdentity);
    return Object.freeze({
      schemaVersion: 1,
      platform,
      mode: value.mode,
      tool,
      identity: Object.freeze({
        selector: value.identity.selector,
        teamId: value.identity.teamId,
      }),
      publicIdentity,
      thirdParty,
    });
  }
  if (platform === "win32") {
    const expectedMode = candidate ? "authenticode" : "self-signed";
    if (value.mode !== expectedMode) {
      throw new Error(
        `A ${candidate ? "candidate" : "preview"} Windows policy must use ${expectedMode}.`,
      );
    }
    const tool = normalizeTool(value.tool);
    requireExactObject(
      value.identity,
      ["certificateSha1", "store", "timestampUrl"],
      "Windows public identity",
    );
    const timestampUrl = requirePublicHttpsUrl(value.identity.timestampUrl);
    if (
      typeof value.identity.certificateSha1 !== "string" ||
      !windowsCertificatePattern.test(value.identity.certificateSha1) ||
      (value.identity.store !== "CurrentUser/My" && value.identity.store !== "LocalMachine/My")
    ) {
      throw new Error("The Windows certificate-store identity is invalid.");
    }
    const publicIdentity = Object.freeze({
      type: "windows-authenticode",
      certificateSha1: value.identity.certificateSha1,
      store: value.identity.store,
      timestampUrl,
    });
    const thirdParty = normalizeThirdPartyPolicy(value.thirdParty, platform);
    assertDistinctProductAndUpstreamIdentities(publicIdentity, thirdParty.runtime.publicIdentity);
    return Object.freeze({
      schemaVersion: 1,
      platform,
      mode: value.mode,
      tool,
      identity: Object.freeze({
        certificateSha1: value.identity.certificateSha1,
        store: value.identity.store,
        timestampUrl,
      }),
      publicIdentity,
      thirdParty,
    });
  }
  throw new Error("Linux previews support only the explicit unsigned native policy.");
}

function normalizeThirdPartyPolicy(value, platform) {
  requireExactObject(value, ["runtime", "nativeLibraries"], "third-party native policy");
  requireExactObject(value.runtime, ["policy", "identity"], "bundled runtime policy");
  if (value.runtime.policy !== "upstream-signed-pinned") {
    throw new Error("The bundled Node runtime must retain a pinned upstream signature.");
  }
  let runtimeIdentity;
  if (platform === "darwin") {
    requireExactObject(value.runtime.identity, ["selector", "teamId"], "runtime Apple identity");
    if (
      typeof value.runtime.identity.selector !== "string" ||
      !value.runtime.identity.selector.startsWith("Developer ID Application: ") ||
      !teamIdPattern.test(value.runtime.identity.teamId) ||
      !value.runtime.identity.selector.endsWith(` (${value.runtime.identity.teamId})`) ||
      value.runtime.identity.selector.length > 200 ||
      hasControlCharacters(value.runtime.identity.selector)
    ) {
      throw new Error("The bundled Node runtime Apple identity is invalid.");
    }
    runtimeIdentity = Object.freeze({
      type: "apple-developer-id-application",
      selector: value.runtime.identity.selector,
      teamId: value.runtime.identity.teamId,
    });
  } else {
    requireExactObject(
      value.runtime.identity,
      ["certificateSha1"],
      "runtime Authenticode identity",
    );
    if (
      typeof value.runtime.identity.certificateSha1 !== "string" ||
      !windowsCertificatePattern.test(value.runtime.identity.certificateSha1)
    ) {
      throw new Error("The bundled Node runtime Authenticode identity is invalid.");
    }
    runtimeIdentity = Object.freeze({
      type: "windows-authenticode-upstream",
      certificateSha1: value.runtime.identity.certificateSha1,
    });
  }

  requireExactObject(
    value.nativeLibraries,
    ["policy", "entitlements"],
    "third-party native-library policy",
  );
  if (value.nativeLibraries.policy !== "resigned") {
    throw new Error("Bundled third-party native libraries must use the declared re-sign policy.");
  }
  const entitlements =
    platform === "darwin"
      ? normalizeEntitlementsPolicy(value.nativeLibraries.entitlements)
      : value.nativeLibraries.entitlements;
  if (platform === "win32" && entitlements !== null) {
    throw new Error("Windows third-party native libraries cannot declare macOS entitlements.");
  }
  return Object.freeze({
    runtime: Object.freeze({
      policy: value.runtime.policy,
      publicIdentity: runtimeIdentity,
    }),
    nativeLibraries: Object.freeze({
      policy: value.nativeLibraries.policy,
      entitlements,
    }),
  });
}

function normalizeEntitlementsPolicy(value) {
  const keys =
    value !== null && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
  if (keys.length === 1 && keys[0] === "mode" && value.mode === "none") {
    return Object.freeze({ mode: "none" });
  }
  requireExactObject(value, ["mode", "path", "sha256"], "macOS entitlements policy");
  if (
    value.mode !== "file" ||
    typeof value.path !== "string" ||
    !isAbsolute(value.path) ||
    value.path.includes("\0") ||
    typeof value.sha256 !== "string" ||
    !sha256Pattern.test(value.sha256)
  ) {
    throw new Error("The macOS entitlements policy is invalid.");
  }
  return Object.freeze({
    mode: "file",
    path: resolve(value.path),
    sha256: value.sha256,
  });
}

function assertDistinctProductAndUpstreamIdentities(product, upstream) {
  const duplicate =
    product.type === "apple-developer-id-application"
      ? upstream.type === "apple-developer-id-application" &&
        (product.teamId === upstream.teamId || product.selector === upstream.selector)
      : upstream.type === "windows-authenticode-upstream" &&
        product.certificateSha1 === upstream.certificateSha1;
  if (duplicate) {
    throw new Error("Product and upstream runtime signing identities must be distinct.");
  }
}

function normalizeTool(value) {
  requireExactObject(value, ["path", "version", "sha256"], "signing tool");
  if (
    typeof value.path !== "string" ||
    !isAbsolute(value.path) ||
    value.path.includes("\0") ||
    typeof value.version !== "string" ||
    value.version.trim() !== value.version ||
    value.version.length === 0 ||
    value.version.length > 200 ||
    hasControlCharacters(value.version) ||
    typeof value.sha256 !== "string" ||
    !sha256Pattern.test(value.sha256)
  ) {
    throw new Error("The signing tool allowlist is invalid.");
  }
  return Object.freeze({
    path: resolve(value.path),
    version: value.version,
    sha256: value.sha256,
  });
}

async function requirePinnedSigningTool(tool) {
  const inspected = await inspectStableRegularFile(
    tool.path,
    maximumSigningToolBytes,
    "allowlisted platform signing tool",
  );
  const digest = inspected.sha256;
  if (digest !== tool.sha256) {
    throw new Error("The platform signing tool digest does not match its allowlist.");
  }
  return inspected;
}

async function signAndVerifyMacOs(input, execute) {
  const signingArguments =
    input.mode === "ad-hoc"
      ? ["--force", "--options", "runtime", "--sign", "-", input.absolutePath]
      : [
          "--force",
          "--options",
          "runtime",
          "--timestamp",
          "--sign",
          input.publicIdentity.selector,
          input.absolutePath,
        ];
  if (input.entitlementsPath !== undefined) {
    signingArguments.splice(
      signingArguments.length - 1,
      0,
      "--entitlements",
      input.entitlementsPath,
    );
  }
  const environment = signingEnvironment("darwin");
  await execute({
    arguments: signingArguments,
    environment,
    file: input.toolPath,
    operation: "macos-sign",
  });
  await verifyMacOsSignature(input, execute);
}

async function verifyMacOsSignature(input, execute) {
  const environment = signingEnvironment("darwin");
  await execute({
    arguments: ["--verify", "--strict", "--verbose=2", input.absolutePath],
    environment,
    file: input.toolPath,
    operation: "macos-verification",
  });
  const inspection = await execute({
    arguments: ["--display", "--verbose=4", input.absolutePath],
    environment,
    file: input.toolPath,
    operation: "macos-identity",
  });
  const details = `${inspection.stdout}\n${inspection.stderr}`;
  if (input.mode === "ad-hoc") {
    if (!/Signature=adhoc/iu.test(details) || !/runtime/iu.test(details)) {
      throw new Error("The macOS ad-hoc signature did not verify its hardened-runtime policy.");
    }
    return;
  }
  if (
    !details.includes(`Authority=${input.publicIdentity.selector}`) ||
    !details.includes(`TeamIdentifier=${input.publicIdentity.teamId}`) ||
    !/Timestamp=/u.test(details) ||
    !/runtime/iu.test(details)
  ) {
    throw new Error(
      "The macOS native signature does not match its allowlisted Developer ID, timestamp, and hardened-runtime policy.",
    );
  }
}

async function signAndVerifyWindows(input, execute) {
  const store = input.publicIdentity.store;
  const signingArguments = [
    "sign",
    "/fd",
    "SHA256",
    "/sha1",
    input.publicIdentity.certificateSha1,
    "/s",
    "My",
  ];
  if (store === "LocalMachine/My") {
    signingArguments.push("/sm");
  }
  signingArguments.push(
    "/tr",
    input.publicIdentity.timestampUrl,
    "/td",
    "SHA256",
    input.absolutePath,
  );
  const environment = signingEnvironment("win32");
  await execute({
    arguments: signingArguments,
    environment,
    file: input.toolPath,
    operation: "windows-sign",
  });
  await verifyWindowsSignature(input, execute);
}

async function verifyWindowsSignature(input, execute) {
  const environment = signingEnvironment("win32");
  const verification = await execute({
    arguments: ["verify", "/pa", "/all", "/tw", "/v", input.absolutePath],
    environment,
    file: input.toolPath,
    operation: "windows-verification",
  });
  const details = `${verification.stdout}\n${verification.stderr}`;
  const collapsed = details.replaceAll(/\s/gu, "").toUpperCase();
  if (
    !collapsed.includes(input.publicIdentity.certificateSha1) ||
    !/(?:The signature is timestamped|Timestamp Verified by)/iu.test(details)
  ) {
    throw new Error(
      "The Windows native signature does not match its allowlisted certificate and RFC3161 timestamp policy.",
    );
  }
}

function requireRunnerTool(input) {
  if (
    typeof input.toolPath !== "string" ||
    !isAbsolute(input.toolPath) ||
    typeof input.toolSha256 !== "string" ||
    !sha256Pattern.test(input.toolSha256) ||
    input.toolIdentity === null ||
    typeof input.toolIdentity !== "object"
  ) {
    throw new Error("The signing runner requires a pinned tool identity.");
  }
  return Object.freeze({
    identity: input.toolIdentity,
    path: resolve(input.toolPath),
    sha256: input.toolSha256,
  });
}

async function executePinnedSigningTool({
  command,
  enforceProtectedPath,
  execute,
  platform,
  tool,
}) {
  const before = await inspectStableRegularFile(
    tool.path,
    maximumSigningToolBytes,
    "platform signing tool",
  );
  assertExactPinnedTool(before, tool);
  if (enforceProtectedPath) {
    assertProtectedSigningToolPath(platform, before.path);
  }
  let result;
  let executionError;
  try {
    result = await execute(command);
  } catch (error) {
    executionError = error;
  }
  let after;
  try {
    after = await inspectStableRegularFile(
      tool.path,
      maximumSigningToolBytes,
      "platform signing tool",
    );
    assertExactPinnedTool(after, tool);
    assertExactPinnedTool(after, before);
  } catch (error) {
    throw new Error("The platform signing tool changed across one invocation.", {
      cause: error,
    });
  }
  if (executionError !== undefined) {
    throw executionError;
  }
  return result;
}

function assertExactPinnedTool(actual, expected) {
  if (
    comparablePath(actual.path) !== comparablePath(expected.path) ||
    actual.sha256 !== expected.sha256 ||
    !sameRecordedFileIdentity(actual.identity, expected.identity)
  ) {
    throw new Error("The platform signing tool does not match its pinned file identity.");
  }
}

function assertProtectedSigningToolPath(platform, path) {
  // Node has no cross-platform descriptor-based process execution. Candidate execution
  // therefore combines exact pre/post identity checks with OS-protected canonical roots.
  if (platform === "darwin") {
    if (path !== "/usr/bin/codesign") {
      throw new Error("Production macOS signing must use the protected /usr/bin/codesign.");
    }
    return;
  }
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
    .filter((value) => typeof value === "string" && isAbsolute(value))
    .map((value) => resolve(value));
  if (
    basename(path).toLowerCase() !== "signtool.exe" ||
    !roots.some((root) => isStrictDescendant(root, path))
  ) {
    throw new Error("Production Windows signing must use signtool.exe under Program Files.");
  }
}

async function executeSigningTool(input) {
  const child = spawn(input.file, input.arguments, {
    env: input.environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let outputOverflow = false;
  let timedOut = false;
  const append = (current, chunk) => {
    const next = Buffer.concat([current, chunk]);
    if (next.length > maximumToolOutputBytes) {
      outputOverflow = true;
      child.kill("SIGKILL");
      return current;
    }
    return next;
  };
  child.stdout.on("data", (chunk) => {
    stdout = append(stdout, chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr = append(stderr, chunk);
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 120_000);
  timeout.unref();
  let launchError;
  const exitCode = await new Promise((resolvePromise) => {
    child.once("error", (error) => {
      launchError = error;
      resolvePromise(null);
    });
    child.once("close", (code) => resolvePromise(code));
  }).finally(() => clearTimeout(timeout));
  if (outputOverflow) {
    throw new Error("The platform signing tool produced oversized output.");
  }
  if (timedOut) {
    throw new Error("The platform signing tool exceeded its bounded execution time.");
  }
  if (launchError !== undefined) {
    throw new Error("The pinned platform signing tool could not be started.");
  }
  if (exitCode !== 0) {
    throw new Error(
      `The platform signing tool failed during ${input.operation} (exit ${String(exitCode)}).`,
    );
  }
  return {
    stdout: stdout.toString("utf8"),
    stderr: stderr.toString("utf8"),
  };
}

function signingEnvironment(platform) {
  if (platform === "darwin") {
    return Object.freeze({
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
      TMPDIR: tmpdir(),
    });
  }
  const environment = {
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    VSLANG: "1033",
    WINDIR: process.env.WINDIR,
  };
  return Object.freeze(
    Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== undefined)),
  );
}

function parseToolVersion(result) {
  const output = `${result.stdout}\n${result.stderr}`;
  const windowsVersion = /File Signing Tool Version\s+([0-9.]+)/iu.exec(output)?.[1];
  const version =
    windowsVersion ??
    output
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line !== "");
  if (version === undefined || version.length > 200) {
    throw new Error("The platform signing tool did not report a bounded version.");
  }
  return version;
}

function validateNativeComponents(value, platform, architecture) {
  requireExactObject(
    value,
    ["schemaVersion", "platform", "architecture", "components"],
    "native component inventory",
  );
  if (
    value.schemaVersion !== 1 ||
    value.platform !== platform ||
    value.architecture !== architecture ||
    !Array.isArray(value.components)
  ) {
    throw new Error("The native component inventory target is invalid.");
  }
  const expected = expectedNativeComponents[platform];
  if (JSON.stringify(value.components) !== JSON.stringify(expected)) {
    throw new Error(
      "The native component inventory does not exactly name every OpenDelegate-owned executable.",
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    platform,
    architecture,
    components: expected,
  });
}

function validateFinalizedManifests(
  nativeComponents,
  platformAuthenticity,
  platform,
  architecture,
) {
  requireExactObject(
    nativeComponents,
    ["schemaVersion", "platform", "architecture", "components"],
    "frozen native component manifest",
  );
  if (
    nativeComponents.schemaVersion !== 1 ||
    nativeComponents.platform !== platform ||
    nativeComponents.architecture !== architecture ||
    !Array.isArray(nativeComponents.components)
  ) {
    throw new Error("The frozen native component manifest target is invalid.");
  }
  const expected = expectedNativeComponents[platform];
  if (nativeComponents.components.length !== expected.length) {
    throw new Error("The frozen native component manifest inventory is incomplete.");
  }
  for (let index = 0; index < expected.length; index += 1) {
    const component = nativeComponents.components[index];
    requireExactObject(component, ["kind", "path", "sha256"], "frozen native component");
    if (
      component.kind !== expected[index].kind ||
      component.path !== expected[index].path ||
      typeof component.sha256 !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(component.sha256)
    ) {
      throw new Error("The frozen native component manifest inventory is invalid.");
    }
  }

  requireExactObject(
    platformAuthenticity,
    [
      "schemaVersion",
      "target",
      "supportEligible",
      "status",
      "policy",
      "policySha256",
      "tool",
      "publicIdentity",
      "components",
      "thirdPartyComponents",
    ],
    "platform authenticity manifest",
  );
  requireExactObject(platformAuthenticity.target, ["platform", "architecture"], "native target");
  if (
    platformAuthenticity.schemaVersion !== 1 ||
    platformAuthenticity.target.platform !== platform ||
    platformAuthenticity.target.architecture !== architecture ||
    typeof platformAuthenticity.supportEligible !== "boolean" ||
    typeof platformAuthenticity.policySha256 !== "string" ||
    !sha256Pattern.test(platformAuthenticity.policySha256) ||
    !Array.isArray(platformAuthenticity.components) ||
    platformAuthenticity.components.length !== expected.length ||
    !Array.isArray(platformAuthenticity.thirdPartyComponents)
  ) {
    throw new Error("The platform authenticity manifest target or policy binding is invalid.");
  }

  const mode = platformAuthenticity.supportEligible
    ? platformAuthenticity.policy
    : platformAuthenticity.status;
  const expectedCandidateMode =
    platform === "darwin"
      ? "developer-id"
      : platform === "win32"
        ? "authenticode"
        : "publisher-only";
  if (
    platformAuthenticity.supportEligible
      ? platformAuthenticity.status !== "verified" ||
        platformAuthenticity.policy !== expectedCandidateMode
      : platformAuthenticity.policy !== "unsupported-preview" ||
        !(
          mode === "unsigned" ||
          (platform === "darwin" && mode === "ad-hoc") ||
          (platform === "win32" && mode === "self-signed")
        )
  ) {
    throw new Error("The platform authenticity support state is invalid.");
  }

  const signedMode =
    mode === "developer-id" ||
    mode === "authenticode" ||
    mode === "ad-hoc" ||
    mode === "self-signed";
  if (signedMode) {
    validateManifestTool(platform, platformAuthenticity.tool);
    validateFinalPublicIdentity(platform, mode, platformAuthenticity.publicIdentity);
  } else if (platformAuthenticity.tool !== null || platformAuthenticity.publicIdentity !== null) {
    throw new Error("An unsigned native authenticity policy cannot record a signing identity.");
  }

  const expectedVerification = platformAuthenticity.supportEligible
    ? mode === "publisher-only"
      ? "publisher-only"
      : "signed"
    : mode;
  for (let index = 0; index < expected.length; index += 1) {
    const component = platformAuthenticity.components[index];
    requireExactObject(
      component,
      ["kind", "path", "inputSha256", "sha256", "verification"],
      "platform-authenticated native component",
    );
    const nativeComponent = nativeComponents.components[index];
    if (
      component.kind !== nativeComponent.kind ||
      component.path !== nativeComponent.path ||
      typeof component.inputSha256 !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(component.inputSha256) ||
      component.sha256 !== nativeComponent.sha256 ||
      component.verification !== expectedVerification ||
      (!signedMode && component.inputSha256 !== component.sha256)
    ) {
      throw new Error("The native and platform authenticity manifests are not exactly bound.");
    }
  }

  let previousPath;
  let runtimeCount = 0;
  for (const component of platformAuthenticity.thirdPartyComponents) {
    requireExactObject(
      component,
      ["kind", "path", "inputSha256", "sha256", "verification", "publicIdentity"],
      "third-party native component",
    );
    if (
      (component.kind !== "bundled-node-runtime" && component.kind !== "bundled-native-library") ||
      !isPortableManifestPath(component.path) ||
      typeof component.inputSha256 !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(component.inputSha256) ||
      typeof component.sha256 !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(component.sha256) ||
      (previousPath !== undefined && previousPath >= component.path)
    ) {
      throw new Error("The third-party native component manifest is invalid.");
    }
    previousPath = component.path;
    if (component.kind === "bundled-node-runtime") {
      runtimeCount += 1;
      const expectedRuntimePath = platform === "win32" ? "runtime/node.exe" : "runtime/node";
      if (
        component.path !== expectedRuntimePath ||
        (signedMode
          ? component.verification !== "upstream-verified"
          : component.verification !== mode) ||
        component.inputSha256 !== component.sha256
      ) {
        throw new Error("The bundled Node runtime authenticity record is invalid.");
      }
      if (signedMode) {
        validateUpstreamPublicIdentity(platform, component.publicIdentity);
        if (platformAuthenticity.publicIdentity !== null) {
          assertDistinctProductAndUpstreamIdentities(
            platformAuthenticity.publicIdentity,
            component.publicIdentity,
          );
        }
      }
    } else {
      const expectedThirdPartyVerification = platformAuthenticity.supportEligible
        ? mode === "publisher-only"
          ? "publisher-only"
          : "resigned"
        : mode;
      if (component.verification !== expectedThirdPartyVerification) {
        throw new Error("A third-party native library has an invalid verification operation.");
      }
      if (component.publicIdentity !== null) {
        throw new Error(
          "A re-signed native library must reference the top-level product identity.",
        );
      }
    }
    if (!signedMode && component.publicIdentity !== null) {
      throw new Error("An unsigned third-party native component cannot record an identity.");
    }
    if (!signedMode && component.inputSha256 !== component.sha256) {
      throw new Error("An unsigned third-party native component cannot change its bytes.");
    }
  }
  if (runtimeCount !== 1) {
    throw new Error("The authenticity manifest must contain one bundled Node runtime.");
  }
}

function validateManifestTool(platform, value) {
  requireExactObject(value, ["name", "version", "sha256"], "platform signing tool record");
  if (
    value.name !== (platform === "darwin" ? "codesign" : "signtool") ||
    typeof value.version !== "string" ||
    value.version.length === 0 ||
    value.version.length > 200 ||
    hasControlCharacters(value.version) ||
    typeof value.sha256 !== "string" ||
    !sha256Pattern.test(value.sha256)
  ) {
    throw new Error("The platform signing tool record is invalid.");
  }
}

function validateUpstreamPublicIdentity(platform, value) {
  if (platform === "darwin") {
    validateFinalPublicIdentity(platform, "developer-id", value);
    return;
  }
  requireExactObject(value, ["type", "certificateSha1"], "upstream Windows public identity");
  if (
    value.type !== "windows-authenticode-upstream" ||
    typeof value.certificateSha1 !== "string" ||
    !windowsCertificatePattern.test(value.certificateSha1)
  ) {
    throw new Error("The upstream Windows public identity is invalid.");
  }
}

function isPortableManifestPath(value) {
  return (
    typeof value === "string" &&
    value !== "" &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.startsWith("/") &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function validateFinalPublicIdentity(platform, mode, value) {
  if (platform === "darwin") {
    if (mode === "ad-hoc") {
      if (value !== null) {
        throw new Error("A macOS ad-hoc final seal cannot declare a public identity.");
      }
      return;
    }
    requireExactObject(value, ["type", "selector", "teamId"], "final Apple public identity");
    if (
      value.type !== "apple-developer-id-application" ||
      typeof value.selector !== "string" ||
      !value.selector.startsWith("Developer ID Application: ") ||
      !teamIdPattern.test(value.teamId) ||
      !value.selector.endsWith(` (${value.teamId})`)
    ) {
      throw new Error("The final Apple Developer ID public identity is invalid.");
    }
    return;
  }
  requireExactObject(
    value,
    ["type", "certificateSha1", "store", "timestampUrl"],
    "final Windows public identity",
  );
  if (
    value.type !== "windows-authenticode" ||
    !windowsCertificatePattern.test(value.certificateSha1) ||
    (value.store !== "CurrentUser/My" && value.store !== "LocalMachine/My") ||
    requirePublicHttpsUrl(value.timestampUrl) !== value.timestampUrl
  ) {
    throw new Error("The final Windows Authenticode public identity is invalid.");
  }
}

function requireExactObject(value, keys, label) {
  const actual =
    value !== null && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key))
  ) {
    throw new Error(`The ${label} must contain only its canonical public fields.`);
  }
}

function deepFreezeJson(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) {
      deepFreezeJson(child);
    }
    Object.freeze(value);
  }
  return value;
}

function hasControlCharacters(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function requirePlatform(value) {
  if (!supportedPlatforms.has(value)) {
    throw new Error("Platform native authenticity uses an unsupported platform.");
  }
  return value;
}

function requireArchitecture(value) {
  if (!supportedArchitectures.has(value)) {
    throw new Error("Platform native authenticity uses an unsupported architecture.");
  }
  return value;
}

function requireSupportStatus(value) {
  if (value !== candidateStatus && !previewStatuses.has(value)) {
    throw new Error("Platform native authenticity uses an invalid support status.");
  }
  return value;
}

function requirePublicHttpsUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error("The RFC3161 timestamp URL is invalid.", { cause: error });
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      "The RFC3161 timestamp URL must be public HTTPS without credentials or query parameters.",
    );
  }
  return parsed.href;
}

async function requireRegularDirectory(path, label) {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) {
    throw new Error(`The ${label} must be an absolute path.`);
  }
  const lexicalPath = resolve(path);
  const [lexicalMetadata, canonicalPath] = await Promise.all([
    lstat(lexicalPath),
    realpath(lexicalPath),
  ]);
  const canonicalMetadata = await lstat(canonicalPath);
  if (
    !lexicalMetadata.isDirectory() ||
    lexicalMetadata.isSymbolicLink() ||
    !canonicalMetadata.isDirectory() ||
    canonicalMetadata.isSymbolicLink()
  ) {
    throw new Error(`The ${label} must be a regular directory.`);
  }
  return canonicalPath;
}

async function requireContainedRegularFile(root, portablePath) {
  const lexicalPath = join(root, ...portablePath.split("/"));
  const [canonicalPath, metadata] = await Promise.all([realpath(lexicalPath), lstat(lexicalPath)]);
  if (!metadata.isFile() || metadata.isSymbolicLink() || !isStrictDescendant(root, canonicalPath)) {
    throw new Error(`Native component ${portablePath} escaped the staging root.`);
  }
  return canonicalPath;
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

async function assertPathAbsent(path, label) {
  try {
    await lstat(path);
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(`The ${label} already exists before native authenticity is finalized.`);
}

async function assertExactJsonManifest(root, name, value) {
  const expected = `${JSON.stringify(value, null, 2)}\n`;
  const actual = await readFile(join(root, name), "utf8");
  if (actual !== expected) {
    throw new Error(`The frozen ${name} changed before final payload sealing.`);
  }
}

async function writeManifestPair(root, nativeComponents, platformAuthenticity) {
  const nativePath = join(root, "native-components.json");
  const authenticityPath = join(root, "platform-authenticity.json");
  let nativeCreated = false;
  let authenticityCreated = false;
  try {
    await writeExclusiveJson(nativePath, nativeComponents);
    nativeCreated = true;
    await writeExclusiveJson(authenticityPath, platformAuthenticity);
    authenticityCreated = true;
  } catch (error) {
    await Promise.allSettled([
      nativeCreated ? rm(nativePath, { force: true }) : undefined,
      authenticityCreated ? rm(authenticityPath, { force: true }) : undefined,
    ]);
    throw error;
  }
}

async function writeExclusiveJson(path, value) {
  const handle = await open(path, "wx", 0o644);
  let complete = false;
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    complete = true;
  } finally {
    await handle.close();
    if (!complete) {
      await rm(path, { force: true });
    }
  }
}

async function readPinnedPolicyBytes(path) {
  const inspected = await inspectStableRegularFile(
    path,
    maximumPolicyBytes,
    "platform-signing policy",
    true,
  );
  return inspected.bytes;
}

async function sha256StableFile(path, maximumBytes, label) {
  return (await inspectStableRegularFile(path, maximumBytes, label)).sha256;
}

async function inspectStableRegularFile(path, maximumBytes, label, includeBytes = false) {
  const lexicalPath = resolve(path);
  const before = await lstat(lexicalPath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`The ${label} must remain a regular non-linked file.`);
  }
  const canonicalPath = await realpath(lexicalPath);
  const noFollowFlag = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  const handle = await open(canonicalPath, fsConstants.O_RDONLY | noFollowFlag);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameFileState(before, opened) || opened.size <= 0n || opened.size > BigInt(maximumBytes)) {
      throw new Error(`The ${label} changed or has an unsupported size.`);
    }
    const size = Number(opened.size);
    const bytes = includeBytes ? await readExactOpenFile(handle, size, label) : undefined;
    const digest =
      bytes === undefined ? await hashExactOpenFile(handle, size, label) : sha256(bytes);
    const [after, finalPathMetadata, finalCanonicalPath] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(lexicalPath, { bigint: true }),
      realpath(lexicalPath),
    ]);
    if (
      !finalPathMetadata.isFile() ||
      finalPathMetadata.isSymbolicLink() ||
      comparablePath(finalCanonicalPath) !== comparablePath(canonicalPath) ||
      !sameFileState(opened, after) ||
      !sameFileState(after, finalPathMetadata)
    ) {
      bytes?.fill(0);
      throw new Error(`The ${label} changed while its exact bytes were inspected.`);
    }
    return {
      bytes,
      identity: freezeFileIdentity(after),
      path: canonicalPath,
      sha256: digest,
    };
  } finally {
    await handle.close();
  }
}

async function readExactOpenFile(handle, size, label) {
  const bytes = Buffer.alloc(size);
  let position = 0;
  while (position < size) {
    const { bytesRead } = await handle.read(
      bytes,
      position,
      Math.min(64 * 1024, size - position),
      position,
    );
    if (bytesRead <= 0) {
      bytes.fill(0);
      throw new Error(`The ${label} ended before its declared size.`);
    }
    position += bytesRead;
  }
  return bytes;
}

async function hashExactOpenFile(handle, size, label) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (position < size) {
    const requested = Math.min(buffer.byteLength, size - position);
    const { bytesRead } = await handle.read(buffer, 0, requested, position);
    if (bytesRead <= 0) {
      buffer.fill(0);
      throw new Error(`The ${label} ended before its declared size.`);
    }
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  buffer.fill(0);
  return hash.digest("hex");
}

function sameFileState(left, right) {
  return (
    (left.dev === 0n || right.dev === 0n || left.dev === right.dev) &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function freezeFileIdentity(metadata) {
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
  });
}

function sameRecordedFileIdentity(left, right) {
  return (
    left !== undefined &&
    right !== undefined &&
    (left.dev === 0n || right.dev === 0n || left.dev === right.dev) &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function comparablePath(path) {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
