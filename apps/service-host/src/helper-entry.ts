#!/usr/bin/env node

import { runSessionHelperServiceHost } from "./session-helper-host.ts";

runSessionHelperServiceHost({ arguments: process.argv.slice(2) }).catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "OpenDelegate session helper failed."}\n`,
  );
  process.exitCode = 1;
});
