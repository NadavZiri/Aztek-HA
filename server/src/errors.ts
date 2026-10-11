import type { ErrorRequestHandler } from "express";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";

export class AppError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  if (error instanceof AppError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message } });
  } else if (error instanceof ZodError) {
    res.status(400).json({ error: { code: "INVALID_INPUT", message: error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ") } });
  } else if (error instanceof SyntaxError && "status" in error && error.status === 400) {
    res.status(400).json({ error: { code: "INVALID_JSON", message: "The request must contain valid JSON." } });
  } else {
    // Upstream exceptions may contain credentials in URLs; log only a safe classification.
    console.error("Request failed:", error instanceof Error ? error.name : "UnknownError",
      error instanceof Prisma.PrismaClientKnownRequestError ? error.code : "");
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." } });
  }
};
