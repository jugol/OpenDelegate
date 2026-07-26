import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig, devices } from "@playwright/test";

const requestedPort = Number(process.env["OPENDELEGATE_PLAYWRIGHT_PORT"] ?? "4173");
if (!Number.isSafeInteger(requestedPort) || requestedPort < 1 || requestedPort > 65_535) {
  throw new Error("OPENDELEGATE_PLAYWRIGHT_PORT must be an integer from 1 through 65535.");
}
const baseURL = `http://127.0.0.1:${String(requestedPort)}`;
const outputRoot = process.env["RUNNER_TEMP"]?.trim() || tmpdir();

export default defineConfig({
  testDir: "./e2e",
  outputDir: join(outputRoot, "opendelegate-playwright-results"),
  fullyParallel: true,
  timeout: 20_000,
  expect: {
    timeout: 5_000,
  },
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `pnpm build && pnpm preview --host 127.0.0.1 --port ${String(requestedPort)} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: "desktop-chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: {
          width: 1600,
          height: 1000,
        },
      },
    },
    {
      name: "compact-desktop-chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: {
          width: 1000,
          height: 800,
        },
      },
    },
    {
      name: "mobile-chromium",
      use: {
        ...devices["Pixel 7"],
        viewport: {
          width: 390,
          height: 844,
        },
      },
    },
    {
      name: "minimum-width-chromium",
      use: {
        ...devices["Pixel 7"],
        viewport: {
          width: 320,
          height: 720,
        },
      },
    },
  ],
});
