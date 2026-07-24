import { validateWindowsHostSupervisor } from "./windows-host-validation.ts";

if (process.platform !== "win32") {
  process.stderr.write("Windows host validation is available only on a Windows host.\n");
  process.exitCode = 2;
} else {
  const report = await validateWindowsHostSupervisor();
  process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`);
  if (!report.tools.every((tool) => tool.available)) {
    process.exitCode = 1;
  }
}
