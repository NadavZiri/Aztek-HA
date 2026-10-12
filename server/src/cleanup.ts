import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";
import { cleanupDrafts } from "./routes.js";

dotenv.config();
if (process.env.DEPLOYMENT_ROLE === "standby") {
  console.info("Standby region skips database cleanup.");
  process.exit(0);
}
const db = new PrismaClient();
try {
  let total = 0;
  let count;
  do {
    ({ count } = await cleanupDrafts(db, 1000));
    total += count;
  } while (count === 1000);
  console.info(`Removed ${total} expired weather drafts.`);
  const limits = await db.rateLimitBucket.deleteMany({ where: { resetAt: { lt: new Date() } } });
  console.info(`Removed ${limits.count} expired rate-limit buckets.`);
} finally {
  await db.$disconnect();
}
