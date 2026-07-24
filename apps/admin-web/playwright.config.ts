import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:4173";

export default defineConfig({
  testDir: "./e2e",
  outputDir: join(tmpdir(), "opendelegate-playwright-results"),
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
    command: "pnpm build && pnpm preview --host 127.0.0.1 --port 4173 --strictPort",
    url: baseURL,
    reuseExistingServer: process.env.CI !== "true",
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
