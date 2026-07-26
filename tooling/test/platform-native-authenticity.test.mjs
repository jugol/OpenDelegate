import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  appendFile,
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { writeIntegrityManifests } from "../build-release.mjs";
import {
  createRealPlatformSigningRunner,
  finalizePlatformNativeAuthenticity,
  readPlatformAuthenticityPolicy,
  verifyFinalPlatformNativeAuthenticity,
} from "../platform-native-authenticity.mjs";
import { authorizeCredentialUse } from "../release-credential-authorization.mjs";
import { inspectBundleForPublisherSigning } from "../sign-release.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const authorizePlatformCredentialUse = (input) => authorizeCredentialUse(input);

test("candidate signing mutates every native component before exact manifests are frozen", async (t) => {
  const fixture = await createNativeFixture(t, "darwin", "arm64");
  const policy = await createMacPolicy(fixture, "developer-id");
  const policyInput = await createPinnedPolicyInput(fixture, policy);
  const signedPaths = [];
  const verifiedPaths = [];
  const runner = {
    async readToolVersion() {
      return policy.tool.version;
    },
    async signAndVerify(input) {
      signedPaths.push(input.relativePath);
      await appendFile(input.absolutePath, `signed:${input.relativePath}\n`, "utf8");
    },
    async verify(input) {
      verifiedPaths.push(input.relativePath);
      if (input.relativePath !== "runtime/node") {
        assert.match(await readFile(input.absolutePath, "utf8"), /signed:/u);
      }
    },
  };

  const result = await finalizePlatformNativeAuthenticity({
    architecture: "arm64",
    authorizeCredentialUse: authorizePlatformCredentialUse,
    nativeComponents: fixture.nativeComponents,
    platform: "darwin",
    policyInput,
    runner,
    stagingRoot: fixture.stagingRoot,
    supportStatus: "release-candidate",
  });

  assert.deepEqual(
    signedPaths.slice(0, fixture.nativeComponents.components.length),
    fixture.nativeComponents.components.map(({ path }) => path),
  );
  assert.equal(signedPaths.includes("apps/main/node_modules/native/addon.node"), true);
  assert.equal(result.platformAuthenticity.supportEligible, true);
  assert.equal(result.platformAuthenticity.status, "verified");
  assert.equal(result.platformAuthenticity.policy, "developer-id");
  assert.deepEqual(result.platformAuthenticity.tool, {
    name: "codesign",
    version: policy.tool.version,
    sha256: policy.tool.sha256,
  });
  assert.deepEqual(Object.keys(result.platformAuthenticity), [
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
  ]);
  assert.deepEqual(
    result.nativeComponents.components,
    result.platformAuthenticity.components.map(({ kind, path, sha256: digest }) => ({
      kind,
      path,
      sha256: digest,
    })),
  );
  for (const component of result.nativeComponents.components) {
    const bytes = await readFile(join(fixture.stagingRoot, ...component.path.split("/")));
    assert.match(bytes.toString("utf8"), /signed:/u);
    assert.equal(component.sha256, `sha256:${sha256(bytes)}`);
  }
  assert.equal(
    result.platformAuthenticity.components.every(
      ({ inputSha256, sha256: outputSha256 }) => inputSha256 !== outputSha256,
    ),
    true,
  );
  const runtimeRecord = result.platformAuthenticity.thirdPartyComponents.find(
    ({ kind }) => kind === "bundled-node-runtime",
  );
  const addonRecord = result.platformAuthenticity.thirdPartyComponents.find(
    ({ kind }) => kind === "bundled-native-library",
  );
  assert.equal(runtimeRecord.verification, "upstream-verified");
  assert.equal(runtimeRecord.inputSha256, runtimeRecord.sha256);
  assert.equal(addonRecord.verification, "resigned");
  assert.equal(addonRecord.publicIdentity, null);
  assert.notEqual(addonRecord.inputSha256, addonRecord.sha256);

  const nativeManifest = JSON.parse(
    await readFile(join(fixture.stagingRoot, "native-components.json"), "utf8"),
  );
  const authenticityManifest = JSON.parse(
    await readFile(join(fixture.stagingRoot, "platform-authenticity.json"), "utf8"),
  );
  assert.deepEqual(nativeManifest, result.nativeComponents);
  assert.deepEqual(authenticityManifest, result.platformAuthenticity);

  await verifyFinalPlatformNativeAuthenticity({
    ...result,
    policyInput,
    runner,
    stagingRoot: fixture.stagingRoot,
  });
  for (const path of [...signedPaths, "runtime/node"]) {
    assert.equal(
      verifiedPaths.filter((value) => value === path).length >= 2,
      true,
      `${path} was not reverified`,
    );
  }
});

