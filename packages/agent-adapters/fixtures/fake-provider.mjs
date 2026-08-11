// Executable child-process fixture; intentionally outside test discovery.
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const [, , provider, ...args] = process.argv;
const fixtureFilename = fileURLToPath(import.meta.url);

if (
  provider === "codex" &&
  process.env.FIXTURE_EXPECT_CODEX_HOME !== undefined &&
  process.env.CODEX_HOME !== process.env.FIXTURE_EXPECT_CODEX_HOME
) {
  process.stderr.write("Codex did not receive its OpenDelegate-controlled home\n");
  process.exit(28);
}
if (
  provider === "claude" &&
  process.env.FIXTURE_EXPECT_CLAUDE_HOME !== undefined &&
  process.env.CLAUDE_CONFIG_DIR !== process.env.FIXTURE_EXPECT_CLAUDE_HOME
) {
  process.stderr.write("Claude did not receive its OpenDelegate-controlled home\n");
  process.exit(29);
}

if (args.includes("--version") || args.includes("-v")) {
  process.stdout.write(
    provider === "codex" || provider === "codex-app-server"
      ? "codex-cli 0.146.0\n"
      : provider === "claude"
        ? "2.1.220 (Claude Code)\n"
        : "generic-runner 3.4.5\n",
  );
  process.exit(0);
}

if (
  ((provider === "codex" || provider === "codex-app-server") &&
    args[0] === "login" &&
    args[1] === "status") ||
  (provider === "claude" && args[0] === "auth" && args[1] === "status")
) {
  if (process.env.FIXTURE_SIGNED_OUT === "1") {
    process.exit(1);
  }
  process.stdout.write(provider === "claude" ? '{"loggedIn":true}\n' : "Logged in\n");
  process.exit(0);
}

