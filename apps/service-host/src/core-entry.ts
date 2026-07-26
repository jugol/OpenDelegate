#!/usr/bin/env node

import { runCoreServiceHost } from "./core-host.ts";

runCoreServiceHost({ arguments: process.argv.slice(2) }).catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "OpenDelegate core service host failed."}\n`,
  );
  process.exitCode = 1;
});