test("candidate signing fails closed when its public allowlist is missing or unpinned", async (t) => {
  const fixture = await createNativeFixture(t, "darwin", "arm64");
  await assert.rejects(
    finalizePlatformNativeAuthenticity({
      architecture: "arm64",
      nativeComponents: fixture.nativeComponents,
      platform: "darwin",
      stagingRoot: fixture.stagingRoot,
      supportStatus: "release-candidate",
    }),
    /release candidates require an explicit platform-signing policy/u,
  );

  const policy = await createMacPolicy(fixture, "developer-id");
  const pinnedDigest = policy.tool.sha256;
  policy.tool.sha256 = "0".repeat(64);
  await assert.rejects(
    finalizePlatformNativeAuthenticity({
      architecture: "arm64",
      nativeComponents: fixture.nativeComponents,
      platform: "darwin",
      policyInput: await createPinnedPolicyInput(fixture, policy),
      runner: {
        async readToolVersion() {
          return policy.tool.version;
        },
        async signAndVerify() {
          assert.fail("An unpinned signing tool must not receive native bytes.");
        },
        async verify() {
          assert.fail("An unpinned signing tool must not verify native bytes.");
        },
      },
      stagingRoot: fixture.stagingRoot,
      supportStatus: "release-candidate",
    }),
    /digest does not match its allowlist/u,
  );
  await assertMissing(join(fixture.stagingRoot, "native-components.json"));
  await assertMissing(join(fixture.stagingRoot, "platform-authenticity.json"));

  policy.tool.sha256 = pinnedDigest;
  await assert.rejects(
    finalizePlatformNativeAuthenticity({
      architecture: "arm64",
      nativeComponents: fixture.nativeComponents,
      platform: "darwin",
      policyInput: await createPinnedPolicyInput(fixture, policy),
      runner: {
        async readToolVersion() {
          return "unexpected signer 9.9.9";
        },
        async signAndVerify() {
          assert.fail("A version-mismatched signing tool must not receive native bytes.");
        },
        async verify() {
          assert.fail("A version-mismatched signing tool must not verify native bytes.");
        },
      },
      stagingRoot: fixture.stagingRoot,
      supportStatus: "release-candidate",
    }),
    /version does not match its allowlist/u,
  );
});

test("every real signing-tool invocation is bounded by the pinned file identity", async (t) => {
  const fixture = await createNativeFixture(t, "darwin", "arm64");
  const policy = await createMacPolicy(fixture, "developer-id");
  const policyInput = await createPinnedPolicyInput(fixture, policy);
  const operations = [];
  const runner = createRealPlatformSigningRunner({
    execute: async (input) => {
      operations.push(input.operation);
      await appendFile(fixture.toolPath, "replaced-during-invocation\n", "utf8");
      return { stderr: "", stdout: policy.tool.version };
    },
  });

  await assert.rejects(
    finalizePlatformNativeAuthenticity({
      architecture: "arm64",
      nativeComponents: fixture.nativeComponents,
      platform: "darwin",
      policyInput,
      runner,
      stagingRoot: fixture.stagingRoot,
      supportStatus: "release-candidate",
    }),
    /changed across one invocation/u,
  );
  assert.deepEqual(operations, ["tool-version"]);
});

