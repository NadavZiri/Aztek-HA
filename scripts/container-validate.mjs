import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";

const id = `aztek-test-${randomUUID().slice(0, 8)}`;
const names = { network: `${id}-net`, db: `${id}-db`, app: `${id}-app`, standby: `${id}-standby` };
const image = "aztek-weather:validation";
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr ?? ""}`);
  return result.stdout?.trim();
}
function docker(...args) { return run("docker", args); }
async function waitFor(url, expected) {
  for (let i = 0; i < 30; i++) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(15000) })).status === expected) return;
    } catch (error) {
      if (i === 29) throw error;
    }
    await setTimeout(1000);
  }
  throw new Error(`Expected ${expected} from ${url}`);
}
let networkCreated = false;
const containers = [];
try {
  run("docker", ["build", "-t", image, "."], { stdio: "inherit" });
  docker("network", "create", names.network);
  networkCreated = true;
  docker("run", "-d", "--name", names.db, "--network", names.network, "-p", "127.0.0.1::5432",
    "-e", "POSTGRES_USER=weather_admin", "-e", "POSTGRES_PASSWORD=isolated-admin-validation", "-e", "POSTGRES_DB=weather", "postgres:17");
  containers.push(names.db);
  let databaseAvailable = false;
  for (let i = 0; i < 30; i++) {
    const result = spawnSync("docker", ["exec", names.db, "pg_isready", "-U", "weather_admin"], { stdio: "ignore" });
    if (result.status === 0) { databaseAvailable = true; break; }
    await setTimeout(1000);
  }
  assert.ok(databaseAvailable, "Isolated database did not start");
  const adminUrl = `postgresql://weather_admin:isolated-admin-validation@${names.db}:5432/weather`;
  const appUrl = `postgresql://weather_app:isolated-app-validation@${names.db}:5432/weather`;
  const migrate = ["run", "--rm", "--network", names.network, "-e", `DATABASE_URL=${adminUrl}`, "-e", `APP_DATABASE_URL=${appUrl}`, image, "node", "scripts/migrate.mjs"];
  docker(...migrate);
  docker(...migrate);
  const privileges = docker("exec", names.db, "psql", "-U", "weather_admin", "-d", "weather", "-Atc",
    "SELECT NOT rolcreatedb AND NOT rolcreaterole AND NOT rolsuper AND has_table_privilege('weather_app', '\"WeatherSnapshot\"', 'INSERT') AND NOT has_table_privilege('weather_app', '\"_prisma_migrations\"', 'UPDATE') FROM pg_roles WHERE rolname='weather_app'");
  assert.equal(privileges, "t", "Runtime role must have data privileges, not administrative privileges");
  const dbPort = docker("port", names.db, "5432/tcp").split(":").at(-1);
  run(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "server/tests/integration.test.ts"], {
    stdio: "inherit", env: { ...process.env, TEST_DATABASE_URL: `postgresql://weather_admin:isolated-admin-validation@127.0.0.1:${dbPort}/weather` }
  });
  const config = [
    "-e", `DATABASE_URL=${appUrl}`, "-e", "JWT_SECRET=isolated-validation-jwt-secret-at-least-32",
    "-e", "OPENWEATHER_API_KEY=unused", "-e", "APP_ORIGIN=https://weather.example.test",
    "-e", "FRONT_DOOR_ID=11111111-1111-4111-8111-111111111111",
    "-e", "FRONT_DOOR_SECRET=isolated-validation-origin-secret-32"
  ];
  for (const [name, role] of [[names.app, "active"], [names.standby, "standby"]]) {
    docker("run", "-d", "--name", name, "--network", names.network, "-p", "127.0.0.1::3001",
      ...config, "-e", `DEPLOYMENT_ROLE=${role}`, image);
    containers.push(name);
  }
  let base = `http://${docker("port", names.app, "3001/tcp")}`;
  const standby = `http://${docker("port", names.standby, "3001/tcp")}`;
  await waitFor(base + "/health/ready", 200);
  await waitFor(standby + "/health/live", 200);
  assert.equal(docker("exec", names.app, "id", "-u"), "1000", "App must run without root");
  run(process.execPath, ["scripts/container-smoke.mjs"], { stdio: "inherit", env: { ...process.env, SMOKE_BASE_URL: base, SMOKE_STANDBY_URL: standby } });
  docker("run", "--rm", "--network", names.network, "-e", `DATABASE_URL=${adminUrl}`, "-e", `APP_DATABASE_URL=${appUrl}`,
    "-e", "RECOVERY_RESET_SESSIONS=true", image, "node", "scripts/migrate.mjs");
  assert.equal(docker("exec", names.db, "psql", "-U", "weather_admin", "-d", "weather", "-Atc", 'SELECT count(*) FROM "Session" WHERE "revokedAt" IS NULL'), "0");
  docker("exec", names.db, "psql", "-U", "weather_admin", "-d", "weather", "-c", 'ALTER ROLE weather_app SET default_transaction_read_only TO on');
  docker("restart", names.app);
  base = `http://${docker("port", names.app, "3001/tcp")}`;
  await waitFor(base + "/health/ready", 503);
  docker("exec", names.db, "psql", "-U", "weather_admin", "-d", "weather", "-c", 'ALTER ROLE weather_app SET default_transaction_read_only TO off');
  docker("restart", names.app);
  base = `http://${docker("port", names.app, "3001/tcp")}`;
  await waitFor(base + "/health/ready", 200);
  docker("stop", names.db);
  assert.equal((await fetch(base + "/health/live")).status, 200);
  await waitFor(base + "/health/ready", 503);
  docker("start", names.db);
  await waitFor(base + "/health/ready", 200);
  console.info("Container validation passed: idempotent migrations, least-privilege role, integration tests, non-root hosting, recovery session reset, read-only database rejection and database outage/reconnect.");
} finally {
  for (const name of containers.reverse()) {
    const result = spawnSync("docker", ["rm", "-f", name], { encoding: "utf8" });
    if (result.status !== 0) console.error(`Cleanup failed for ${name}: ${result.stderr}`);
  }
  if (networkCreated) {
    const result = spawnSync("docker", ["network", "rm", names.network], { encoding: "utf8" });
    if (result.status !== 0) console.error(`Network cleanup failed: ${result.stderr}`);
  }
}
