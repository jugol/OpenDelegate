import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { mapMainListenerError, reportCliFailure, shutdownMainRuntime } from "../src/cli.ts";
import { MainArtifactRuntimeError, MainRuntimeError } from "../src/index.ts";
import {
  cleanupFailureFor,
  closeAfterPrimaryFailure,
  closeMainResources,
  MainShutdownError,
} from "../src/shutdown.ts";

test("shutdown listeners release a real child process after success and failure", async () => {
  const successful = await runShutdownChild("success");
  assert.equal(successful.code, 0);
  assert.equal(successful.signal, null);
  assert.match(successful.stdout, /"event":"main\.stopped"/u);
  assert.equal(successful.stderr, "");

  const failed = await runShutdownChild("failure");
  assert.equal(failed.code, 1);
  assert.equal(failed.signal, null);
  assert.doesNotMatch(failed.stdout, /"event":"main\.stopped"/u);
  assert.deepEqual(JSON.parse(failed.stderr), {
    level: "error",
    code: "SHUTDOWN_FAILED",
    message: "OpenDelegate could not shut down cleanly.",
  });
  assert.doesNotMatch(failed.stderr, /private spawned shutdown detail/u);
});

test("listener bind collisions retain a stable public startup code", () => {
  const bindFailure = Object.assign(new Error("private bind detail"), {
    code: "EADDRINUSE",
  });
  const wrapped = new Error("private framework wrapper", { cause: bindFailure });
  const mapped = mapMainListenerError(wrapped, "Main");

  assert.ok(mapped instanceof MainRuntimeError);
  assert.equal(mapped.code, "MAIN_LISTENER_UNAVAILABLE");
  assert.equal(mapped.message, "Main listener is unavailable.");
  assert.equal(mapped.cause, wrapped);
});

test("competing shutdown triggers close once and release resumed stdin", async () => {
  const raced = await runShutdownChild("race");
  assert.equal(raced.code, 0);
  assert.equal(raced.signal, null);
  assert.match(raced.stdout, /"event":"main\.stopped"/u);
  assert.match(raced.stdout, /"closeCount":1/u);
  assert.equal(raced.stderr, "");
});

test("successful shutdown settles every closer before reporting main.stopped", async () => {
  const closed: string[] = [];
  const output = await captureWrite(process.stdout, async () => {
    await shutdownMainRuntime(
      {
        close: async () => {
          closed.push("runtime");
        },
      },
      async () => {
        closed.push("claim");
      },
    );
  });

  assert.deepEqual(closed, ["runtime", "claim"]);
  assert.match(output, /"event":"main\.stopped"/u);
});

test("one shutdown failure still settles the remaining closer and omits main.stopped", async () => {
  const runtimeFailure = new Error("private database close detail");
  let claimClosed = false;
  const output = await captureWrite(process.stdout, async () => {
    await assert.rejects(
      shutdownMainRuntime(
        {
          close: async () => {
            throw runtimeFailure;
          },
        },
        async () => {
          claimClosed = true;
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof MainShutdownError);
        assert.deepEqual(error.operations, ["main-runtime"]);
        assert.deepEqual(error.errors, [runtimeFailure]);
        return true;
      },
    );
  });

  assert.equal(claimClosed, true);
  assert.doesNotMatch(output, /"event":"main\.stopped"/u);
});

test("cleanup preserves dependency order instead of closing repositories concurrently", async () => {
  let releaseIngress!: () => void;
  const ingressReleased = new Promise<void>((resolve) => {
    releaseIngress = resolve;
  });
  let repositoryCloseStarted = false;
  const closing = closeMainResources([
    {
      operation: "ingress",
      close: async () => {
        await ingressReleased;
      },
    },
    {
      operation: "repository",
      close: async () => {
        repositoryCloseStarted = true;
      },
    },
  ]);

  await Promise.resolve();
  assert.equal(repositoryCloseStarted, false);
  releaseIngress();
  await closing;
  assert.equal(repositoryCloseStarted, true);
});

test("sequential cleanup continues after a failed dependency close", async () => {
  const ingressFailure = new Error("private ingress close detail");
  const closed: string[] = [];
  await assert.rejects(
    closeMainResources([
      {
        operation: "ingress",
        close: async () => {
          closed.push("ingress");
          throw ingressFailure;
        },
      },
      {
        operation: "repository",
        close: async () => {
          closed.push("repository");
        },
      },
    ]),
    (error: unknown) => {
      assert.ok(error instanceof MainShutdownError);
      assert.deepEqual(error.operations, ["ingress"]);
      assert.deepEqual(error.errors, [ingressFailure]);
      return true;
    },
  );
  assert.deepEqual(closed, ["ingress", "repository"]);
});