test("platform signing policies reject private credential fields and credential-bearing URLs", async (t) => {
  const macFixture = await createNativeFixture(t, "darwin", "arm64");
  const macPolicy = await createMacPolicy(macFixture, "developer-id");
  macPolicy.privateKey = "-----BEGIN PRIVATE KEY-----";
  await assert.rejects(
    finalizePlatformNativeAuthenticity({
      architecture: "arm64",
      nativeComponents: macFixture.nativeComponents,
      platform: "darwin",
      policyInput: await createPinnedPolicyInput(macFixture, macPolicy),
      stagingRoot: macFixture.stagingRoot,
      supportStatus: "release-candidate",
    }),
    /canonical public fields/u,
  );

  const windowsFixture = await createNativeFixture(t, "win32", "x64");
  const windowsPolicy = await createWindowsPolicy(windowsFixture, "authenticode");
  windowsPolicy.identity.timestampUrl =
    "https://release-user:release-password@timestamp.example.test/rfc3161";
  await assert.rejects(
    finalizePlatformNativeAuthenticity({
      architecture: "x64",
      nativeComponents: windowsFixture.nativeComponents,
      platform: "win32",
      policyInput: await createPinnedPolicyInput(windowsFixture, windowsPolicy),
      stagingRoot: windowsFixture.stagingRoot,
      supportStatus: "release-candidate",
    }),
    /without credentials/u,
  );

  windowsPolicy.identity.timestampUrl = "https://timestamp.example.test/rfc3161?token=PRIVATE";
  await assert.rejects(
    finalizePlatformNativeAuthenticity({
      architecture: "x64",
      nativeComponents: windowsFixture.nativeComponents,
      platform: "win32",
      policyInput: await createPinnedPolicyInput(windowsFixture, windowsPolicy),
      stagingRoot: windowsFixture.stagingRoot,
      supportStatus: "release-candidate",
    }),
    /without credentials or query parameters/u,
  );

  const ambiguousFixture = await createNativeFixture(t, "darwin", "arm64");
  const ambiguousPolicy = await createMacPolicy(ambiguousFixture, "developer-id");
  ambiguousPolicy.thirdParty.runtime.identity = {
    selector: ambiguousPolicy.identity.selector,
    teamId: ambiguousPolicy.identity.teamId,
  };
  await assert.rejects(
    finalizePlatformNativeAuthenticity({
      architecture: "arm64",
      nativeComponents: ambiguousFixture.nativeComponents,
      platform: "darwin",
      policyInput: await createPinnedPolicyInput(ambiguousFixture, ambiguousPolicy),
      stagingRoot: ambiguousFixture.stagingRoot,
      supportStatus: "release-candidate",
    }),
    /must be distinct/u,
  );
});

test("Linux records its publisher-only native policy without invoking a platform signer", async (t) => {
  const fixture = await createNativeFixture(t, "linux", "x64");
  const result = await finalizePlatformNativeAuthenticity({
    architecture: "x64",
    nativeComponents: fixture.nativeComponents,
    platform: "linux",
    runner: {
      async readToolVersion() {
        assert.fail("Linux has no platform-native signing tool in the first milestone.");
      },
      async signAndVerify() {
        assert.fail("Linux has no platform-native signature in the first milestone.");
      },
      async verify() {
        assert.fail("Linux has no platform-native signature in the first milestone.");
      },
    },
    stagingRoot: fixture.stagingRoot,
    supportStatus: "release-candidate",
  });

  assert.equal(result.platformAuthenticity.supportEligible, true);
  assert.equal(result.platformAuthenticity.status, "verified");
  assert.equal(result.platformAuthenticity.policy, "publisher-only");
  assert.equal(result.platformAuthenticity.tool, null);
  assert.equal(result.platformAuthenticity.publicIdentity, null);
  assert.equal(
    result.platformAuthenticity.components.every(
      ({ verification }) => verification === "publisher-only",
    ),
    true,
  );
  assert.equal(
    result.platformAuthenticity.thirdPartyComponents.every(
      ({ inputSha256, publicIdentity, sha256: outputSha256, verification: value }) =>
        inputSha256 === outputSha256 && publicIdentity === null && value === "publisher-only",
    ),
    true,
  );
});

test("unsupported previews explicitly remain unsigned and ineligible for promotion", async (t) => {
  const fixture = await createNativeFixture(t, "win32", "x64");
  const result = await finalizePlatformNativeAuthenticity({
    architecture: "x64",
    nativeComponents: fixture.nativeComponents,
    platform: "win32",
    stagingRoot: fixture.stagingRoot,
    supportStatus: "internal-preview-blocked",
  });

  assert.equal(result.platformAuthenticity.supportEligible, false);
  assert.equal(result.platformAuthenticity.status, "unsigned");
  assert.equal(result.platformAuthenticity.policy, "unsupported-preview");
  assert.equal(result.platformAuthenticity.tool, null);
  assert.equal(result.platformAuthenticity.publicIdentity, null);
  assert.equal(
    result.platformAuthenticity.components.every(({ verification }) => verification === "unsigned"),
    true,
  );
});

