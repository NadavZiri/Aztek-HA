import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "server", include: ["shared/**/*.test.ts", "server/tests/**/*.test.ts"], environment: "node", restoreMocks: true } },
      { test: { name: "client", include: ["client/src/**/*.test.{ts,tsx}"], environment: "jsdom", restoreMocks: true } }
    ]
  }
});
