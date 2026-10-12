import { PrismaClient } from "@prisma/client";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const db = new PrismaClient();
const server = createApp(db, config).listen(config.PORT, config.BIND_HOST ?? "127.0.0.1", () => {
  console.info(`Weather API listening on ${config.BIND_HOST ?? "127.0.0.1"}:${config.PORT}`);
});
function shutdown() {
  const deadline = setTimeout(() => process.exit(1), 30000);
  deadline.unref();
  server.close(() => { void db.$disconnect().then(() => process.exit(0)); });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
