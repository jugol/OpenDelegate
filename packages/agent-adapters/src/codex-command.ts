import { realpathSync, statSync } from "node:fs";
import { join } from "node:path";

export interface CodexCommand {
  readonly executable: string;
  readonly prefixArgs: readonly string[];
}

/**
 * Resolves the native npm layout before falling back to the bare launcher name.
 * Windows npm installs Codex behind a `.cmd` shim, which OpenDelegate correctly
 * refuses to execute through a shell. The package's JavaScript entry point can
 * instead be launched directly by the pinned Node runtime.
 */
export function resolveDefaultCodexCommand(
  input: {
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly hostPlatform?: NodeJS.Platform;
    readonly nodeExecutable?: string;
  } = {},
): CodexCommand {
  const hostPlatform = input.hostPlatform ?? process.platform;
  if (hostPlatform === "win32") {
    const environment = input.environment ?? process.env;
    const pathValue =
      environment["PATH"] ??
      Object.entries(environment).find(([key]) => key.toLocaleLowerCase("en-US") === "path")?.[1] ??
      "";
    const pathEntries = pathValue
      .split(";")
      .map((entry) => entry.trim().replace(/^"(.*)"$/u, "$1"))
      .filter((entry) => entry.length > 0);
    for (const directory of pathEntries) {
      const entrypoint = join(directory, "node_modules", "@openai", "codex", "bin", "codex.js");
      try {
        if (statSync(entrypoint).isFile()) {
          return Object.freeze({
            executable: input.nodeExecutable ?? process.execPath,
            prefixArgs: Object.freeze([realpathSync(entrypoint)]),
          });
        }
      } catch {
        // Continue to the next bounded PATH entry.
      }
    }
  }
  return Object.freeze({ executable: "codex", prefixArgs: Object.freeze([]) });
}
