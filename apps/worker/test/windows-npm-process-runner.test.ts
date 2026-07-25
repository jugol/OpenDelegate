import assert from "node:assert/strict";
import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  createNodePlatformMutationProcessRunner,
  type PlatformMutationProcessRequest,
} from "@opendelegate/platform-services";

import { createPinnedWindowsNpmProcessRunner } from "../src/windows-npm-process-runner.ts";
import { createWorkerPlatformMutationSafetyBoundary } from "../src/platform-mutation-safety-boundary.ts";

const NPM_ARGUMENTS = [
  "install",
  "--save-exact",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  "--registry=https://registry.npmjs.org/",
  "is-number@7.0.0",
] as const;

test("the Windows npm boundary launches the pinned Node CLI without cmd or a shell", async () => {
  const fixture = await createFixture();
  try {
    const runner = await createPinnedWindowsNpmProcessRunner({
      npmCommandPath: fixture.npmCommand,
      runner: createNodePlatformMutationProcessRunner({
        environment: {
          ...process.env,
          OPENDELEGATE_NPM_LAUNCH_MARKER: fixture.marker,
        },
      }),
    });
    const result = await runner.run(request(fixture));

    assert.deepEqual(result, { exitCode: 0, signal: null });
    assert.deepEqual(JSON.parse(await readFile(fixture.marker, "utf8")), NPM_ARGUMENTS);
  } finally {
    await fixture.close();
  }
});

test("the Windows npm boundary rejects a changed CLI at the final process seam", async () => {
  const fixture = await createFixture();
  try {
    const runner = await createPinnedWindowsNpmProcessRunner({
      npmCommandPath: fixture.npmCommand,
      runner: createNodePlatformMutationProcessRunner({
        environment: {
          ...process.env,
          OPENDELEGATE_NPM_LAUNCH_MARKER: fixture.marker,
        },
      }),
    });
    await writeFile(fixture.npmCli, "process.exitCode = 23;\n", "utf8");

    await assert.rejects(runner.run(request(fixture)), {
      code: "MUTATION_REQUEST_INVALID",
    });
    await assert.rejects(readFile(fixture.marker), { code: "ENOENT" });
  } finally {
    await fixture.close();
  }
});

test("the Windows npm boundary rejects a changed Node executable at the final process seam", async () => {
  const fixture = await createFixture();
  try {
    const runner = await createPinnedWindowsNpmProcessRunner({
      npmCommandPath: fixture.npmCommand,
      runner: createNodePlatformMutationProcessRunner({
        environment: {
          ...process.env,
          OPENDELEGATE_NPM_LAUNCH_MARKER: fixture.marker,
        },
      }),
    });
    await appendFile(fixture.nodeExecutable, Buffer.from([0]));

    await assert.rejects(runner.run(request(fixture)), {
      code: "MUTATION_REQUEST_INVALID",
    });
    await assert.rejects(readFile(fixture.marker), { code: "ENOENT" });
  } finally {
    await fixture.close();
  }
});

test("the Windows npm boundary cannot be reused for a system-package action", async () => {
  const fixture = await createFixture();
  try {
    const runner = await createPinnedWindowsNpmProcessRunner({
      npmCommandPath: fixture.npmCommand,
      runner: createNodePlatformMutationProcessRunner({
        environment: {
          ...process.env,
          OPENDELEGATE_NPM_LAUNCH_MARKER: fixture.marker,
        },
      }),
    });

    await assert.rejects(
      runner.run({
        ...request(fixture),
        actionCategory: "configured-official-package-install",
      }),
      { code: "MUTATION_REQUEST_INVALID" },
    );
    await assert.rejects(readFile(fixture.marker), { code: "ENOENT" });
  } finally {
    await fixture.close();
  }
});

