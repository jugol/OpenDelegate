import { once } from "node:events";
import { resolve } from "node:path";

import { acquireMainSingletonOwnership } from "../src/main-singleton-ownership.ts";

const stateDirectory = process.argv[2];
if (stateDirectory === undefined) {
  throw new Error("A Main ownership state directory is required.");
}

const ownership = await acquireMainSingletonOwnership({
  database: { adapter: "sqlite" },
  stateDirectory: resolve(stateDirectory),
});

process.stdout.write("ready\n");
process.stdin.resume();
await once(process.stdin, "end");
await ownership.release();