test("multiple shutdown failures are aggregated and reported without private details", async () => {
  const runtimeFailure = new Error("private runtime close detail");
  const claimFailure = new Error("private claim close detail");
  let shutdownError: MainShutdownError | undefined;
  const output = await captureWrite(process.stdout, async () => {
    await assert.rejects(
      shutdownMainRuntime(
        {
          close: async () => {
            throw runtimeFailure;
          },
        },
        async () => {
          throw claimFailure;
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof MainShutdownError);
        shutdownError = error;
        assert.deepEqual(error.operations, ["main-runtime", "owner-claim-listener"]);
        assert.deepEqual(error.errors, [runtimeFailure, claimFailure]);
        return true;
      },
    );
  });
  assert.doesNotMatch(output, /"event":"main\.stopped"/u);
  assert.ok(shutdownError !== undefined);

  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const errorOutput = await captureWrite(process.stderr, () => {
      reportCliFailure(shutdownError);
    });
    assert.equal(process.exitCode, 1);
    assert.deepEqual(JSON.parse(errorOutput), {
      level: "error",
      code: "SHUTDOWN_FAILED",
      message: "OpenDelegate could not shut down cleanly.",
    });
    assert.doesNotMatch(errorOutput, /private runtime|private claim/u);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("cleanup failures remain reportable without mutating or replacing a frozen primary", async () => {
  const originalCause = new Error("Original primary cause.");
  const primary = Object.freeze(
    new MainRuntimeError("CONFIG_INVALID", "Primary startup failure.", {
      cause: originalCause,
    }),
  );
  const cleanupFailure = new Error("private cleanup detail");

  await assert.rejects(
    closeAfterPrimaryFailure(primary, [
      {
        operation: "main-runtime",
        close: async () => {
          throw cleanupFailure;
        },
      },
    ]),
    (error: unknown) => {
      assert.equal(error, primary);
      assert.equal(primary.cause, originalCause);
      const attachedCleanup = cleanupFailureFor(primary);
      assert.ok(attachedCleanup instanceof MainShutdownError);
      assert.deepEqual(attachedCleanup.operations, ["main-runtime"]);
      assert.deepEqual(attachedCleanup.errors, [cleanupFailure]);
      return true;
    },
  );

  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const errorOutput = await captureWrite(process.stderr, () => {
      reportCliFailure(primary);
    });
    assert.equal(process.exitCode, 1);
    assert.deepEqual(
      errorOutput
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as unknown),
      [
        {
          level: "error",
          code: "CONFIG_INVALID",
          message: "Primary startup failure.",
        },
        {
          level: "error",
          code: "SHUTDOWN_FAILED",
          message: "OpenDelegate could not shut down cleanly.",
        },
      ],
    );
    assert.doesNotMatch(errorOutput, /Original primary cause|private cleanup detail/u);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("a non-Error primary reports its cleanup failure separately without private details", async () => {
  const primary = "private primitive primary detail";
  const cleanupFailure = new Error("private primitive cleanup detail");
  let wrapper: AggregateError | undefined;

  await assert.rejects(
    closeAfterPrimaryFailure(primary, [
      {
        operation: "main-runtime",
        close: async () => {
          throw cleanupFailure;
        },
      },
    ]),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      wrapper = error;
      assert.equal(error.cause, primary);
      const attachedCleanup = cleanupFailureFor(error);
      assert.ok(attachedCleanup instanceof MainShutdownError);
      assert.deepEqual(attachedCleanup.operations, ["main-runtime"]);
      assert.deepEqual(attachedCleanup.errors, [cleanupFailure]);
      return true;
    },
  );
  assert.ok(wrapper !== undefined);

  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const errorOutput = await captureWrite(process.stderr, () => {
      reportCliFailure(wrapper);
    });
    assert.equal(process.exitCode, 1);
    assert.deepEqual(
      errorOutput
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as unknown),
      [
        {
          level: "error",
          code: "INTERNAL_ERROR",
          message: "OpenDelegate could not complete the command.",
        },
        {
          level: "error",
          code: "SHUTDOWN_FAILED",
          message: "OpenDelegate could not shut down cleanly.",
        },
      ],
    );
    assert.doesNotMatch(errorOutput, /private primitive primary|private primitive cleanup/u);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("Artifact startup failures retain their bounded public diagnostic", async () => {
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const errorOutput = await captureWrite(process.stderr, () => {
      reportCliFailure(
        new MainArtifactRuntimeError(
          "EXTERNAL_INGRESS_UNVERIFIED",
          "The static Artifact reverse proxy did not pass live external HTTPS verification.",
        ),
      );
    });
    assert.equal(process.exitCode, 1);
    assert.deepEqual(JSON.parse(errorOutput.trim()), {
      level: "error",
      code: "EXTERNAL_INGRESS_UNVERIFIED",
      message: "The static Artifact reverse proxy did not pass live external HTTPS verification.",
    });
  } finally {
    process.exitCode = previousExitCode;
  }
});

async function captureWrite(
  stream: NodeJS.WriteStream,
  action: () => Promise<void> | void,
): Promise<string> {
  const originalWrite = stream.write;
  let output = "";
  stream.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof stream.write;
  try {
    await action();
    return output;
  } finally {
    stream.write = originalWrite;
  }
}

interface ShutdownChildResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function runShutdownChild(
  mode: "success" | "failure" | "race",
): Promise<ShutdownChildResult> {
  const fixture = fileURLToPath(new URL("../test-fixtures/shutdown-child.ts", import.meta.url));
  const child = spawn(process.execPath, ["--experimental-strip-types", fixture, mode], {
    env: {
      ...process.env,
      NODE_NO_WARNINGS: "1",
      OPENDELEGATE_NATIVE_SERVICE: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const completed = new Promise<ShutdownChildResult>((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
  if (mode !== "race") {
    child.stdin.end();
  }

  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      completed,
      new Promise<never>((_resolvePromise, rejectPromise) => {
        timeout = setTimeout(() => {
          rejectPromise(new Error(`Shutdown child did not exit naturally in ${mode} mode.`));
        }, 5_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  }
}
