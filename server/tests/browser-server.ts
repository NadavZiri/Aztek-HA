import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { createApp } from "../src/app";
import { city, current, forecast } from "../../shared/src/fixtures";

if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is required for the fixture browser server");
const db = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL });
await db.$connect();
const app = createApp(db, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  JWT_SECRET: randomBytes(48).toString("hex"),
  OPENWEATHER_API_KEY: "fixture-only-not-a-live-key",
  APP_ORIGIN: "http://localhost:5173", PORT: 3001, NODE_ENV: "test"
}, { cities: async () => [city], weather: async () => ({ current, forecast }) });
const server = app.listen(3001, "127.0.0.1", () => console.info("TEST FIXTURES ONLY: browser validation API on 3001"));
const shutdown = () => server.close(() => { void db.$disconnect().then(() => process.exit(0)); });
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
