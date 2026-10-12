import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ASSET_CACHE, HTML_CACHE, staticFrontend } from "../src/static";

let directory: string;
const app = express();
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "weather-static-"));
  await mkdir(join(directory, "assets"));
  await writeFile(join(directory, "index.html"), "<html>weather</html>");
  await writeFile(join(directory, "assets", "index-AbCd1234.js"), "console.log('weather');");
  await writeFile(join(directory, "favicon.svg"), "<svg/>");
  app.get("/api/private", (_req, res) => res.set("Cache-Control", "no-store").json({ private: true }));
  app.use(staticFrontend(directory));
});
afterAll(async () => { await rm(directory, { recursive: true }); });
it("caches hashed public assets immutably, including tracking query strings", async () => {
  const response = await request(app).get("/assets/index-AbCd1234.js?utm_source=test").expect(200);
  expect(response.headers["cache-control"]).toBe(ASSET_CACHE);
  expect(response.headers["set-cookie"]).toBeUndefined();
});
it("revalidates HTML in browsers and limits shared cache staleness to 60 seconds", async () => {
  for (const path of ["/", "/index.html", "/saved"]) {
    const response = await request(app).get(path).expect(200);
    expect(response.headers["cache-control"]).toBe(HTML_CACHE);
  }
});
it("uses short caching for unversioned files and no-store for missing bundles", async () => {
  expect((await request(app).get("/favicon.svg").expect(200)).headers["cache-control"]).toBe("public, max-age=300");
  expect((await request(app).get("/assets/missing.js").expect(404)).headers["cache-control"]).toBe("no-store");
});
it("leaves authenticated API routes uncached", async () => {
  expect((await request(app).get("/api/private").expect(200)).headers["cache-control"]).toBe("no-store");
});
