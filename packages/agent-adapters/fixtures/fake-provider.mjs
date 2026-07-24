// Executable child-process fixture; intentionally outside test discovery.
import { createInterface } from "node:readline";

const [, , provider, ...args] = process.argv;

if (args.includes("--version") || args.includes("-v")) {
  process.stdout.write(
    provider === "codex"
      ? "codex-cli 0.145.0\n"
      : provider === "claude"
        ? "2.1.205 (Claude Code)\n"
        : "generic-runner 3.4.5\n",
  );
  process.exit(0);
}

if (
  (provider === "codex" && args[0] === "login" && args[1] === "status") ||
  (provider === "claude" && args[0] === "auth" && args[1] === "status")
) {
  if (process.env.FIXTURE_SIGNED_OUT === "1") {
    process.exit(1);
  }
  process.stdout.write(provider === "claude" ? '{"loggedIn":true}\n' : "Logged in\n");
  process.exit(0);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let prompt = "";
for await (const line of input) {
  prompt += `${line}\n`;
}

if (provider === "codex") {
  process.stdout.write(
    `${JSON.stringify({ type: "thread.started", thread_id: "codex-session-1" })}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({
      type: "item.completed",
      item: { id: "item-1", type: "agent_message", text: `Finished: ${prompt.trim()}` },
    })}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 12, output_tokens: 7, cached_input_tokens: 2 },
    })}\n`,
  );
  process.exit(0);
}

if (provider === "claude") {
  const resumeIndex = args.indexOf("--resume");
  const sessionId =
    resumeIndex >= 0 && args[resumeIndex + 1] !== undefined
      ? args[resumeIndex + 1]
      : "11111111-1111-4111-8111-111111111111";
  process.stdout.write(
    `${JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: sessionId,
      cwd: process.cwd(),
    })}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Working" },
      },
    })}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: `Finished: ${prompt.trim()}` },
          { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } },
        ],
      },
    })}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: sessionId,
      result: `Finished: ${prompt.trim()}`,
      total_cost_usd: 0.0042,
      usage: { input_tokens: 20, output_tokens: 9, cache_read_input_tokens: 3 },
    })}\n`,
  );
  process.exit(0);
}

if (provider === "generic") {
  const envelope = JSON.parse(prompt);
  const sessionId =
    envelope.operation === "resume"
      ? envelope.session.nativeSessionId
      : envelope.continuation !== undefined
        ? "generic-session-continuation"
        : "generic-session-1";
  const event = (type, fields = {}) =>
    process.stdout.write(
      `${JSON.stringify({
        protocol: "opendelegate.agent-event.v1",
        type,
        ...fields,
      })}\n`,
    );
  event("session", { sessionId });
  if (envelope.prompt === "malformed") {
    process.stdout.write("this is not JSON\n");
    process.exit(0);
  }
  if (envelope.prompt === "oversized") {
    process.stdout.write(`${"x".repeat(20_000)}\n`);
    process.exit(0);
  }
  if (envelope.prompt === "slow") {
    setInterval(() => undefined, 1_000);
    await new Promise(() => undefined);
  }
  if (envelope.prompt === "flood") {
    for (let index = 0; index < 50; index += 1) {
      event("progress", { message: `event-${index}` });
    }
    event("result", { status: "succeeded", finalText: "flood complete" });
    process.exit(0);
  }
  if (envelope.prompt === "secret") {
    event("message", { text: `provider said ${process.env.FIXTURE_SECRET}` });
    process.stderr.write(`diagnostic ${process.env.FIXTURE_SECRET}\n`);
    event("result", { status: "succeeded", finalText: process.env.FIXTURE_SECRET });
    process.exit(0);
  }
  if (envelope.prompt === "exit-failure") {
    process.stderr.write(`failed with ${process.env.FIXTURE_SECRET ?? "no-secret"}\n`);
    process.exit(2);
  }
  if (envelope.prompt === "never-terminal") {
    process.exit(0);
  }
  event("progress", {
    message: `${envelope.operation}:${envelope.execution.sandbox}:${process.argv.includes("fixed-arg")}`,
  });
  event("approval_request", {
    requestId: "approval-1",
    actionType: "package.install",
    summary: "Install an official package",
    scope: { package: "ripgrep" },
  });
  event("message", { text: `Generic finished ${envelope.prompt}` });
  event("usage", { inputTokens: 4, outputTokens: 5 });
  event("result", { status: "succeeded", finalText: `Generic finished ${envelope.prompt}` });
  process.exit(0);
}

process.stderr.write(`unsupported fake provider: ${provider}\n`);
process.exit(2);
