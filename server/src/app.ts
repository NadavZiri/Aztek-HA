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
import { staticFrontend } from "./static.js";
import { databaseReady } from "./readiness.js";
import { timingSafeEqual } from "node:crypto";
import { DatabaseRateLimitStore } from "./rate-limit.js";

export function createApp(db: PrismaClient, config: Config, provider: WeatherProvider = openWeather(config.OPENWEATHER_API_KEY)) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.TRUST_PROXY_HOPS ?? 0);
  app.get("/health/live", (_req, res) => res.set("Cache-Control", "no-store").json({ status: "alive" }));
  app.get("/health/ready", async (_req, res) => {
    try {
      const role = config.DEPLOYMENT_ROLE ?? "active";
      const ready = await databaseReady(db, role);
      res.set("Cache-Control", "no-store").status(ready ? 200 : 503).json({ status: ready ? "ready" : role === "standby" ? "standby" : "unavailable" });
    } catch (error) {
      console.error("Database readiness failed:", error instanceof Error ? error.name : "UnknownError");
      res.set("Cache-Control", "no-store").status(503).json({ status: "unavailable" });
    }
  });
  if (config.FRONT_DOOR_ID || config.FRONT_DOOR_SECRET) {
    if (!config.FRONT_DOOR_ID || !config.FRONT_DOOR_SECRET) throw new Error("Both Front Door origin settings are required");
    const secret = Buffer.from(config.FRONT_DOOR_SECRET);
    app.use((req, res, next) => {
      const supplied = Buffer.from(req.get("X-Origin-Secret") ?? "");
      if (req.get("X-Azure-FDID") !== config.FRONT_DOOR_ID ||
        supplied.length !== secret.length || !timingSafeEqual(supplied, secret)) {
        res.set("Cache-Control", "no-store");
        throw new AppError(403, "ORIGIN_DENIED", "Access this application through its public endpoint.");
      }
      next();
    });
  }
  app.use(helmet({
    contentSecurityPolicy: {
      directives: { "img-src": ["'self'", "https://openweathermap.org", "data:"], "upgrade-insecure-requests": config.NODE_ENV === "production" ? [] : null }
    },
    strictTransportSecurity: config.NODE_ENV === "production" ? undefined : false
  }));
  app.use(express.json({ limit: "16kb" }), cookieParser());
  app.use("/api", (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  app.use("/api", (_req, _res, next) => {
    if (config.DEPLOYMENT_ROLE === "standby") throw new AppError(503, "REGION_STANDBY", "This region is not accepting requests.");
    next();
  });
  app.get("/api/health", async (_req, res) => {
    await db.$queryRaw`SELECT 1`;
    res.json({ status: "ok" });
  });
  const auth = createAuth(db, config);
  const limiter = (limit: number, prefix: string) => rateLimit({
    windowMs: 15 * 60 * 1000, limit, standardHeaders: "draft-7", legacyHeaders: false,
    ...(config.NODE_ENV === "production" ? { store: new DatabaseRateLimitStore(db, prefix) } : {}),
    message: { error: { code: "RATE_LIMIT", message: "Too many requests. Please try again later." } }
  });
  app.use("/api", auth.csrf);
  app.use(["/api/auth/login", "/api/auth/register"], limiter(20, "credentials"));
  app.use("/api/auth", limiter(150, "auth"), auth.router);
  app.use("/api", auth.requireUser, limiter(120, "weather"), weatherRoutes(db, provider));
  app.use("/api", () => { throw new AppError(404, "NOT_FOUND", "This endpoint was not found."); });
  if (config.NODE_ENV === "production") {
    const client = resolve(process.cwd(), "../client/dist");
    app.use(staticFrontend(client));
  }
  app.use(errorHandler);
  return app;
}
