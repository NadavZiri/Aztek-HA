import type { PrismaClient } from "@prisma/client";

export async function databaseReady(db: PrismaClient, role: "active" | "standby") {
  if (role !== "active") return false;
  const state = await db.$queryRaw<{ writable: boolean; migrated: boolean }[]>`
    SELECT NOT pg_is_in_recovery() AND current_setting('transaction_read_only') = 'off' AS writable,
      to_regclass('"User"') IS NOT NULL AND to_regclass('"WeatherSnapshot"') IS NOT NULL
        AND to_regclass('"Session"') IS NOT NULL AND to_regclass('"RefreshToken"') IS NOT NULL
        AND to_regclass('"WeatherDraft"') IS NOT NULL
        AND to_regclass('"RateLimitBucket"') IS NOT NULL AS migrated
  `;
  return state[0]?.writable === true && state[0]?.migrated === true;
}
