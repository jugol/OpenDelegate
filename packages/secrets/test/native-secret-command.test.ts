import assert from "node:assert/strict";
import test from "node:test";

import { NodeNativeSecretCommandRunner, SecretError } from "../src/index.ts";

test("the native boundary transports Secret bytes only over bounded stdin and stdout", async () => {
  const runner = new NodeNativeSecretCommandRunner();
  const secret = Buffer.from("native-boundary-secret", "utf8");
  const result = await runner.run({
    args: ["-e", "process.stdin.pipe(process.stdout)"],
    environment: {},
    executable: process.execPath,
    maximumStdoutBytes: 128,
    stdin: secret,
    timeoutMs: 5_000,
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.stdout, secret);
  result.stdout.fill(0);
});

test("the native boundary discards hostile stderr and reports only stable failures", async () => {
  const runner = new NodeNativeSecretCommandRunner();
  const secret = "stderr-secret-value";
  const nonzero = await runner.run({
    args: [
      "-e",
      "const c=[];process.stdin.on('data',(v)=>c.push(v));process.stdin.on('end',()=>{process.stderr.write(Buffer.concat(c));process.exit(19)})",
    ],
    environment: {},
    executable: process.execPath,
    maximumStdoutBytes: 16,
    stdin: Buffer.from(secret, "utf8"),
    timeoutMs: 5_000,
  });
  assert.deepEqual(nonzero, { exitCode: 19, stdout: Buffer.alloc(0) });
  assert.equal(JSON.stringify(nonzero).includes(secret), false);

  await assert.rejects(
    runner.run({
      args: ["-e", "process.stdout.write('x'.repeat(1024))"],
      environment: {},
      executable: process.execPath,
      maximumStdoutBytes: 8,
      stdin: new Uint8Array(),
      timeoutMs: 5_000,
    }),
    (error: unknown) => {
      assert.ok(error instanceof SecretError);
      assert.equal(error.code, "SECRET_STORE_ACCESS_FAILED");
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
});

test("the native boundary terminates helpers that exceed the configured timeout", async () => {
  const runner = new NodeNativeSecretCommandRunner();
  const startedAt = Date.now();

  await assert.rejects(
    runner.run({
      args: ["-e", "process.on('SIGTERM',()=>undefined);setInterval(()=>undefined,1_000)"],
      environment: {},
      executable: process.execPath,
      maximumStdoutBytes: 0,
      stdin: new Uint8Array(),
      timeoutMs: 50,
    }),
    (error: unknown) => {
      assert.ok(error instanceof SecretError);
      assert.equal(error.code, "SECRET_STORE_ACCESS_FAILED");
      return true;
    },
  );

  assert.ok(Date.now() - startedAt < 5_000);
});