test("ad-hoc and self-signed preview mechanics remain explicitly support-ineligible", async (t) => {
  for (const [platform, mode] of [
    ["darwin", "ad-hoc"],
    ["win32", "self-signed"],
  ]) {
    const fixture = await createNativeFixture(t, platform, "x64");
    const policy =
      platform === "darwin"
        ? {
            ...(await createMacPolicy(fixture, mode)),
            identity: null,
          }
        : await createWindowsPolicy(fixture, mode);
    const result = await finalizePlatformNativeAuthenticity({
      architecture: "x64",
      authorizeCredentialUse: authorizePlatformCredentialUse,
      nativeComponents: fixture.nativeComponents,
      platform,
      policyInput: await createPinnedPolicyInput(fixture, policy),
      runner: {
        async readToolVersion() {
          return policy.tool.version;
        },
        async signAndVerify(input) {
          await appendFile(input.absolutePath, `${mode}\n`, "utf8");
        },
        async verify(input) {
          if (!input.relativePath.startsWith("runtime/node")) {
            assert.match(await readFile(input.absolutePath, "utf8"), new RegExp(mode, "u"));
          }
        },
      },
      stagingRoot: fixture.stagingRoot,
      supportStatus: "internal-preview-complete",
    });
    assert.equal(result.platformAuthenticity.supportEligible, false);
    assert.equal(result.platformAuthenticity.status, mode);
    assert.equal(result.platformAuthenticity.policy, "unsupported-preview");
    assert.equal(
      result.platformAuthenticity.components.every(({ verification }) => verification === mode),
      true,
    );
  }
});

test("external signing policy bytes are pre-pinned and remain stable through assembly", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-pinned-signing-policy-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const policyPath = join(root, "platform-signing-policy.json");
  const policy = {
    schemaVersion: 1,
    platform: "darwin",
    mode: "developer-id",
    tool: {
      path: join(root, "codesign"),
      version: "platform-signer 1.2.3",
      sha256: "a".repeat(64),
    },
    identity: {
      selector: "Developer ID Application: OpenDelegate (TEAM123456)",
      teamId: "TEAM123456",
    },
  };
  const bytes = Buffer.from(`${JSON.stringify(policy, null, 2)}\n`, "utf8");
  await writeFile(policyPath, bytes);

  const pinned = await readPlatformAuthenticityPolicy(policyPath, sha256(bytes));
  assert.deepEqual(pinned.policy, policy);
  assert.equal(pinned.sha256, sha256(bytes));
  assert.equal(Object.isFrozen(pinned.policy), true);
  assert.equal(Object.isFrozen(pinned.policy.identity), true);
  assert.throws(() => {
    pinned.policy.mode = "ad-hoc";
  }, /read only|Cannot assign/u);
  await pinned.verifyStable();

  await assert.rejects(
    readPlatformAuthenticityPolicy(policyPath, "0".repeat(64)),
    /digest does not match its pre-pinned SHA-256/u,
  );

  await appendFile(policyPath, " ", "utf8");
  await assert.rejects(pinned.verifyStable(), /changed while the release bundle was assembled/u);
});

test("external native policies cannot forge an opaque pinned policy input", async (t) => {
  const fixture = await createNativeFixture(t, "darwin", "arm64");
  const policy = await createMacPolicy(fixture, "developer-id");

  await assert.rejects(
    finalizePlatformNativeAuthenticity({
      architecture: "arm64",
      nativeComponents: fixture.nativeComponents,
      platform: "darwin",
      policyInput: {
        policy,
        sha256: sha256(Buffer.from('{"different":"policy"}\n', "utf8")),
      },
      stagingRoot: fixture.stagingRoot,
      supportStatus: "release-candidate",
    }),
    /opaque pre-pinned policy input/u,
  );
});

test("final native sealing rejects a component changed by packaged smoke", async (t) => {
  const fixture = await createNativeFixture(t, "darwin", "arm64");
  const policy = await createMacPolicy(fixture, "developer-id");
  const policyInput = await createPinnedPolicyInput(fixture, policy);
  const runner = {
    async readToolVersion() {
      return policy.tool.version;
    },
    async signAndVerify(input) {
      await appendFile(input.absolutePath, `signed:${input.relativePath}\n`, "utf8");
    },
    async verify() {},
  };
  const finalized = await finalizePlatformNativeAuthenticity({
    architecture: "arm64",
    authorizeCredentialUse: authorizePlatformCredentialUse,
    nativeComponents: fixture.nativeComponents,
    platform: "darwin",
    policyInput,
    runner,
    stagingRoot: fixture.stagingRoot,
    supportStatus: "release-candidate",
  });
  const changedPath = join(
    fixture.stagingRoot,
    ...fixture.nativeComponents.components[0].path.split("/"),
  );
  await appendFile(changedPath, "self-mutated-during-smoke\n", "utf8");

  await assert.rejects(
    verifyFinalPlatformNativeAuthenticity({
      ...finalized,
      policyInput,
      runner,
      stagingRoot: fixture.stagingRoot,
    }),
    /digest no longer matches its frozen native manifest/u,
  );
});

