import assert from "node:assert/strict";
import { link, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { PlatformMutationProcessRequest } from "@opendelegate/platform-services";

import { createWorkerPlatformMutationSafetyBoundary } from "../src/platform-mutation-safety-boundary.ts";

const NPM_PREFIX = [
  "install",
  "--save-exact",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  "--registry=https://registry.npmjs.org/",
] as const;

test("automatic npm preflight uses a fresh credential-free home and accepts only registry data", async () => {
  const fixture = await createFixture();
  const privateSentinel = "DATABASE_PASSWORD_DEVICE_LOCAL_SENTINEL";
  const boundary = await createWorkerPlatformMutationSafetyBoundary({
    stateDirectory: fixture.state,
    sourceCheckoutRoot: fixture.checkout,
    executablePaths: [process.execPath],
    environment: {
      HOME: privateSentinel,
      USERPROFILE: privateSentinel,
      DATABASE_URL: `postgresql://${privateSentinel}@database.invalid/main`,
      NPM_CONFIG_USERCONFIG: join(fixture.root, "attacker-npmrc"),
      SystemRoot: process.env["SystemRoot"],
    },
  });
  const isolatedHome = boundary.environment["HOME"];
  try {
    assert.equal(JSON.stringify(boundary.environment).includes(privateSentinel), false);
    assert.equal(boundary.environment["NPM_CONFIG_IGNORE_SCRIPTS"], "true");
    assert.equal(boundary.environment["NPM_CONFIG_REGISTRY"], "https://registry.npmjs.org/");
    assert.ok(isolatedHome?.startsWith(fixture.state));

    await writeFile(
      join(fixture.workspace, "package.json"),
      `${JSON.stringify({
        name: "safe-project",
        version: "1.0.0",
        packageManager: "npm@11.6.2",
        dependencies: { hono: "^4.10.0" },
        scripts: { preinstall: "node should-never-run.cjs" },
      })}\n`,
      "utf8",
    );
    await writeFile(
      join(fixture.workspace, "package-lock.json"),
      `${JSON.stringify({
        name: "safe-project",
        lockfileVersion: 3,
        packages: {
          "": { version: "1.0.0" },
          "node_modules/hono": {
            version: "4.10.0",
            resolved: "https://registry.npmjs.org/hono/-/hono-4.10.0.tgz",
            integrity: "sha512-fixture",
          },
        },
      })}\n`,
      "utf8",
    );

    await boundary.processPreflight.assertSafe(npmRequest(fixture.workspace));
  } finally {
    await boundary.close();
    await assert.rejects(lstat(isolatedHome ?? ""), { code: "ENOENT" });
    await fixture.close();
  }
});

test("workspace package-manager config and non-registry dependency inputs fail before spawn", async () => {
  const fixture = await createFixture();
  const marker = join(fixture.root, "workspace-hook-ran");
  const boundary = await createWorkerPlatformMutationSafetyBoundary({
    stateDirectory: fixture.state,
    sourceCheckoutRoot: fixture.checkout,
    executablePaths: [process.execPath],
    environment: { SystemRoot: process.env["SystemRoot"] },
  });
  try {
    await writeFile(
      join(fixture.workspace, "package.json"),
      `${JSON.stringify({ name: "unsafe-project", version: "1.0.0" })}\n`,
      "utf8",
    );
    await writeFile(
      join(fixture.workspace, ".npmrc"),
      `onload-script=${join(fixture.workspace, "write-marker.cjs")}\n# ${marker}\n`,
      "utf8",
    );
    await assert.rejects(boundary.processPreflight.assertSafe(npmRequest(fixture.workspace)), {
      code: "MUTATION_REQUEST_INVALID",
    });
    await assert.rejects(lstat(marker), { code: "ENOENT" });

    await rm(join(fixture.workspace, ".npmrc"));
    await writeFile(
      join(fixture.workspace, "package.json"),
      `${JSON.stringify({
        name: "unsafe-project",
        version: "1.0.0",
        dependencies: { private: "file:C:/device-local/Knowledge" },
      })}\n`,
      "utf8",
    );
    await assert.rejects(boundary.processPreflight.assertSafe(npmRequest(fixture.workspace)), {
      code: "MUTATION_REQUEST_INVALID",
    });
    await writeFile(
      join(fixture.workspace, "package.json"),
      `${JSON.stringify({
        name: "unsafe-project",
        version: "1.0.0",
        dependencies: { private: ".." },
      })}\n`,
      "utf8",
    );
    await assert.rejects(
      boundary.processPreflight.assertSafe({
        ...npmRequest(fixture.workspace),
        commandId: "command-package-boundary-relative-dependency",
      }),
      { code: "MUTATION_REQUEST_INVALID" },
    );
  } finally {
    await boundary.close();
    await fixture.close();
  }
});

test("npm executes only against a sealed private snapshot and promotes a validated tree", async () => {
  const fixture = await createFixture();
  const marker = join(fixture.root, "lifecycle-marker");
  const boundary = await createWorkerPlatformMutationSafetyBoundary({
    stateDirectory: fixture.state,
    sourceCheckoutRoot: fixture.checkout,
    executablePaths: [process.execPath],
    environment: { SystemRoot: process.env["SystemRoot"] },
  });
  const request = npmRequest(fixture.workspace);
  try {
    await writeFile(
      join(fixture.workspace, "package.json"),
      `${JSON.stringify({
        name: "sealed-project",
        version: "1.0.0",
        scripts: { preinstall: `node -e "require('fs').writeFileSync('${marker}','ran')"` },
      })}\n`,
      "utf8",
    );
    await mkdir(join(fixture.workspace, "node_modules", "old-package"), {
      recursive: true,
    });
    await writeFile(join(fixture.workspace, "node_modules", "old-package", "index.js"), "old\n");

    await boundary.processPreflight.assertSafe(request);
    await boundary.processPreflight.assertSafe(request);
    const runner = boundary.wrapProcessRunner({
      async run(stagedRequest) {
        assert.notEqual(stagedRequest.workingDirectory, fixture.workspace);
        assert.ok(stagedRequest.workingDirectory?.startsWith(fixture.state));
        const staging = stagedRequest.workingDirectory ?? "";
        await writeFile(
          join(staging, "package.json"),
          `${JSON.stringify({
            name: "sealed-project",
            version: "1.0.0",
            dependencies: { hono: "4.10.0" },
            scripts: { preinstall: "withheld-and-disabled" },
          })}\n`,
          "utf8",
        );
        await writeFile(
          join(staging, "package-lock.json"),
          `${JSON.stringify({
            name: "sealed-project",
            lockfileVersion: 3,
            packages: {
              "": { version: "1.0.0", dependencies: { hono: "4.10.0" } },
              "node_modules/hono": {
                version: "4.10.0",
                resolved: "https://registry.npmjs.org/hono/-/hono-4.10.0.tgz",
              },
            },
          })}\n`,
          "utf8",
        );
        await mkdir(join(staging, "node_modules", "hono"), { recursive: true });
        await writeFile(join(staging, "node_modules", "hono", "index.js"), "export {};\n");
        return { exitCode: 0, signal: null };
      },
    });
    assert.deepEqual(await runner.run(request), { exitCode: 0, signal: null });
    assert.match(await readFile(join(fixture.workspace, "package.json"), "utf8"), /"hono"/u);
    assert.equal(
      await readFile(join(fixture.workspace, "node_modules", "hono", "index.js"), "utf8"),
      "export {};\n",
    );
    await assert.rejects(lstat(join(fixture.workspace, "node_modules", "old-package")), {
      code: "ENOENT",
    });
    await assert.rejects(lstat(marker), { code: "ENOENT" });
  } finally {
    await boundary.close();
    await fixture.close();
  }
});

test("a workspace swap after sealed staging aborts promotion and hardlinked manifests are rejected", async () => {
  const fixture = await createFixture();
  const boundary = await createWorkerPlatformMutationSafetyBoundary({
    stateDirectory: fixture.state,
    sourceCheckoutRoot: fixture.checkout,
    executablePaths: [process.execPath],
    environment: { SystemRoot: process.env["SystemRoot"] },
  });
  try {
    await writeFile(
      join(fixture.workspace, "package.json"),
      `${JSON.stringify({ name: "race-project", version: "1.0.0" })}\n`,
      "utf8",
    );
    const request = {
      ...npmRequest(fixture.workspace),
      commandId: "command-package-boundary-race",
    };
    await boundary.processPreflight.assertSafe(request);
    await boundary.processPreflight.assertSafe(request);
    await writeFile(join(fixture.workspace, ".npmrc"), "registry=https://attacker.invalid/\n");
    const runner = boundary.wrapProcessRunner({
      async run(stagedRequest) {
        const staging = stagedRequest.workingDirectory ?? "";
        await writeFile(
          join(staging, "package.json"),
          `${JSON.stringify({ name: "race-project", version: "1.0.0", dependencies: { hono: "4.10.0" } })}\n`,
        );
        await writeFile(
          join(staging, "package-lock.json"),
          `${JSON.stringify({ lockfileVersion: 3, packages: { "": { version: "1.0.0" } } })}\n`,
        );
        await mkdir(join(staging, "node_modules"), { recursive: true });
        return { exitCode: 0, signal: null };
      },
    });
    await assert.rejects(runner.run(request), { code: "MUTATION_REQUEST_INVALID" });
    assert.equal(
      JSON.parse(await readFile(join(fixture.workspace, "package.json"), "utf8")).dependencies,
      undefined,
    );

    await rm(join(fixture.workspace, ".npmrc"));
    const externalManifest = join(fixture.root, "external-package.json");
    await writeFile(
      externalManifest,
      `${JSON.stringify({ name: "hardlink-project", version: "1.0.0" })}\n`,
    );
    await rm(join(fixture.workspace, "package.json"));
    await link(externalManifest, join(fixture.workspace, "package.json"));
    await assert.rejects(
      boundary.processPreflight.assertSafe({
        ...npmRequest(fixture.workspace),
        commandId: "command-package-boundary-hardlink",
      }),
      { code: "MUTATION_REQUEST_INVALID" },
    );
  } finally {
    await boundary.close();
    await fixture.close();
  }
});

test("foreign lockfile origins, hook-capable managers, and unverified system sources fail closed", async () => {
  const fixture = await createFixture();
  const boundary = await createWorkerPlatformMutationSafetyBoundary({
    stateDirectory: fixture.state,
    sourceCheckoutRoot: fixture.checkout,
    executablePaths: [process.execPath],
    environment: { SystemRoot: process.env["SystemRoot"] },
  });
  try {
    await writeFile(
      join(fixture.workspace, "package.json"),
      `${JSON.stringify({ name: "unsafe-lock", version: "1.0.0" })}\n`,
      "utf8",
    );
    await writeFile(
      join(fixture.workspace, "package-lock.json"),
      `${JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { version: "1.0.0" },
          "node_modules/private": {
            version: "1.0.0",
            resolved: "https://attacker.invalid/exfiltrate.tgz",
          },
        },
      })}\n`,
      "utf8",
    );
    await assert.rejects(boundary.processPreflight.assertSafe(npmRequest(fixture.workspace)), {
      code: "MUTATION_REQUEST_INVALID",
    });
    await rm(join(fixture.workspace, "package-lock.json"));
    await assert.rejects(
      boundary.processPreflight.assertSafe({
        ...npmRequest(fixture.workspace),
        executableId: "yarn",
        arguments: ["add", "--ignore-scripts", "hono"],
      }),
      { code: "MUTATION_REQUEST_INVALID" },
    );
    await assert.rejects(
      boundary.processPreflight.assertSafe({
        ...npmRequest(fixture.workspace),
        commandId: "command-package-boundary-option-override",
        arguments: [...NPM_PREFIX, "hono", "--prefix=C:/device-local/Knowledge"],
      }),
      { code: "MUTATION_REQUEST_INVALID" },
    );
    await assert.rejects(
      boundary.processPreflight.assertSafe({
        ...npmRequest(fixture.workspace),
        commandId: "command-package-boundary-relative-spec",
        arguments: [...NPM_PREFIX, ".."],
      }),
      { code: "MUTATION_REQUEST_INVALID" },
    );
    await assert.rejects(boundary.processPreflight.assertSafe(systemRequest()), {
      code: "MUTATION_REQUEST_INVALID",
    });
  } finally {
    await boundary.close();
    await fixture.close();
  }
});

test("a configured system manager remains automatic only after exact local source verification", async () => {
  const fixture = await createFixture();
  const observations: Array<{ readonly executable: string; readonly manager: string }> = [];
  const boundary = await createWorkerPlatformMutationSafetyBoundary({
    stateDirectory: fixture.state,
    sourceCheckoutRoot: fixture.checkout,
    executablePaths: [process.execPath],
    environment: { SystemRoot: process.env["SystemRoot"] },
    systemPackageSourceVerifier: {
      async verify(input) {
        observations.push(input);
        return input.manager === "apt-get" && input.executable === "/usr/bin/apt-get";
      },
    },
  });
  try {
    await boundary.processPreflight.assertSafe(systemRequest());
    assert.deepEqual(observations, [{ executable: "/usr/bin/apt-get", manager: "apt-get" }]);
  } finally {
    await boundary.close();
    await fixture.close();
  }
});

function npmRequest(workspace: string): PlatformMutationProcessRequest {
  return {
    commandId: "command-package-boundary-0001",
    actionCategory: "project-dependency-install",
    executableId: "npm",
    executable: process.execPath,
    arguments: [...NPM_PREFIX, "hono@4.10.0"],
    workingDirectory: workspace,
    signal: new AbortController().signal,
  };
}

function systemRequest(): PlatformMutationProcessRequest {
  return {
    commandId: "command-system-boundary-0001",
    actionCategory: "configured-official-package-install",
    executableId: "apt-get",
    executable: "/usr/bin/apt-get",
    arguments: ["install", "-y", "--no-install-recommends", "ripgrep"],
    signal: new AbortController().signal,
  };
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-package-boundary-"));
  const checkout = join(root, "checkout");
  const state = join(root, "runtime", "state");
  const workspace = join(root, "workspace");
  await Promise.all([
    mkdir(checkout, { recursive: true }),
    mkdir(state, { recursive: true }),
    mkdir(workspace, { recursive: true }),
  ]);
  return {
    root,
    checkout,
    state,
    workspace,
    close: () => rm(root, { recursive: true, force: true }),
  };
}
