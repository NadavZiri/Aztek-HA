import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { citySchema, weatherSchema, snapshotSummarySchema } from "@weather/shared";
import { getIdentity } from "./auth.js";
import { AppError } from "./errors.js";
import { jsonValue } from "./json.js";
import type { WeatherProvider } from "./weather.js";

export async function cleanupDrafts(db: PrismaClient, limit = 100) {
  const rows = await db.weatherDraft.findMany({ where: { expiresAt: { lte: new Date() } }, take: limit, select: { id: true } });
  return db.weatherDraft.deleteMany({ where: { id: { in: rows.map(row => row.id) } } });
}
export function weatherRoutes(db: PrismaClient, provider: WeatherProvider) {
  const router = Router();
  router.get("/cities", async (req, res) => {
    const { q } = z.object({ q: z.string().trim().min(2).max(100) }).parse(req.query);
    res.json(await provider.cities(q));
  });
  router.post("/weather", async (req, res) => {
    const city = citySchema.parse(req.body);
    const identity = getIdentity(res);
    const data = await provider.weather(city);
    await cleanupDrafts(db);
    const draft = await db.weatherDraft.create({
      data: {
        userId: identity.userId, sessionId: identity.sessionId,
        citySelection: jsonValue(city), current: jsonValue(data.current), forecast: jsonValue(data.forecast),
        fetchedAt: new Date(), expiresAt: new Date(Date.now() + 30 * 60 * 1000)
      }
    });
    res.json(weatherSchema.parse({ ...draft, draftId: draft.id, id: undefined, fetchedAt: draft.fetchedAt.toISOString() }));
  });
  router.post("/snapshots", async (req, res) => {
    const { draftId } = z.object({ draftId: z.string().uuid() }).strict().parse(req.body);
    const identity = getIdentity(res);
    const snapshot = await db.$transaction(async tx => {
      const existing = await tx.weatherSnapshot.findFirst({ where: { sourceDraftId: draftId, userId: identity.userId } });
      if (existing) return existing;
      const draft = await tx.weatherDraft.findFirst({ where: { id: draftId, userId: identity.userId, sessionId: identity.sessionId } });
      if (!draft) throw new AppError(404, "DRAFT_NOT_FOUND", "This weather draft was not found. Reload the weather.");
      if (draft.expiresAt <= new Date()) throw new AppError(410, "DRAFT_EXPIRED", "This weather draft expired. Reload the weather before saving.");
      return tx.weatherSnapshot.upsert({
        where: { sourceDraftId: draftId }, update: {},
        create: {
          sourceDraftId: draftId, userId: identity.userId, citySelection: jsonValue(draft.citySelection),
          current: jsonValue(draft.current), forecast: jsonValue(draft.forecast), units: draft.units, fetchedAt: draft.fetchedAt
        }
      });
    });
    res.status(201).json(weatherSchema.parse({ ...snapshot, fetchedAt: snapshot.fetchedAt.toISOString(), savedAt: snapshot.savedAt.toISOString() }));
  });
  router.get("/snapshots", async (req, res) => {
    const { cursor, limit } = z.object({
      cursor: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(50).default(12)
    }).parse(req.query);
    const { userId } = getIdentity(res);
    const anchor = cursor ? await db.weatherSnapshot.findFirst({ where: { id: cursor, userId } }) : null;
    if (cursor && !anchor) throw new AppError(404, "SNAPSHOT_NOT_FOUND", "This page was not found.");
    const rows = await db.weatherSnapshot.findMany({
      where: {
        userId, ...(anchor ? { OR: [
          { savedAt: { lt: anchor.savedAt } },
          { savedAt: anchor.savedAt, id: { lt: anchor.id } }
        ] } : {})
      },
      orderBy: [{ savedAt: "desc" }, { id: "desc" }], take: limit + 1,
      select: { id: true, citySelection: true, fetchedAt: true, savedAt: true }
    });
    const items = rows.slice(0, limit).map(row => snapshotSummarySchema.parse({
      ...row, fetchedAt: row.fetchedAt.toISOString(), savedAt: row.savedAt.toISOString()
    }));
    res.json({ items, nextCursor: rows.length > limit ? items.at(-1)?.id : null });
  });
  router.get("/snapshots/:id", async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const row = await db.weatherSnapshot.findFirst({ where: { id, userId: getIdentity(res).userId } });
    if (!row) throw new AppError(404, "SNAPSHOT_NOT_FOUND", "This saved snapshot was not found.");
    res.json(weatherSchema.parse({ ...row, fetchedAt: row.fetchedAt.toISOString(), savedAt: row.savedAt.toISOString() }));
  });
  router.delete("/snapshots/:id", async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const result = await db.weatherSnapshot.deleteMany({ where: { id, userId: getIdentity(res).userId } });
    if (result.count !== 1) throw new AppError(404, "SNAPSHOT_NOT_FOUND", "This saved snapshot was not found.");
    res.status(204).end();
  });
  return router;
}