test("platform signing never invokes a signer after post-authorization component mutation", async (t) => {
  const fixture = await createNativeFixture(t, "darwin", "arm64");
  const policy = await createMacPolicy(fixture, "developer-id");
  const policyInput = await createPinnedPolicyInput(fixture, policy);
  const firstComponent = join(
    fixture.stagingRoot,
    ...fixture.nativeComponents.components[0].path.split("/"),
  );
  let signerInvocations = 0;
  let mutated = false;

  await assert.rejects(
    finalizePlatformNativeAuthenticity({
      architecture: "arm64",
      authorizeCredentialUse: async (input) => {
        const authorization = await authorizeCredentialUse(input);
        if (!mutated) {
          mutated = true;
          await appendFile(firstComponent, "changed-after-authorization\n", "utf8");
        }
        return authorization;
      },
      nativeComponents: fixture.nativeComponents,
      platform: "darwin",
      policyInput,
      runner: {
        async readToolVersion() {
          return policy.tool.version;
        },
        async signAndVerify() {
          signerInvocations += 1;
        },
        async verify() {},
      },
      stagingRoot: fixture.stagingRoot,
      supportStatus: "release-candidate",
    }),
    /changed before platform credential use/u,
  );
  assert.equal(signerInvocations, 0);
});

test("real macOS and Windows adapters use only public keychain or certificate-store selectors", async (t) => {
  const macFixture = await createNativeFixture(t, "darwin", "arm64");
  const windowsFixture = await createNativeFixture(t, "win32", "x64");
  const macTool = await createRunnerToolInput(macFixture.toolPath);
  const windowsTool = await createRunnerToolInput(windowsFixture.toolPath);
  const commands = [];
  const execute = async (input) => {
    commands.push(structuredClone(input));
    if (input.operation === "tool-version") {
      return { stderr: "", stdout: "platform-signer 1.2.3\n" };
    }
    if (input.operation === "macos-identity") {
      return {
        stderr: [
          "Authority=Developer ID Application: OpenDelegate (TEAM123456)",
          "TeamIdentifier=TEAM123456",
          "Timestamp=Jul 26, 2026",
          "flags=0x10000(runtime)",
          "",
        ].join("\n"),
        stdout: "",
      };
    }
    if (input.operation === "windows-verification") {
      return {
        stderr: "",
        stdout: `SHA1 hash: ${"A".repeat(40)}\nThe signature is timestamped: 2026-07-26\n`,
      };
    }
    return { stderr: "", stdout: "" };
  };
  const runner = createRealPlatformSigningRunner({ execute });
  const macIdentity = {
    type: "apple-developer-id-application",
    selector: "Developer ID Application: OpenDelegate (TEAM123456)",
    teamId: "TEAM123456",
  };
  await runner.signAndVerify({
    absolutePath: "/private/staging/opendelegate-service-host",
    mode: "developer-id",
    platform: "darwin",
    publicIdentity: macIdentity,
    ...macTool,
  });
  const windowsIdentity = {
    type: "windows-authenticode",
    certificateSha1: "A".repeat(40),
    store: "LocalMachine/My",
    timestampUrl: "https://timestamp.example.test/rfc3161",
  };
  await runner.signAndVerify({
    absolutePath: "C:\\staging\\opendelegate-service-host.exe",
    mode: "authenticode",
    platform: "win32",
    publicIdentity: windowsIdentity,
    ...windowsTool,
  });

  assert.deepEqual(commands[0].arguments, [
    "--force",
    "--options",
    "runtime",
    "--timestamp",
    "--sign",
    macIdentity.selector,
    "/private/staging/opendelegate-service-host",
  ]);
  assert.deepEqual(commands[1].arguments, [
    "--verify",
    "--strict",
    "--verbose=2",
    "/private/staging/opendelegate-service-host",
  ]);
  assert.deepEqual(commands[2].arguments, [
    "--display",
    "--verbose=4",
    "/private/staging/opendelegate-service-host",
  ]);
  assert.deepEqual(commands[3].arguments, [
    "sign",
    "/fd",
    "SHA256",
    "/sha1",
    windowsIdentity.certificateSha1,
    "/s",
    "My",
    "/sm",
    "/tr",
    windowsIdentity.timestampUrl,
    "/td",
    "SHA256",
    "C:\\staging\\opendelegate-service-host.exe",
  ]);
  assert.deepEqual(commands[4].arguments, [
    "verify",
    "/pa",
    "/all",
    "/tw",
    "/v",
    "C:\\staging\\opendelegate-service-host.exe",
  ]);
  assert.equal(
    commands.some(({ arguments: values }) =>
      values.some((value) => /^\/[fp]$/iu.test(value) || /password|private.?key/iu.test(value)),
    ),
    false,
  );
  assert.equal(
    commands.some(({ environment }) =>
      Object.keys(environment).some((name) =>
        /token|secret|password|private|credential/iu.test(name),
      ),
    ),
    false,
  );
});

