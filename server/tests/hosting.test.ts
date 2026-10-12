import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { databaseReady } from "../src/readiness";
import { city, current, forecast } from "../../shared/src/fixtures";

const config = {
  DATABASE_URL: "postgresql://unused:unused@localhost:5432/unused",
  JWT_SECRET: "hosting-test-secret-at-least-32-characters",
  OPENWEATHER_API_KEY: "unused", APP_ORIGIN: "https://example.test",
  PORT: 3001, NODE_ENV: "test" as const
};
const provider = { cities: async () => [city], weather: async () => ({ current, forecast }) };
it("has independent liveness and fails readiness closed on standby", async () => {
  const db = new PrismaClient();
  const app = createApp(db, { ...config, DEPLOYMENT_ROLE: "standby" }, provider);
  await request(app).get("/health/live").expect(200);
  await request(app).get("/health/ready").expect(503, { status: "standby" });
  await request(app).get("/api/cities?q=London").expect(503);
});
it("requires a writable migrated database for readiness", async () => {
  const db = new PrismaClient();
  const query = vi.spyOn(db, "$queryRaw").mockResolvedValue([{ writable: false, migrated: true }]);
  expect(await databaseReady(db, "active")).toBe(false);
  query.mockResolvedValue([{ writable: true, migrated: true }]);
  expect(await databaseReady(db, "active")).toBe(true);
  query.mockResolvedValue([{ writable: true, migrated: false }]);
  expect(await databaseReady(db, "active")).toBe(false);
  query.mockRestore();
});
it("reports active read-only databases as unavailable, not standby", async () => {
  const db = new PrismaClient();
  vi.spyOn(db, "$queryRaw").mockResolvedValue([{ writable: false, migrated: true }]);
  await request(createApp(db, config, provider)).get("/health/ready").expect(503, { status: "unavailable" });
});
it("keeps liveness available when database readiness fails", async () => {
  const db = new PrismaClient();
  vi.spyOn(db, "$queryRaw").mockRejectedValue(new Error("database unavailable"));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const app = createApp(db, config, provider);
  await request(app).get("/health/ready").expect(503);
  expect(log).toHaveBeenCalledWith("Database readiness failed:", "Error");
  await request(app).get("/health/live").expect(200);
});
it("rejects direct origin access while leaving probes accessible", async () => {
  const db = new PrismaClient();
  const secret = "origin-secret-at-least-32-characters";
  const fdid = "11111111-1111-4111-8111-111111111111";
  const app = createApp(db, { ...config, FRONT_DOOR_ID: fdid, FRONT_DOOR_SECRET: secret }, provider);
  await request(app).get("/api/auth/csrf").expect(403);
  await request(app).get("/api/auth/csrf").set("X-Azure-FDID", fdid).expect(403);
  await request(app).get("/api/auth/csrf").set("X-Azure-FDID", fdid).set("X-Origin-Secret", secret).expect(200);
  await request(app).get("/health/live").expect(200);
});