if (provider === "codex-app-server" || (provider === "codex" && args[0] === "app-server")) {
  const hasFeatureArgument = (verb, feature) =>
    args.some((argument, index) => argument === verb && args[index + 1] === feature);
  if (process.env.FIXTURE_EXPECT_NATIVE_SUBAGENTS === "enabled") {
    if (
      !hasFeatureArgument("--enable", "multi_agent") ||
      hasFeatureArgument("--disable", "multi_agent")
    ) {
      process.stderr.write("Codex native child Agents were not enabled exactly\n");
      process.exit(31);
    }
  }
  if (process.env.FIXTURE_EXPECT_NATIVE_SUBAGENTS === "disabled") {
    if (
      hasFeatureArgument("--enable", "multi_agent") ||
      !hasFeatureArgument("--disable", "multi_agent")
    ) {
      process.stderr.write("Codex native child Agents were not disabled exactly\n");
      process.exit(32);
    }
  }
  const protocol = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  let threadId = "019abcdef-app-server-thread";
  let turnId = "019abcdef-app-server-turn";
  let approvalRequestId = 9001;
  let approvalPending = false;
  let steeringCount = 0;
  for await (const line of protocol) {
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      send({
        id: message.id,
        result: {
          userAgent: "fake",
          platformFamily: "windows",
          platformOs: "windows",
        },
      });
      continue;
    }
    if (message.method === "initialized") {
      if (process.env.FIXTURE_EMIT_REMOTE_CONTROL_STATUS === "1") {
        send({
          method: "remoteControl/status/changed",
          params: { status: "unavailable" },
        });
      }
      continue;
    }
    if (message.method === "model/list") {
      send({
        id: message.id,
        result: {
          data: [
            {
              id: "gpt-5.6-sol",
              model: "gpt-5.6-sol",
              displayName: "GPT-5.6 Sol",
              description: "Fixture model",
              hidden: false,
              isDefault: true,
              defaultReasoningEffort: "high",
              supportedReasoningEfforts: [
                { reasoningEffort: "high", description: "High" },
                { reasoningEffort: "xhigh", description: "Extra high" },
              ],
            },
          ],
          nextCursor: process.env.FIXTURE_REPEAT_MODEL_CURSOR === "1" ? "repeat" : null,
        },
      });
      continue;
    }
    if (message.method === "thread/start" || message.method === "thread/resume") {
      if (
        process.env.FIXTURE_EXPECT_APPROVAL_POLICY &&
        message.params.approvalPolicy !== process.env.FIXTURE_EXPECT_APPROVAL_POLICY
      ) {
        send({ id: message.id, error: { code: -32602, message: "approval policy mismatch" } });
        continue;
      }
      if (
        process.env.FIXTURE_EXPECT_MODEL &&
        message.params.model !== process.env.FIXTURE_EXPECT_MODEL
      ) {
        send({ id: message.id, error: { code: -32602, message: "model mismatch" } });
        continue;
      }
      if (process.env.FIXTURE_EXPECT_NATIVE_SUBAGENTS === "enabled") {
        const agents = message.params.config?.agents;
        if (
          agents?.enabled !== true ||
          agents?.max_concurrent_threads_per_session !== 5 ||
          agents?.max_depth !== 1 ||
          agents?.interrupt_message !== true
        ) {
          send({ id: message.id, error: { code: -32602, message: "agent limits mismatch" } });
          continue;
        }
      }
      if (
        process.env.FIXTURE_EXPECT_NATIVE_SUBAGENTS === "disabled" &&
        message.params.config?.agents !== undefined
      ) {
        send({ id: message.id, error: { code: -32602, message: "unexpected agents config" } });
        continue;
      }
      if (message.method === "thread/resume") {
        threadId = message.params.threadId;
      }
      send({
        id: message.id,
        result: {
          thread: { id: threadId },
          model: "fake",
          modelProvider: "openai",
          cwd: process.cwd(),
        },
      });
      if (
        message.method === "thread/resume" &&
        process.env.FIXTURE_EMIT_THREAD_GOAL_CLEARED === "1"
      ) {
        send({
          method: "thread/goal/cleared",
          params: { threadId },
        });
      }
      continue;
    }
    if (message.method === "thread/read") {
      const reconciledTurnStatus = process.env.FIXTURE_CODEX_RECONCILED_TURN_STATUS ?? "completed";
      send({
        id: message.id,
        result: {
          thread: {
            id: message.params.threadId,
            turns: [
              {
                id: turnId,
                status: reconciledTurnStatus,
                items: [],
                error:
                  reconciledTurnStatus === "failed"
                    ? { message: "persisted fixture failure" }
                    : null,
              },
            ],
          },
        },
      });
      continue;
    }
    if (message.method === "turn/start") {
      if (
        process.env.FIXTURE_EXPECT_APPROVAL_POLICY &&
        message.params.approvalPolicy !== process.env.FIXTURE_EXPECT_APPROVAL_POLICY
      ) {
        send({ id: message.id, error: { code: -32602, message: "approval policy mismatch" } });
        continue;
      }
      if (
        process.env.FIXTURE_EXPECT_MODEL &&
        message.params.model !== process.env.FIXTURE_EXPECT_MODEL
      ) {
        send({ id: message.id, error: { code: -32602, message: "model mismatch" } });
        continue;
      }
      if (
        process.env.FIXTURE_EXPECT_EFFORT &&
        message.params.effort !== process.env.FIXTURE_EXPECT_EFFORT
      ) {
        send({ id: message.id, error: { code: -32602, message: "effort mismatch" } });
        continue;
      }
      if (process.env.FIXTURE_EXPECT_NO_EFFORT && "effort" in message.params) {
        send({ id: message.id, error: { code: -32602, message: "unexpected effort" } });
        continue;
      }
      send({
        id: message.id,
        result: {
          turn: { id: turnId, status: "inProgress", items: [], error: null },
        },
      });
      send({
        method: "turn/started",
        params: {
          threadId,
          turn: { id: turnId, status: "inProgress", items: [], error: null },
        },
      });
      if (process.env.FIXTURE_CODEX_EMIT_SKILLS_CHANGED === "1") {
        send({
          method: "skills/changed",
          params: { threadId },
        });
      }
      if (process.env.FIXTURE_CODEX_EMIT_V0146_NOTIFICATIONS === "1") {
        send({
          method: "thread/name/updated",
          params: { threadId, threadName: "Fixture Task" },
        });
        send({
          method: "hook/started",
          params: { threadId, turnId, run: { id: "hook-fixture" } },
        });
        send({
          method: "hook/completed",
          params: { threadId, turnId, run: { id: "hook-fixture", status: "completed" } },
        });
        send({
          method: "fs/changed",
          params: { paths: [] },
        });
        send({
          method: "error",
          params: {
            threadId,
            turnId,
            willRetry: true,
            error: {
              message: "private fixture provider detail",
              codexErrorInfo: null,
              additionalDetails: null,
            },
          },
        });
      }
      if (process.env.FIXTURE_CODEX_EMIT_UNSUPPORTED_AFTER_TURN_STARTED === "1") {
        send({
          method: "fixture/unsupported",
          params: { threadId, turnId },
        });
        continue;
      }
      send({
        method: "item/agentMessage/delta",
        params: { threadId, turnId, itemId: "message-1", delta: "Working" },
      });
      if (process.env.FIXTURE_COMPLETE_WITHOUT_APPROVAL === "1") {
        send({
          method: "item/completed",
          params: {
            threadId,
            turnId,
            completedAtMs: Date.now(),
            item: {
              type: "agentMessage",
              id: "message-1",
              text: "Finished without tools",
            },
          },
        });
        send({
          method: "turn/completed",
          params: {
            threadId,
            turn: { id: turnId, status: "completed", items: [], error: null },
          },
        });
        continue;
      }
      if (process.env.FIXTURE_CODEX_WAIT_FOR_STEER === "1") {
        continue;
      }
      if (process.env.FIXTURE_EMIT_NATIVE_SUBAGENTS === "1") {
        const childCount = Number(process.env.FIXTURE_NATIVE_SUBAGENT_COUNT ?? "1");
        for (let index = 0; index < childCount; index += 1) {
          const childThreadId = `019abcdef-child-${index + 1}`;
          const item = {
            type: "collabAgentToolCall",
            id: `collab-${index + 1}`,
            senderThreadId: threadId,
            receiverThreadIds: [childThreadId],
            agentsStates: { [childThreadId]: { status: "completed", message: null } },
            tool: "spawnAgent",
            status: "completed",
            prompt: "private child prompt",
            model: null,
            reasoningEffort: null,
          };
          send({ method: "item/started", params: { threadId, turnId, item } });
          send({ method: "item/completed", params: { threadId, turnId, item } });
          send({
            method: "item/completed",
            params: {
              threadId,
              turnId,
              item: {
                type: "subAgentActivity",
                id: `activity-${index + 1}`,
                agentThreadId: childThreadId,
                agentPath: `/root/child-${index + 1}`,
                kind: "interacted",
              },
            },
          });
          send({
            method: "turn/started",
            params: {
              threadId: childThreadId,
              turn: {
                id: `child-turn-${index + 1}`,
                status: "inProgress",
                items: [],
                error: null,
              },
            },
          });
          send({
            method: "item/agentMessage/delta",
            params: {
              threadId: childThreadId,
              turnId: `child-turn-${index + 1}`,
              itemId: `child-message-${index + 1}`,
              delta: "private child delta",
            },
          });
          send({
            method: "item/completed",
            params: {
              threadId: childThreadId,
              turnId: `child-turn-${index + 1}`,
              item: {
                type: "agentMessage",
                id: `child-message-${index + 1}`,
                text: "private child answer",
                phase: "final_answer",
              },
            },
          });
          send({
            method: "thread/tokenUsage/updated",
            params: {
              threadId: childThreadId,
              turnId: `child-turn-${index + 1}`,
              tokenUsage: {
                inputTokens: 2,
                outputTokens: 1,
                cachedInputTokens: 0,
              },
            },
          });
          send({
            method: "turn/completed",
            params: {
              threadId: childThreadId,
              turn: {
                id: `child-turn-${index + 1}`,
                status: "completed",
                items: [],
                error: null,
              },
            },
          });
        }
      }
      send({
        method: "item/commandExecution/requestApproval",
        id: approvalRequestId,
        params: {
          threadId,
          turnId,
          itemId: "command-1",
          startedAtMs: Date.now(),
          command: "pnpm install",
          cwd: process.cwd(),
          reason: "Install project dependencies",
          environmentId: null,
        },
      });
      approvalPending = true;
      continue;
    }
    if (message.id === approvalRequestId && approvalPending) {
      approvalPending = false;
      if (message.result?.decision !== "accept") {
        send({
          method: "turn/completed",
          params: {
            threadId,
            turn: {
              id: turnId,
              status: "failed",
              items: [],
              error: { message: "approval denied" },
            },
          },
        });
        continue;
      }
      send({
        method: "item/started",
        params: {
          threadId,
          turnId,
          startedAtMs: Date.now(),
          item: {
            type: "commandExecution",
            id: "command-1",
            command: "pnpm install",
            cwd: process.cwd(),
            status: "inProgress",
          },
        },
      });
      send({
        method: "item/completed",
        params: {
          threadId,
          turnId,
          completedAtMs: Date.now(),
          item: {
            type: "commandExecution",
            id: "command-1",
            command: "pnpm install",
            cwd: process.cwd(),
            status: "completed",
            exitCode: 0,
          },
        },
      });
      send({
        method: "item/completed",
        params: {
          threadId,
          turnId,
          completedAtMs: Date.now(),
          item: {
            type: "agentMessage",
            id: "message-1",
            text: "Finished through App Server",
          },
        },
      });
      send({
        method: "thread/tokenUsage/updated",
        params: {
          threadId,
          tokenUsage: {
            inputTokens: 10,
            outputTokens: 6,
            cachedInputTokens: 2,
          },
        },
      });
      if (process.env.FIXTURE_CODEX_CLOSE_BEFORE_TURN_COMPLETED === "1") {
        process.exit(0);
      }
      send({
        method: "turn/completed",
        params: {
          threadId,
          turn: {
            id: turnId,
            status: "completed",
            items: [],
            error: null,
          },
        },
      });
      continue;
    }
    if (message.method === "turn/steer") {
      if (
        message.params.threadId !== threadId ||
        message.params.expectedTurnId !== turnId ||
        !Array.isArray(message.params.input) ||
        message.params.input[0]?.type !== "text"
      ) {
        send({
          id: message.id,
          error: { code: -32602, message: "invalid steer scope" },
        });
        continue;
      }
      steeringCount += 1;
      send({ id: message.id, result: { turnId } });
      send({
        method: "item/completed",
        params: {
          threadId,
          turnId,
          completedAtMs: Date.now(),
          item: {
            type: "agentMessage",
            id: "message-steered",
            text: `Steered once: ${message.params.input[0].text}`,
          },
        },
      });
      send({
        method: "turn/completed",
        params: {
          threadId,
          turn: {
            id: turnId,
            status: steeringCount === 1 ? "completed" : "failed",
            items: [],
            error: steeringCount === 1 ? null : { message: "duplicate steering" },
          },
        },
      });
      continue;
    }
    if (message.method === "turn/interrupt") {
      send({ id: message.id, result: {} });
      send({
        method: "turn/completed",
        params: {
          threadId,
          turn: { id: turnId, status: "interrupted", items: [], error: null },
        },
      });
    }
  }
  process.exit(0);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let prompt = "";
