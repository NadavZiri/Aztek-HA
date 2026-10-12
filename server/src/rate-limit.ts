import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { Store, Options } from "express-rate-limit";

export class DatabaseRateLimitStore implements Store {
  private windowMs = 900000;
  constructor(private db: PrismaClient, public prefix: string) {}
  init(options: Options) { this.windowMs = options.windowMs; }
  private key(value: string) { return `${this.prefix}:${createHash("sha256").update(value).digest("hex")}`; }
  async increment(key: string) {
    const id = this.key(key);
    const rows = await this.db.$queryRaw<{ hits: number; resetAt: Date }[]>`
      INSERT INTO "RateLimitBucket" ("id", "hits", "resetAt")
      VALUES (${id}, 1, CURRENT_TIMESTAMP + ${this.windowMs} * INTERVAL '1 millisecond')
      ON CONFLICT ("id") DO UPDATE SET
        "hits" = CASE WHEN "RateLimitBucket"."resetAt" <= CURRENT_TIMESTAMP THEN 1 ELSE "RateLimitBucket"."hits" + 1 END,
        "resetAt" = CASE WHEN "RateLimitBucket"."resetAt" <= CURRENT_TIMESTAMP
          THEN CURRENT_TIMESTAMP + ${this.windowMs} * INTERVAL '1 millisecond' ELSE "RateLimitBucket"."resetAt" END
      RETURNING "hits", "resetAt"
    `;
    if (!rows[0]) throw new Error("Rate limit update returned no result");
    return { totalHits: rows[0].hits, resetTime: rows[0].resetAt };
  }
  async decrement(key: string) {
    await this.db.$executeRaw`UPDATE "RateLimitBucket" SET "hits" = GREATEST(0, "hits" - 1) WHERE "id" = ${this.key(key)}`;
  }
  async resetKey(key: string) {
    await this.db.rateLimitBucket.deleteMany({ where: { id: this.key(key) } });
  }
}
