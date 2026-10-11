import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();
const configSchema = z.object({
  DATABASE_URL: z.string().url().refine(value => /^postgres(ql)?:/.test(value), "Use a PostgreSQL URL"),
  JWT_SECRET: z.string().min(32).refine(value => !value.startsWith("replace-"), "Replace the example JWT secret"),
  OPENWEATHER_API_KEY: z.string().min(1).refine(value => !value.startsWith("replace-"), "Set a real OpenWeather key"),
  APP_ORIGIN: z.string().url().transform(value => new URL(value).origin),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development")
}).refine(value => value.NODE_ENV !== "production" || value.APP_ORIGIN.startsWith("https://"), {
  path: ["APP_ORIGIN"], message: "Production requires HTTPS"
});
export type Config = z.infer<typeof configSchema>;
export function loadConfig(): Config {
  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    throw new Error(`Invalid configuration: ${result.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  return result.data;
}
