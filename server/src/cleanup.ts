import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";
import { cleanupDrafts } from "./routes.js";

dotenv.config();
const db = new PrismaClient();
try {
  let total = 0;
  let count;
  do {
    ({ count } = await cleanupDrafts(db, 1000));
    total += count;
  } while (count === 1000);
  console.info(`Removed ${total} expired weather drafts.`);
} finally {
  await db.$disconnect();
}
