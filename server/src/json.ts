import type { Prisma } from "@prisma/client";

export function jsonValue(value: unknown): Prisma.InputJsonValue {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => item === null ? null : jsonValue(item));
  if (value !== null && typeof value === "object") {
    const output: Record<string, Prisma.InputJsonValue | null> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) output[key] = item === null ? null : jsonValue(item);
    }
    return output;
  }
  throw new Error("Expected a non-null JSON value");
}
