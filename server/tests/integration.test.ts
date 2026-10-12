import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../src/app";
import { AppError } from "../src/errors";
import { city, current, forecast } from "../../shared/src/fixtures";
import { snapshotListSchema, weatherSchema, userSchema } from "@weather/shared";
import type { Config } from "../src/config";
import { DatabaseRateLimitStore } from "../src/rate-limit";

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("PostgreSQL-backed app", () => {
  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  const userIds: string[] = [];
  const config: Config = {
    DATABASE_URL: databaseUrl ?? "", JWT_SECRET: "integration-test-only-secret-32-characters",
    OPENWEATHER_API_KEY: "not-used-by-fixture-provider", APP_ORIGIN: "http://localhost:5173", PORT: 3001, NODE_ENV: "test"
  };
  const provider = { cities: async () => [city], weather: async () => ({ current, forecast }) };
  const app = createApp(db, config, provider);
  const password = "a sufficiently long password";
  const email = () => `test-${randomUUID()}@example.com`;
  const authBody = z.object({ user: userSchema });
  async function account() {
    const agent = request.agent(app);
    const csrfResponse = await agent.get("/api/auth/csrf").expect(200);
    const csrf = z.object({ csrfToken: z.string() }).parse(csrfResponse.body).csrfToken;
    const address = email();
    const registration = await agent.post("/api/auth/register").set("Origin", config.APP_ORIGIN).set("X-CSRF-Token", csrf).send({ email: address, password }).expect(201);
    const user = authBody.parse(registration.body).user;
    userIds.push(user.id);
    return { agent, csrf, user, email: address, cookies: z.array(z.string()).parse(registration.headers["set-cookie"]) };
  }
  afterAll(async () => {
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.$disconnect();
  });
  it("shares atomic rate limits across app replicas and expires buckets", async () => {
    const prefix = `test-${randomUUID()}`;
    const first = new DatabaseRateLimitStore(db, prefix);
    const second = new DatabaseRateLimitStore(db, prefix);
    const key = randomUUID();
    try {
      const counts = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? first : second).increment(key)));
      expect(counts.map(value => value.totalHits).sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
      await first.decrement(key);
      expect((await second.increment(key)).totalHits).toBe(12);
      await db.rateLimitBucket.updateMany({ where: { id: { startsWith: prefix } }, data: { resetAt: new Date(0) } });
      expect((await second.increment(key)).totalHits).toBe(1);
      await first.resetKey(key);
      expect((await second.increment(key)).totalHits).toBe(1);
    } finally {
      await db.rateLimitBucket.deleteMany({ where: { id: { startsWith: prefix } } });
    }
  });
  it("registers, persists exact JSONB snapshots, isolates owners, paginates and deletes", async () => {
    const owner = await account();
    const other = await account();
    expect(Object.keys(owner.user).sort()).toEqual(["email", "id"]);
    const storedUser = await db.user.findUniqueOrThrow({ where: { id: owner.user.id } });
    expect(storedUser.passwordHash).toMatch(/^\$argon2id/);
    expect(storedUser.passwordHash).not.toBe(password);
    await owner.agent.get("/api/health").expect(200);
    await owner.agent.get("/api/cities?q=London").expect(200);
    const weather = weatherSchema.parse((await owner.agent.post("/api/weather").set("Origin", config.APP_ORIGIN).set("X-CSRF-Token", owner.csrf).send(city).expect(200)).body);
    expect(weather.current).toEqual(current);
    expect(weather.forecast).toEqual(forecast);
    const saved = weatherSchema.parse((await owner.agent.post("/api/snapshots").set("Origin", config.APP_ORIGIN).set("X-CSRF-Token", owner.csrf).send({ draftId: weather.draftId }).expect(201)).body);
    expect(saved.current).toEqual(weather.current);
    expect(saved.forecast).toEqual(weather.forecast);
    expect(saved.fetchedAt).toBe(weather.fetchedAt);
    const again = weatherSchema.parse((await owner.agent.post("/api/snapshots").set("Origin", config.APP_ORIGIN).set("X-CSRF-Token", owner.csrf).send({ draftId: weather.draftId }).expect(201)).body);
    expect(again.id).toBe(saved.id);
    await other.agent.get(`/api/snapshots/${saved.id}`).expect(404);
    await other.agent.delete(`/api/snapshots/${saved.id}`).set("Origin", config.APP_ORIGIN).set("X-CSRF-Token", other.csrf).expect(404);
    await other.agent.post("/api/snapshots").set("Origin", config.APP_ORIGIN).set("X-CSRF-Token", other.csrf).send({ draftId: weather.draftId }).expect(404);
    await db.$disconnect();
    await db.$connect();
    const reopened = weatherSchema.parse((await owner.agent.get(`/api/snapshots/${saved.id}`).expect(200)).body);
    expect(reopened.forecast).toEqual(forecast);
    const second = weatherSchema.parse((await owner.agent.post("/api/weather").set("Origin", config.APP_ORIGIN).set("X-CSRF-Token", owner.csrf).send(city).expect(200)).body);
    await owner.agent.post("/api/snapshots").set("Origin", config.APP_ORIGIN).set("X-CSRF-Token", owner.csrf).send({ draftId: second.draftId }).expect(201);
    const page = snapshotListSchema.parse((await owner.agent.get("/api/snapshots?limit=1").expect(200)).body);
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    const next = snapshotListSchema.parse((await owner.agent.get(`/api/snapshots?limit=1&cursor=${page.nextCursor}`).expect(200)).body);
    expect(next.items).toHaveLength(1);
    expect(next.items[0].id).not.toBe(page.items[0].id);
    expect(next.nextCursor).toBeNull();
    expect(snapshotListSchema.parse((await other.agent.get("/api/snapshots").expect(200)).body).items).toEqual([]);
    await owner.agent.delete(`/api/snapshots/${saved.id}`).set("Origin", config.APP_ORIGIN).set("X-CSRF-Token", owner.csrf).expect(204);
    await owner.agent.get(`/api/snapshots/${saved.id}`).expect(404);
  });
  it("rejects expired drafts, client JSON, bad input and partial provider failure", async () => {
    const owner = await account();
    const data = weatherSchema.parse((await owner.agent.post("/api/weather").set("Origin", config.APP_ORIGIN).set("X-CSRF-Token", owner.csrf).send(city).expect(200)).body);
    await db.weatherDraft.update({ where: { id: data.draftId }, data: { expiresAt: new Date(0) } });
    await owner.agent.post("/api/snapshots").set("Origin", config.APP_ORIGIN).set("X-CSRF-Token", owner.csrf).send({ draftId: data.draftId }).expect(410);
    await owner.agent.post("/api/snapshots").set("Origin", config.APP_ORIGIN).set("X-CSRF-Token", owner.csrf).send({ draftId: data.draftId, current }).expect(400);
    await owner.agent.get("/api/cities?q=x").expect(400);
    await owner.agent.get("/api/snapshots?limit=10000").expect(400);
    const failing = createApp(db, config, { ...provider, weather: async () => { throw new AppError(502, "WEATHER_UNAVAILABLE", "Upstream unavailable"); } });
    await request(failing).post("/api/weather").set("Cookie", owner.cookies).set("Origin", config.APP_ORIGIN).set("X-CSRF-Token", owner.csrf).send(city).expect(403);
    const csrfCookie = `weather_csrf=${encodeURIComponent(owner.csrf)}`;
    await request(failing).post("/api/weather").set("Cookie", [...owner.cookies, csrfCookie]).set("Origin", config.APP_ORIGIN).set("X-CSRF-Token", owner.csrf).send(city).expect(502);
    expect(await db.weatherDraft.count({ where: { userId: owner.user.id } })).toBe(1);
  });
  it("rotates refresh tokens and revokes the whole session on replay", async () => {
    const owner = await account();
    await owner.agent.post("/api/auth/refresh").set("Origin", config.APP_ORIGIN).set("X-CSRF-Token", owner.csrf).expect(200);
    await owner.agent.get("/api/auth/me").expect(200);
    await request(app).post("/api/auth/refresh").set("Cookie", [...owner.cookies, `weather_csrf=${encodeURIComponent(owner.csrf)}`]).set("Origin", config.APP_ORIGIN).set("X-CSRF-Token", owner.csrf).expect(401);
    await owner.agent.get("/api/auth/me").expect(401);
    expect((await db.session.findFirstOrThrow({ where: { userId: owner.user.id } })).revokedAt).not.toBeNull();
  });
  it("fails closed on concurrent refreshes, expires sessions and invalidates access after logout", async () => {
    const owner = await account();
    const parallel = await Promise.all([0, 1].map(() => request(app).post("/api/auth/refresh")
      .set("Cookie", [...owner.cookies, `weather_csrf=${encodeURIComponent(owner.csrf)}`]).set("Origin", config.APP_ORIGIN).set("X-CSRF-Token", owner.csrf)));
    expect(parallel.map(result => result.status).sort()).toEqual([200, 401]);
    await owner.agent.get("/api/auth/me").expect(401);
    const expiring = await account();
    await db.session.updateMany({ where: { userId: expiring.user.id }, data: { expiresAt: new Date(0) } });
    await expiring.agent.get("/api/auth/me").expect(401);
    await expiring.agent.post("/api/auth/refresh").set("Origin", config.APP_ORIGIN).set("X-CSRF-Token", expiring.csrf).expect(401);
    const loggingOut = await account();
    await loggingOut.agent.post("/api/auth/logout").set("Origin", config.APP_ORIGIN).set("X-CSRF-Token", loggingOut.csrf).expect(204);
    await request(app).get("/api/auth/me").set("Cookie", loggingOut.cookies).expect(401);
  });
  it("enforces CSRF, rejects invalid credentials and limits auth attempts", async () => {
    const owner = await account();
    await owner.agent.post("/api/auth/logout").expect(403);
    await owner.agent.post("/api/auth/logout").set("Origin", "https://evil.example").set("X-CSRF-Token", owner.csrf).expect(403);
    await owner.agent.post("/api/auth/login").set("Origin", config.APP_ORIGIN).set("X-CSRF-Token", owner.csrf).send({ email: owner.email, password: "incorrect password value" }).expect(401);
    await owner.agent.post("/api/auth/register").set("Origin", config.APP_ORIGIN).set("X-CSRF-Token", owner.csrf).send({ email: owner.email, password }).expect(409);
    await owner.agent.post("/api/auth/login").set("Origin", config.APP_ORIGIN).set("X-CSRF-Token", owner.csrf).send({ email: owner.email.toUpperCase(), password }).expect(200);
    const limited = createApp(db, config, provider);
    const agent = request.agent(limited);
    const csrf = z.object({ csrfToken: z.string() }).parse((await agent.get("/api/auth/csrf")).body).csrfToken;
    for (let i = 0; i < 20; i++) await agent.post("/api/auth/login").set("Origin", config.APP_ORIGIN).set("X-CSRF-Token", csrf).send({ email: "bad", password: "short" }).expect(400);
    await agent.post("/api/auth/login").set("Origin", config.APP_ORIGIN).set("X-CSRF-Token", csrf).send({ email: "bad", password: "short" }).expect(429);
  });
});