test("a post-manifest native mutation invalidates the existing publisher inspection", async (t) => {
  const platform =
    process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";
  const fixture = await createNativeFixture(
    t,
    platform,
    process.arch === "arm64" ? "arm64" : "x64",
  );
  await finalizePlatformNativeAuthenticity({
    architecture: process.arch === "arm64" ? "arm64" : "x64",
    nativeComponents: fixture.nativeComponents,
    platform,
    stagingRoot: fixture.stagingRoot,
    supportStatus: "internal-preview-blocked",
  });
  await writePublisherInspectionFixture(fixture.stagingRoot, platform);
  await writeIntegrityManifests(fixture.stagingRoot);
  await inspectBundleForPublisherSigning(fixture.stagingRoot, {
    allowUnsupportedPreview: true,
  });

  const changedPath = join(
    fixture.stagingRoot,
    ...fixture.nativeComponents.components[0].path.split("/"),
  );
  await appendFile(changedPath, "post-manifest-mutation\n", "utf8");
  await assert.rejects(
    inspectBundleForPublisherSigning(fixture.stagingRoot, {
      allowUnsupportedPreview: true,
    }),
    /payload manifest does not match the exact release files/u,
  );
});

async function createNativeFixture(t, platform, architecture) {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-platform-authenticity-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const stagingRoot = join(root, "staging");
  await mkdir(join(stagingRoot, "bin"), { recursive: true });
  const suffix = platform === "win32" ? ".exe" : "";
  const components = [
    {
      kind: "core-service-host",
      path: `bin/opendelegate-service-host${suffix}`,
    },
    {
      kind: "session-helper-host",
      path: `bin/opendelegate-session-helper${suffix}`,
    },
  ];
  if (platform === "darwin") {
    components.push(
      {
        kind: "computer-use-helper",
        path: "libexec/opendelegate-macos-computer-use",
      },
      {
        kind: "computer-use-fixture",
        path: "libexec/opendelegate-macos-computer-use-fixture",
      },
      {
        kind: "secret-store-helper",
        path: "runtime/native/opendelegate-keychain-helper",
      },
    );
  } else if (platform === "linux") {
    components.push(
      {
        kind: "computer-use-helper",
        path: "libexec/opendelegate-linux-computer-use",
      },
      {
        kind: "computer-use-fixture",
        path: "libexec/opendelegate-linux-computer-use-fixture",
      },
    );
  } else {
    components.push(
      {
        kind: "computer-use-helper",
        path: "libexec/opendelegate-windows-computer-use-helper.exe",
      },
      {
        kind: "computer-use-fixture",
        path: "libexec/opendelegate-windows-computer-use-fixture.exe",
      },
    );
  }
  for (const component of components) {
    const path = join(stagingRoot, ...component.path.split("/"));
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, `${component.kind}\n`, { mode: 0o755 });
    if (process.platform !== "win32") {
      await chmod(path, 0o755);
    }
  }
  const runtimePath = platform === "win32" ? "runtime/node.exe" : "runtime/node";
  const nativeAddonPath = `apps/main/node_modules/native/addon.node`;
  for (const path of [runtimePath, nativeAddonPath]) {
    const absolutePath = join(stagingRoot, ...path.split("/"));
    await mkdir(join(absolutePath, ".."), { recursive: true });
    await writeFile(absolutePath, nativeFixtureBytes(platform), { mode: 0o755 });
  }
  const toolPath = join(root, platform === "win32" ? "signtool.exe" : "codesign");
  await writeFile(toolPath, "pinned tool\n", { mode: 0o755 });
  return {
    nativeComponents: {
      schemaVersion: 1,
      platform,
      architecture,
      components,
    },
    root,
    stagingRoot,
    toolPath,
  };
}

