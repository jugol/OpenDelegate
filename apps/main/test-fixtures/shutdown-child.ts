import { reportCliFailure, waitForShutdown } from "../src/cli.ts";

const mode = process.argv[2];
if (mode !== "success" && mode !== "failure" && mode !== "race") {
  throw new Error("Expected a shutdown fixture mode.");
}

let closeCount = 0;
const shutdown = waitForShutdown({
  close: async () => {
    closeCount += 1;
    if (mode === "failure") {
      throw new Error("private spawned shutdown detail");
    }
  },
});

if (mode === "race") {
  setImmediate(() => {
    process.emit("SIGINT");
    process.stdin.emit("end");
    process.emit("SIGTERM");
  });
}

void shutdown
  .then(() => {
    process.stdout.write(`${JSON.stringify({ closeCount })}\n`);
  })
  .catch(reportCliFailure);
