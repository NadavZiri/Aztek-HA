import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import argon2 from "argon2";
import { SignJWT, jwtVerify, errors as jwtErrors } from "jose";
import { Router, type CookieOptions, type RequestHandler, type Response } from "express";
import { credentialsSchema } from "@weather/shared";
import { z } from "zod";
import type { Config } from "./config.js";
import { AppError } from "./errors.js";

const ACCESS = "weather_access";
const REFRESH = "weather_refresh";
const CSRF = "weather_csrf";
const ACCESS_SECONDS = 15 * 60;
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
export const passwordOptions = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
export const hashPassword = (password: string) => argon2.hash(password, passwordOptions);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const equal = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const claims = z.object({ sub: z.string().uuid(), sid: z.string().uuid() });
export interface Identity { userId: string; sessionId: string }

export function createAuth(db: PrismaClient, config: Config) {
  const key = new TextEncoder().encode(config.JWT_SECRET);
  const cookie: CookieOptions = { httpOnly: true, secure: config.NODE_ENV === "production", sameSite: "lax", path: "/" };
  const signature = (value: string) => createHmac("sha256", config.JWT_SECRET).update(value).digest("base64url");
  let dummyHash: Promise<string> | undefined;
  function validCsrf(raw: unknown): raw is string {
    if (typeof raw !== "string") return false;
    const parts = raw.split(".");
    return parts.length === 2 && /^[A-Za-z0-9_-]{43}$/.test(parts[0])
      && /^[A-Za-z0-9_-]{43}$/.test(parts[1]) && equal(signature(parts[0]), parts[1]);
  }

  function clear(res: Response) {
    res.clearCookie(ACCESS, cookie);
    res.clearCookie(REFRESH, cookie);
  }
  async function issue(res: Response, userId: string, sessionId: string, refresh: string, expiresAt: Date) {
    const access = await new SignJWT({ sid: sessionId }).setProtectedHeader({ alg: "HS256" })
      .setSubject(userId).setIssuer("aztek-weather").setAudience("weather-web")
      .setIssuedAt().setExpirationTime(`${ACCESS_SECONDS}s`).sign(key);
    res.cookie(ACCESS, access, { ...cookie, maxAge: ACCESS_SECONDS * 1000 });
    res.cookie(REFRESH, refresh, { ...cookie, expires: expiresAt });
  }
  const csrf: RequestHandler = (req, _res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
    const header = req.get("X-CSRF-Token");
    const raw: unknown = req.cookies[CSRF];
    if (req.get("Origin") !== config.APP_ORIGIN) {
      throw new AppError(403, "ORIGIN_INVALID", `Open the app at ${config.APP_ORIGIN}, or ask the administrator to correct APP_ORIGIN.`);
    }
    if (!validCsrf(raw) || !header || !equal(raw, header)) {
      throw new AppError(403, "CSRF_INVALID", "Refresh the page and try again.");
    }
    next();
  };
  const requireUser: RequestHandler = async (req, res, next) => {
    const raw: unknown = req.cookies[ACCESS];
    if (typeof raw !== "string") throw new AppError(401, "AUTH_REQUIRED", "Please log in.");
    let identity: z.infer<typeof claims>;
    try {
      const { payload } = await jwtVerify(raw, key, { algorithms: ["HS256"], issuer: "aztek-weather", audience: "weather-web" });
      identity = claims.parse(payload);
    } catch (error) {
      if (error instanceof jwtErrors.JOSEError || error instanceof z.ZodError) {
        throw new AppError(401, "AUTH_REQUIRED", "Your session has expired. Please log in.");
      }
      throw error;
    }
    const session = await db.session.findFirst({
      where: { id: identity.sid, userId: identity.sub, revokedAt: null, expiresAt: { gt: new Date() } }
    });
    if (!session) throw new AppError(401, "AUTH_REQUIRED", "Your session has ended. Please log in.");
    res.locals.identity = { userId: identity.sub, sessionId: identity.sid } satisfies Identity;
    next();
  };
  const router = Router();
  router.get("/csrf", (req, res) => {
    const existing: unknown = req.cookies[CSRF];
    if (validCsrf(existing)) {
      res.json({ csrfToken: existing });
      return;
    }
    const value = token();
    const signed = `${value}.${signature(value)}`;
    res.cookie(CSRF, signed, { ...cookie, maxAge: SESSION_MS });
    res.json({ csrfToken: signed });
  });
  async function newSession(res: Response, user: { id: string; email: string }) {
    const refresh = token();
    const expiresAt = new Date(Date.now() + SESSION_MS);
    const session = await db.session.create({
      data: { userId: user.id, expiresAt, refreshTokens: { create: { hash: digest(refresh) } } }
    });
    await issue(res, user.id, session.id, refresh, expiresAt);
    return { id: user.id, email: user.email };
  }
  router.post("/register", async (req, res) => {
    const { email, password } = credentialsSchema.parse(req.body);
    const passwordHash = await hashPassword(password);
    let user;
    try {
      user = await db.user.create({ data: { email, passwordHash }, select: { id: true, email: true } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new AppError(409, "EMAIL_EXISTS", "An account with this email already exists.");
      }
      throw error;
    }
    res.status(201).json({ user: await newSession(res, user) });
  });
  router.post("/login", async (req, res) => {
    const { email, password } = credentialsSchema.parse(req.body);
    const user = await db.user.findUnique({ where: { email } });
    dummyHash ??= hashPassword(token());
    const valid = await argon2.verify(user?.passwordHash ?? await dummyHash, password);
    if (!user || !valid) throw new AppError(401, "INVALID_CREDENTIALS", "Incorrect email or password.");
    res.json({ user: await newSession(res, user) });
  });
  router.post("/refresh", async (req, res) => {
    const raw: unknown = req.cookies[REFRESH];
    if (typeof raw !== "string" || raw.length > 100) {
      clear(res);
      throw new AppError(401, "AUTH_REQUIRED", "Please log in.");
    }
    const nextToken = token();
    const result = await db.$transaction(async tx => {
      const previous = await tx.refreshToken.findUnique({ where: { hash: digest(raw) }, include: { session: { include: { user: true } } } });
      if (!previous || previous.session.revokedAt || previous.session.expiresAt <= new Date()) return null;
      const consumed = await tx.refreshToken.updateMany({ where: { id: previous.id, consumedAt: null }, data: { consumedAt: new Date() } });
      if (consumed.count !== 1) {
        await tx.session.update({ where: { id: previous.sessionId }, data: { revokedAt: new Date() } });
        return null;
      }
      await tx.refreshToken.create({ data: { sessionId: previous.sessionId, hash: digest(nextToken) } });
      return previous.session;
    });
    if (!result) {
      clear(res);
      throw new AppError(401, "AUTH_REQUIRED", "Your session has ended. Please log in.");
    }
    await issue(res, result.userId, result.id, nextToken, result.expiresAt);
    res.json({ user: { id: result.user.id, email: result.user.email } });
  });
  router.post("/logout", async (req, res) => {
    const raw: unknown = req.cookies[REFRESH];
    if (typeof raw === "string") {
      const refresh = await db.refreshToken.findUnique({ where: { hash: digest(raw) } });
      if (refresh) await db.session.update({ where: { id: refresh.sessionId }, data: { revokedAt: new Date() } });
    }
    clear(res);
    res.status(204).end();
  });
  router.get("/me", requireUser, async (_req, res) => {
    const identity = getIdentity(res);
    const user = await db.user.findUniqueOrThrow({ where: { id: identity.userId }, select: { id: true, email: true } });
    res.json({ user });
  });
  return { router, csrf, requireUser };
}

export function getIdentity(res: Response): Identity {
  return z.object({ userId: z.string().uuid(), sessionId: z.string().uuid() }).parse(res.locals.identity);
}
