import { PrismaClient } from "@prisma/client";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const db = new PrismaClient();
await db.$connect();
const server = createApp(db, config).listen(config.PORT, "127.0.0.1", () => {
  console.info(`Weather API listening on http://127.0.0.1:${config.PORT}`);
});
function shutdown() {
  server.close(() => { void db.$disconnect().then(() => process.exit(0)); });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