test(
  "the real Windows Node installation performs an isolated shell-free npm install",
  {
    skip: process.platform !== "win32" || process.env["OPENDELEGATE_WINDOWS_NPM_SMOKE"] !== "1",
    timeout: 120_000,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "opendelegate-real-windows-npm-"));
    const checkout = join(root, "checkout");
    const state = join(root, "state");
    const workspace = join(root, "workspace");
    const npmCommand = join(dirname(process.execPath), "npm.cmd");
    await Promise.all([mkdir(checkout), mkdir(state), mkdir(workspace)]);
    await writeFile(
      join(workspace, "package.json"),
      `${JSON.stringify({ name: "opendelegate-npm-smoke", version: "1.0.0", private: true })}\n`,
      "utf8",
    );
    const boundary = await createWorkerPlatformMutationSafetyBoundary({
      stateDirectory: state,
      sourceCheckoutRoot: checkout,
      environment: process.env,
      executablePaths: [npmCommand],
    });
    const installRequest: PlatformMutationProcessRequest = {
      commandId: "windows-npm-real-smoke",
      actionCategory: "project-dependency-install",
      executableId: "npm",
      executable: npmCommand,
      arguments: NPM_ARGUMENTS,
      workingDirectory: workspace,
      signal: new AbortController().signal,
    };
    try {
      const runner = boundary.wrapProcessRunner(
        await createPinnedWindowsNpmProcessRunner({
          npmCommandPath: npmCommand,
          runner: createNodePlatformMutationProcessRunner({
            environment: boundary.environment,
          }),
        }),
      );
      await boundary.processPreflight.assertSafe(installRequest);
      await boundary.processPreflight.assertSafe(installRequest);
      assert.deepEqual(await runner.run(installRequest), {
        exitCode: 0,
        signal: null,
      });
      const manifest = JSON.parse(await readFile(join(workspace, "package.json"), "utf8")) as {
        readonly dependencies?: Readonly<Record<string, string>>;
      };
      assert.equal(manifest.dependencies?.["is-number"], "7.0.0");
      const installed = JSON.parse(
        await readFile(join(workspace, "node_modules", "is-number", "package.json"), "utf8"),
      ) as { readonly name?: string; readonly version?: string };
      assert.deepEqual(
        { name: installed.name, version: installed.version },
        { name: "is-number", version: "7.0.0" },
      );
    } finally {
      await boundary.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

function request(
  fixture: Awaited<ReturnType<typeof createFixture>>,
): PlatformMutationProcessRequest {
  return {
    commandId: "windows-npm-launcher-test",
    actionCategory: "project-dependency-install",
    executableId: "npm",
    executable: fixture.npmCommand,
    arguments: NPM_ARGUMENTS,
    workingDirectory: fixture.workspace,
    signal: new AbortController().signal,
  };
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-windows-npm-launcher-"));
  const installation = join(root, "node-installation");
  const npmCommand = join(installation, "npm.cmd");
  const nodeExecutable = join(installation, "node.exe");
  const npmCli = join(installation, "node_modules", "npm", "bin", "npm-cli.js");
  const workspace = join(root, "workspace");
  const marker = join(root, "launched.json");
  await Promise.all([
    mkdir(join(installation, "node_modules", "npm", "bin"), { recursive: true }),
    mkdir(workspace),
  ]);
  await Promise.all([
    writeFile(npmCommand, "@echo off\r\nexit /b 97\r\n", "utf8"),
    copyFile(process.execPath, nodeExecutable),
    writeFile(
      npmCli,
      [
        'const { writeFileSync } = require("node:fs");',
        "writeFileSync(process.env.OPENDELEGATE_NPM_LAUNCH_MARKER, JSON.stringify(process.argv.slice(2)));",
        "",
      ].join("\n"),
      "utf8",
    ),
  ]);
  if (process.platform !== "win32") {
    await chmod(nodeExecutable, 0o700);
  }
  return {
    root,
    marker,
    nodeExecutable,
    npmCli,
    npmCommand,
    workspace,
    close: () => rm(root, { recursive: true, force: true }),
  };
}
