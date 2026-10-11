import express from "express";
import cookieParser from "cookie-parser";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAuth } from "../src/auth";
import { errorHandler } from "../src/errors";

const db = new PrismaClient();
const config = {
  DATABASE_URL: "postgresql://unused:unused@localhost:5432/unused",
  JWT_SECRET: "csrf-regression-test-secret-at-least-32-characters",
  OPENWEATHER_API_KEY: "unused",
  APP_ORIGIN: "http://localhost:5173",
  PORT: 3001,
  NODE_ENV: "test" as const
};
const auth = createAuth(db, config);
const app = express();
app.use(cookieParser(), auth.csrf);
app.use("/auth", auth.router);
app.post("/protected", (_req, res) => res.status(204).end());
app.use(errorHandler);
const responseSchema = z.object({ csrfToken: z.string() });

describe("CSRF protection", () => {
  it("keeps the existing signed token across page loads so another tab does not invalidate it", async () => {
    const agent = request.agent(app);
    const first = responseSchema.parse((await agent.get("/auth/csrf").expect(200)).body).csrfToken;
    const secondResponse = await agent.get("/auth/csrf").expect(200);
    const second = responseSchema.parse(secondResponse.body).csrfToken;
    expect(second).toBe(first);
    expect(secondResponse.headers["set-cookie"]).toBeUndefined();
    await agent.post("/protected").set("Origin", config.APP_ORIGIN).set("X-CSRF-Token", first).expect(204);
  });
  it("replaces tampered cookies and rejects their tokens", async () => {
    const agent = request.agent(app);
    const original = responseSchema.parse((await agent.get("/auth/csrf").expect(200)).body).csrfToken;
    const bad = `${original}.extra`;
    await request(app).post("/protected").set("Cookie", `weather_csrf=${bad}`)
      .set("Origin", config.APP_ORIGIN).set("X-CSRF-Token", bad).expect(403);
    const replacement = responseSchema.parse((await request(app).get("/auth/csrf")
      .set("Cookie", `weather_csrf=${bad}`).expect(200)).body).csrfToken;
    expect(replacement).not.toBe(bad);
  });
  it("rejects missing or mismatched headers and reports wrong origins distinctly", async () => {
    const agent = request.agent(app);
    const token = responseSchema.parse((await agent.get("/auth/csrf").expect(200)).body).csrfToken;
    await agent.post("/protected").set("Origin", config.APP_ORIGIN).expect(403);
    await agent.post("/protected").set("Origin", config.APP_ORIGIN).set("X-CSRF-Token", "wrong").expect(403);
    const wrongOrigin = await agent.post("/protected").set("Origin", "http://127.0.0.1:5173")
      .set("X-CSRF-Token", token).expect(403);
    expect(wrongOrigin.body).toEqual({ error: { code: "ORIGIN_INVALID", message: `Open the app at ${config.APP_ORIGIN}, or ask the administrator to correct APP_ORIGIN.` } });
    await agent.post("/protected").set("X-CSRF-Token", token).expect(403);
  });
});
