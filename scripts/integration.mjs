import { spawnSync } from "node:child_process";

if (!process.env.TEST_DATABASE_URL) {
  console.error("Set TEST_DATABASE_URL to an isolated, migrated PostgreSQL database before running integration tests.");
  process.exit(1);
}
const result = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "server/tests/integration.test.ts"], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