for await (const line of input) {
  prompt += `${line}\n`;
}

if (provider === "codex") {
  if (process.env.FIXTURE_REQUIRE_SKIP_GIT === "1" && !args.includes("--skip-git-repo-check")) {
    process.stderr.write("missing --skip-git-repo-check\n");
    process.exit(23);
  }
  if (process.env.FIXTURE_REQUIRE_DENY_ISOLATION === "1") {
    const required = [
      "--ignore-user-config",
      "--ignore-rules",
      "apps",
      "browser_use",
      "computer_use",
      "hooks",
      "shell_tool",
      "workspace_dependencies",
    ];
    if (!required.every((argument) => args.includes(argument))) {
      process.stderr.write("missing deny-isolation argument\n");
      process.exit(24);
    }
  }
  if (process.env.FIXTURE_REQUIRE_CODEX_TOOL_SERVER === "1") {
    const requiredConfiguration = [
      `mcp_servers.opendelegate.command=${JSON.stringify(process.execPath)}`,
      `mcp_servers.opendelegate.args=${JSON.stringify([
        fixtureFilename,
        "mcp-bridge",
        "--capability-file",
        "C:\\runtime\\grant.json",
      ])}`,
      'mcp_servers.opendelegate.enabled_tools=["computer_use_capture","computer_use_click"]',
      "mcp_servers.opendelegate.startup_timeout_sec=5",
      "mcp_servers.opendelegate.tool_timeout_sec=30",
    ];
    const configured = args
      .map((argument, index) => (argument === "-c" ? args[index + 1] : undefined))
      .filter((argument) => argument !== undefined);
    if (!requiredConfiguration.every((argument) => configured.includes(argument))) {
      process.stderr.write(
        `missing Codex tool-server isolation argument: ${JSON.stringify(configured)}\n`,
      );
      process.exit(26);
    }
  }
  if (process.env.FIXTURE_REQUIRE_CODEX_KNOWLEDGE_TOOL_SERVER === "1") {
    const requiredConfiguration = [
      `mcp_servers.opendelegate-knowledge.command=${JSON.stringify(process.execPath)}`,
      `mcp_servers.opendelegate-knowledge.args=${JSON.stringify([
        fixtureFilename,
        "knowledge-mcp-bridge",
        "--capability-file",
        "/runtime/knowledge-capability.json",
      ])}`,
      'mcp_servers.opendelegate-knowledge.enabled_tools=["knowledge_search","knowledge_open","knowledge_relationships","knowledge_upsert"]',
    ];
    const configured = args
      .map((argument, index) => (argument === "-c" ? args[index + 1] : undefined))
      .filter((argument) => argument !== undefined);
    const mcpConfiguration = configured.filter((argument) => argument.startsWith("mcp_servers."));
    if (
      mcpConfiguration.length !== 5 ||
      !requiredConfiguration.every((argument) => mcpConfiguration.includes(argument)) ||
      mcpConfiguration.some((argument) => argument.includes("knowledge-private"))
    ) {
      process.stderr.write("invalid Codex Knowledge tool-server isolation\n");
      process.exit(28);
    }
  }
  process.stdout.write(
    `${JSON.stringify({ type: "thread.started", thread_id: "codex-session-1" })}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({
      type: "item.completed",
      item: { id: "item-1", type: "agent_message", text: `Finished: ${prompt.trim()}` },
    })}\n`,
  );
  if (process.env.FIXTURE_EMIT_KNOWLEDGE_TOOL_EVENTS === "1") {
    process.stdout.write(
      `${JSON.stringify({
        type: "item.completed",
        item: {
          id: "knowledge-tool-1",
          type: "mcp_tool_call",
          tool: "knowledge_search",
          status: "completed",
          arguments: { query: "private-query", noteId: "private-note.md" },
          result: { content: "private-Knowledge-content" },
        },
      })}\n`,
    );
  }
  process.stdout.write(
    `${JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 12, output_tokens: 7, cached_input_tokens: 2 },
    })}\n`,
  );
  process.exit(0);
}

