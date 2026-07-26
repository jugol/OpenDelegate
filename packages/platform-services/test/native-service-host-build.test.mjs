import assert from "node:assert/strict";
import test from "node:test";

import { createPosixCompilerOptions } from "../native/service-host/build.mjs";

test("POSIX native compiler invocations retain a bounded CodeQL-safe wall time", () => {
  const options = createPosixCompilerOptions();

  assert.equal(options.timeout, 10 * 60 * 1000);
  assert.equal(options.maxBuffer, 2 * 1024 * 1024);
});
