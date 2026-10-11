import express from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { resolve } from "node:path";
import type { PrismaClient } from "@prisma/client";
import type { Config } from "./config.js";
import { createAuth } from "./auth.js";
import { weatherRoutes } from "./routes.js";
import { AppError, errorHandler } from "./errors.js";
import { openWeather, type WeatherProvider } from "./weather.js";

export function createApp(db: PrismaClient, config: Config, provider: WeatherProvider = openWeather(config.OPENWEATHER_API_KEY)) {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet({
    contentSecurityPolicy: {
      directives: { "img-src": ["'self'", "https://openweathermap.org", "data:"], "upgrade-insecure-requests": config.NODE_ENV === "production" ? [] : null }
    },
    strictTransportSecurity: config.NODE_ENV === "production" ? undefined : false
  }));
  app.use(express.json({ limit: "16kb" }), cookieParser());
  app.use("/api", (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  app.get("/api/health", async (_req, res) => {
    await db.$queryRaw`SELECT 1`;
    res.json({ status: "ok" });
  });
  const auth = createAuth(db, config);
  const limiter = (limit: number) => rateLimit({
    windowMs: 15 * 60 * 1000, limit, standardHeaders: "draft-7", legacyHeaders: false,
    message: { error: { code: "RATE_LIMIT", message: "Too many requests. Please try again later." } }
  });
  app.use("/api", auth.csrf);
  app.use(["/api/auth/login", "/api/auth/register"], limiter(20));
  app.use("/api/auth", limiter(150), auth.router);
  app.use("/api", auth.requireUser, limiter(120), weatherRoutes(db, provider));
  app.use("/api", () => { throw new AppError(404, "NOT_FOUND", "This endpoint was not found."); });
  if (config.NODE_ENV === "production") {
    const client = resolve(process.cwd(), "../client/dist");
    app.use(express.static(client));
    app.get("/{*path}", (_req, res) => res.sendFile(resolve(client, "index.html")));
  }
  app.use(errorHandler);
  return app;
}
