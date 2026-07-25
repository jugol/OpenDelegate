import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createMainProcessTestSecretContext } from "../test-fixtures/main-test-secrets.ts";

test("an unclaimed Main can reopen its local claim listener immediately after a crash", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-owner-claim-restart-"));
  const home = join(root, "home");
  const adminRoot = join(root, "admin-dist");
  await mkdir(join(adminRoot, "assets"), { recursive: true });
  await writeFile(
    join(adminRoot, "index.html"),
    '<!doctype html><title>OpenDelegate test shell</title><div id="root"></div>',
    "utf8",
  );
  await writeFile(join(adminRoot, "assets", "app.js"), "console.log('test');", "utf8");
  const mainSecrets = await createMainProcessTestSecretContext(root);
  const secretBackendConfigurationFile = join(root, "main-secret-backend.json");
  await writeFile(
    secretBackendConfigurationFile,
    `${JSON.stringify(mainSecrets.configuration)}\n`,
    { mode: 0o600 },
  );
  const port = await reserveAdjacentPortPair();
  const children = new Set<ChildProcessWithoutNullStreams>();

  t.after(async () => {
    await Promise.all([...children].map((child) => stopChild(child)));
    await rm(root, { force: true, recursive: true });
  });

  const first = startInit({
    home,
    adminRoot,
    port,
    secretBackendConfigurationFile,
    environment: mainSecrets.environment,
  });
  children.add(first.child);
  await waitForEvent(first, ["owner.claim.ready"]);
  const originalClaimToken = await readClaimToken(port + 1);
  await stopChild(first.child);
  children.delete(first.child);

  const restarted = startInit({
    home,
    adminRoot,
    port,
    secretBackendConfigurationFile,
    environment: mainSecrets.environment,
  });
  children.add(restarted.child);
  const event = await waitForEvent(restarted, ["owner.claim.ready", "owner.claim.pending"]);

  assert.equal(
    event,
    "owner.claim.ready",
    "a locally restarted, still-unclaimed Main must replace the now-unrecoverable claim and reopen the listener",
  );

  const replacementClaimToken = await readClaimToken(port + 1);
  assert.notEqual(replacementClaimToken, originalClaimToken);

  const abandoned = await submitClaim(port + 1, originalClaimToken);
  assert.equal(abandoned.status, 400);
  assert.equal((await abandoned.json()).code, "CLAIM_INVALID");

  const recovered = await submitClaim(port + 1, replacementClaimToken);
  assert.equal(recovered.status, 201);
  assert.equal((await recovered.json()).recoveryCodes.length, 10);
});

function startInit(input: {
  readonly home: string;
  readonly adminRoot: string;
  readonly port: number;
  readonly secretBackendConfigurationFile: string;
  readonly environment: Readonly<Record<string, string>>;
}): {
  readonly child: ChildProcessWithoutNullStreams;
  readonly output: () => string;
} {
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
      "init",
      "--home",
      input.home,
      "--admin-root",
      input.adminRoot,
      "--secret-backend-config",
      input.secretBackendConfigurationFile,
      "--listen-host",
      "127.0.0.1",
      "--listen-port",
      String(input.port),
      "--listen-origin",
      `http://127.0.0.1:${input.port}`,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...input.environment,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    output += chunk;
  });
  return {
    child,
    output: () => output,
  };
}

async function waitForEvent(
  process: {
    readonly child: ChildProcessWithoutNullStreams;
    readonly output: () => string;
  },
  events: readonly string[],
): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const output = process.output();
    for (const event of events) {
      if (output.includes(`"event":"${event}"`)) {
        return event;
      }
    }
    if (process.child.exitCode !== null) {
      throw new Error(`OpenDelegate init exited before the expected event.\n${output}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`Timed out waiting for ${events.join(" or ")}.\n${process.output()}`);
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGKILL");
  await once(child, "exit");
}

async function reserveAdjacentPortPair(): Promise<number> {
  const initialCandidate = 20_000 + ((process.pid * 37) % 19_000);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = 20_000 + ((initialCandidate - 20_000 + attempt * 2) % 19_000);
    const first = createServer();
    const adjacent = createServer();
    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        first.once("error", rejectPromise);
        first.listen(candidate, "127.0.0.1", resolvePromise);
      });
      await new Promise<void>((resolvePromise, rejectPromise) => {
        adjacent.once("error", rejectPromise);
        adjacent.listen(candidate + 1, "127.0.0.1", resolvePromise);
      });
      await Promise.all([closeServer(first), closeServer(adjacent)]);
      return candidate;
    } catch {
      await Promise.all([closeServer(first), closeServer(adjacent)]);
    }
  }
  throw new Error("Could not reserve adjacent loopback ports for the owner-claim test.");
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close((error) => (error === undefined ? resolvePromise() : rejectPromise(error)));
  });
}

async function readClaimToken(port: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200);
  const token = (await response.text()).match(/data-claim="([^"]+)"/u)?.[1];
  assert.ok(token);
  return token;
}

function submitClaim(port: number, claimToken: string): Promise<Response> {
  const origin = `http://127.0.0.1:${port}`;
  return fetch(`${origin}/api/v1/auth/claim`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({
      claimToken,
      passphrase: "correct horse battery staple",
    }),
    signal: AbortSignal.timeout(10_000),
  });
}
