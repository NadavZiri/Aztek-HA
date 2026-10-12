import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

if (!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL) throw new Error("Migration job requires admin and application database URLs");
const app = new URL(process.env.APP_DATABASE_URL);
if (decodeURIComponent(app.username) !== "weather_app") throw new Error("Unexpected runtime database role");
const result = spawnSync(process.execPath, ["../node_modules/prisma/build/index.js", "migrate", "deploy"], { stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const db = new PrismaClient();
const password = decodeURIComponent(app.password).replaceAll("'", "''");
try {
  const roles = await db.$queryRaw`SELECT 1 FROM pg_roles WHERE rolname = 'weather_app'`;
  if (roles.length === 0) {
    await db.$executeRawUnsafe(`CREATE ROLE weather_app LOGIN PASSWORD '${password}'`);
  } else {
    await db.$executeRawUnsafe(`ALTER ROLE weather_app PASSWORD '${password}'`);
  }
  await db.$executeRawUnsafe('GRANT USAGE ON SCHEMA public TO weather_app');
  await db.$executeRawUnsafe('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO weather_app');
  await db.$executeRawUnsafe('REVOKE ALL ON TABLE "_prisma_migrations" FROM weather_app');
  if (process.env.RECOVERY_RESET_SESSIONS === "true") {
    const result = await db.session.updateMany({ data: { revokedAt: new Date() } });
    await db.weatherDraft.deleteMany();
    console.info(`Regional recovery revoked ${result.count} sessions and removed transient drafts.`);
  }
  console.info("Migrations applied and runtime role configured.");
} catch (error) {
  console.error("Database deployment job failed:", error instanceof Error ? error.name : "UnknownError");
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