async function createMacPolicy(fixture, mode) {
  const toolBytes = await readFile(fixture.toolPath);
  return {
    schemaVersion: 1,
    platform: "darwin",
    mode,
    tool: {
      path: fixture.toolPath,
      version: "platform-signer 1.2.3",
      sha256: sha256(toolBytes),
    },
    identity: {
      selector: "Developer ID Application: OpenDelegate (TEAM123456)",
      teamId: "TEAM123456",
    },
    thirdParty: {
      runtime: {
        policy: "upstream-signed-pinned",
        identity: {
          selector: "Developer ID Application: Node.js Foundation (NODE123456)",
          teamId: "NODE123456",
        },
      },
      nativeLibraries: {
        policy: "resigned",
        entitlements: {
          mode: "none",
        },
      },
    },
  };
}

async function createWindowsPolicy(fixture, mode) {
  const toolBytes = await readFile(fixture.toolPath);
  return {
    schemaVersion: 1,
    platform: "win32",
    mode,
    tool: {
      path: fixture.toolPath,
      version: "platform-signer 1.2.3",
      sha256: sha256(toolBytes),
    },
    identity: {
      certificateSha1: "A".repeat(40),
      store: "CurrentUser/My",
      timestampUrl: "https://timestamp.example.test/rfc3161",
    },
    thirdParty: {
      runtime: {
        policy: "upstream-signed-pinned",
        identity: {
          certificateSha1: "B".repeat(40),
        },
      },
      nativeLibraries: {
        policy: "resigned",
        entitlements: null,
      },
    },
  };
}

function nativeFixtureBytes(platform) {
  if (platform === "linux") {
    return Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]);
  }
  if (platform === "darwin") {
    return Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]);
  }
  const bytes = Buffer.alloc(132);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(128, 0x3c);
  bytes.write("PE\0\0", 128, "binary");
  return bytes;
}

async function writePublisherInspectionFixture(root, platform) {
  await writeFile(
    join(root, "release-metadata.json"),
    `${JSON.stringify(
      {
        schemaVersion: 2,
        product: "OpenDelegate",
        productVersion: "0.1.0-alpha.1",
        platform,
        architecture: process.arch === "arm64" ? "arm64" : "x64",
        supportStatus: "internal-preview-blocked",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const checks = Object.fromEntries(
    [
      "cliHelp",
      "backupCliHelp",
      "serviceCliHelp",
      "cleanHomeInitialization",
      "mainHealth",
      "adminStaticApp",
      "loopbackOwnerClaim",
      "ownerLogin",
      "ownerSessionCookieContract",
      "ownerSessionRoundTrip",
    ].map((name) => [name, "passed"]),
  );
  checks.cleanShutdown = {
    status: "passed",
    markerObserved: true,
    naturalExit: true,
    exitCode: 0,
    shutdownTimedOut: false,
    forcedTermination: false,
  };
  await writeFile(
    join(root, "smoke-evidence.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        platform,
        architecture: process.arch === "arm64" ? "arm64" : "x64",
        productVersion: "0.1.0-alpha.1",
        checks,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function assertMissing(path) {
  await assert.rejects(access(path), (error) => error?.code === "ENOENT");
}

let policyInputSequence = 0;

async function createPinnedPolicyInput(fixture, policy) {
  const bytes = Buffer.from(`${JSON.stringify(policy, null, 2)}\n`, "utf8");
  const path = join(fixture.root, `platform-signing-policy-${policyInputSequence}.json`);
  policyInputSequence += 1;
  await writeFile(path, bytes);
  return await readPlatformAuthenticityPolicy(path, sha256(bytes));
}

async function createRunnerToolInput(path) {
  const [bytes, metadata] = await Promise.all([readFile(path), lstat(path, { bigint: true })]);
  return {
    toolIdentity: {
      dev: metadata.dev,
      ino: metadata.ino,
      size: metadata.size,
      mtimeNs: metadata.mtimeNs,
      ctimeNs: metadata.ctimeNs,
    },
    toolPath: path,
    toolSha256: sha256(bytes),
  };
}
