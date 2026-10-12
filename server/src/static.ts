import express, { Router } from "express";
import { basename, resolve } from "node:path";

export const ASSET_CACHE = "public, max-age=31536000, immutable";
export const HTML_CACHE = "public, max-age=0, s-maxage=60, must-revalidate";

export function staticFrontend(directory: string) {
  const router = Router();
  router.use(express.static(directory, {
    setHeaders(res, path) {
      const name = basename(path);
      if (name === "index.html") {
        res.setHeader("Cache-Control", HTML_CACHE);
      } else if (/[/\\]assets[/\\]/.test(path) && /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/i.test(name)) {
        res.setHeader("Cache-Control", ASSET_CACHE);
      } else {
        res.setHeader("Cache-Control", "public, max-age=300");
      }
    }
  }));
  router.get("/{*path}", (req, res, next) => {
    // Missing assets must not be cached as a successful HTML response.
    if (req.path.startsWith("/assets/")) {
      res.set("Cache-Control", "no-store").status(404).end();
      return;
    }
    res.set("Cache-Control", HTML_CACHE);
    res.sendFile(resolve(directory, "index.html"), error => {
      if (error) next(error);
    });
  });
  return router;
}
