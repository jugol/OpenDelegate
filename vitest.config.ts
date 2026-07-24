import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "apps/**/*.{test,spec}.{ts,tsx}",
      "packages/**/*.{test,spec}.{ts,tsx}",
      "tooling/**/*.{test,spec}.{ts,tsx}",
    ],
    passWithNoTests: true,
    restoreMocks: true,
  },
});
