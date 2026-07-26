import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { reportCliFailure, runCli } from "../src/cli.ts";
import { runWithPortableWindowsRuntimePermissionsForTest } from "./portable-main-runtime.ts";

const fixturePath = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fixturePath)) {
  void runWithPortableWindowsRuntimePermissionsForTest(() => runCli(process.argv.slice(2))).catch(
    reportCliFailure,
  );
}
