process.on("SIGTERM", () => {
  // Exercise the launcher's bounded hard-kill fallback.
});
process.stdin.resume();
