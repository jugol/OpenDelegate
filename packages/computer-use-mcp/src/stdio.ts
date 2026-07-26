import { once } from "node:events";
import type { Readable, Writable } from "node:stream";
import { TextDecoder } from "node:util";

import type { ComputerUseMcpDiagnostic, ComputerUseMcpServerOptions } from "./contracts.ts";
import { createComputerUseMcpServer } from "./server.ts";

const DEFAULT_MAX_INPUT_LINE_BYTES = 64 * 1024;

export interface ComputerUseMcpStdioServerOptions extends ComputerUseMcpServerOptions {
  readonly input?: Readable;
  readonly output?: Writable;
  readonly stderr?: Writable;
}

/**
 * Run one MCP server over newline-delimited JSON-RPC stdio.
 *
 * The function never writes diagnostics to stdout. It does not close caller-owned
 * streams. Closing input is the shutdown signal; pending calls settle or hit their
 * configured timeout before the function returns.
 */
export async function runComputerUseMcpStdioServer(
  options: ComputerUseMcpStdioServerOptions,
): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const diagnostic = (event: ComputerUseMcpDiagnostic): void => {
    writeDiagnostic(stderr, event);
    try {
      options.diagnostic?.(event);
    } catch {
      // A caller-provided diagnostic sink cannot affect the protocol.
    }
  };
  const server = createComputerUseMcpServer({
    authority: options.authority,
    port: options.port,
    ...(options.enabledTools === undefined ? {} : { enabledTools: options.enabledTools }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.serverInfo === undefined ? {} : { serverInfo: options.serverInfo }),
    diagnostic,
  });
  const maxInputLineBytes = options.limits?.maxInputLineBytes ?? DEFAULT_MAX_INPUT_LINE_BYTES;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const pending = new Set<Promise<void>>();
  let writeQueue = Promise.resolve();

  const scheduleResponse = (response: Promise<string | undefined>): void => {
    const task = response
      .then((line) => {
        if (line !== undefined) {
          writeQueue = writeQueue.then(() => writeLine(output, line));
        }
        return writeQueue;
      })
      .catch(() => {
        writeDiagnostic(stderr, {
          level: "error",
          event: "computer_use_mcp.input",
          code: "input_rejected",
        });
      })
      .then(() => undefined);
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };

  let pendingBytes = Buffer.alloc(0);
  let discardingOversizedLine = false;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(typeof chunk === "string" ? chunk : String(chunk), "utf8");
    let offset = 0;
    while (offset < bytes.length) {
      const newlineIndex = bytes.indexOf(10, offset);
      const end = newlineIndex === -1 ? bytes.length : newlineIndex;
      const segment = bytes.subarray(offset, end);
      if (!discardingOversizedLine) {
        if (pendingBytes.length + segment.length > maxInputLineBytes) {
          pendingBytes = Buffer.alloc(0);
          discardingOversizedLine = true;
        } else if (segment.length > 0) {
          pendingBytes = Buffer.concat([pendingBytes, segment]);
        }
      }
      if (newlineIndex === -1) {
        break;
      }
      if (discardingOversizedLine) {
        scheduleResponse(Promise.resolve(server.handleOversizeLine()));
      } else {
        scheduleResponse(server.handleLine(decodeLine(decoder, pendingBytes)));
      }
      pendingBytes = Buffer.alloc(0);
      discardingOversizedLine = false;
      offset = newlineIndex + 1;
    }
  }

  if (discardingOversizedLine) {
    scheduleResponse(Promise.resolve(server.handleOversizeLine()));
  } else if (pendingBytes.length > 0) {
    scheduleResponse(server.handleLine(decodeLine(decoder, pendingBytes)));
  }

  await Promise.all([...pending]);
  await writeQueue;
  server.close();
}

function decodeLine(decoder: TextDecoder, bytes: Buffer): string {
  const withoutCarriageReturn =
    bytes.length > 0 && bytes[bytes.length - 1] === 13 ? bytes.subarray(0, -1) : bytes;
  try {
    return decoder.decode(withoutCarriageReturn);
  } catch {
    return "{";
  }
}

async function writeLine(output: Writable, line: string): Promise<void> {
  if (output.write(`${line}\n`, "utf8")) {
    return;
  }
  await once(output, "drain");
}

function writeDiagnostic(stderr: Writable, event: ComputerUseMcpDiagnostic): void {
  try {
    stderr.write(`${JSON.stringify(event)}\n`, "utf8");
  } catch {
    // Diagnostics are best effort and must never be redirected to stdout.
  }
}