if (provider === "claude") {
  if (process.env.FIXTURE_REQUIRE_CLAUDE_ISOLATION === "1") {
    const required = [
      "--safe-mode",
      "--strict-mcp-config",
      "--no-chrome",
      "--disable-slash-commands",
      "--prompt-suggestions",
    ];
    if (!required.every((argument) => args.includes(argument))) {
      process.stderr.write("missing Claude isolation argument\n");
      process.exit(25);
    }
  }
  if (process.env.FIXTURE_REQUIRE_CLAUDE_TOOL_SERVER === "1") {
    const configIndex = args.indexOf("--mcp-config");
    const configuration =
      configIndex >= 0 && args[configIndex + 1] !== undefined
        ? JSON.parse(args[configIndex + 1])
        : undefined;
    const server = configuration?.mcpServers?.opendelegate;
    const allowedToolsIndex = args.indexOf("--allowedTools");
    const allowedTools = allowedToolsIndex < 0 ? "" : (args[allowedToolsIndex + 1] ?? "");
    if (
      server?.type !== "stdio" ||
      server.command !== process.execPath ||
      !Array.isArray(server.args) ||
      !server.args.includes("--capability-file") ||
      !allowedTools.includes("mcp__opendelegate__computer_use_capture") ||
      !allowedTools.includes("mcp__opendelegate__computer_use_click")
    ) {
      process.stderr.write("missing Claude tool-server isolation argument\n");
      process.exit(27);
    }
  }
  if (process.env.FIXTURE_REQUIRE_CLAUDE_KNOWLEDGE_TOOL_SERVER === "1") {
    const configIndex = args.indexOf("--mcp-config");
    const configuration =
      configIndex >= 0 && args[configIndex + 1] !== undefined
        ? JSON.parse(args[configIndex + 1])
        : undefined;
    const serverNames = Object.keys(configuration?.mcpServers ?? {});
    const server = configuration?.mcpServers?.["opendelegate-knowledge"];
    const allowedToolsIndex = args.indexOf("--allowedTools");
    const allowedTools = allowedToolsIndex < 0 ? "" : (args[allowedToolsIndex + 1] ?? "");
    if (
      serverNames.length !== 1 ||
      serverNames[0] !== "opendelegate-knowledge" ||
      server?.type !== "stdio" ||
      server.command !== process.execPath ||
      JSON.stringify(server.args) !==
        JSON.stringify([
          fixtureFilename,
          "knowledge-mcp-bridge",
          "--capability-file",
          "/runtime/knowledge-capability.json",
        ]) ||
      !allowedTools.includes("mcp__opendelegate-knowledge__knowledge_search") ||
      JSON.stringify(configuration).includes("knowledge-private")
    ) {
      process.stderr.write("invalid Claude Knowledge tool-server isolation\n");
      process.exit(29);
    }
  }
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
  if (process.env.FIXTURE_EMIT_KNOWLEDGE_TOOL_EVENTS === "1") {
    process.stdout.write(
      `${JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "knowledge-tool-1",
              name: "mcp__opendelegate-knowledge__knowledge_search",
              input: {
                query: "private-query",
                noteId: "private-note.md",
                content: "private-Knowledge-content",
              },
            },
          ],
        },
      })}\n`,
    );
    process.stdout.write(
      `${JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "knowledge-tool-1",
              is_error: false,
              content: "private-Knowledge-result with private-note.md and private-query",
            },
          ],
        },
      })}\n`,
    );
  }
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
