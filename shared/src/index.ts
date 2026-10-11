import { z } from "zod";

const number = z.number().finite();
const timestamp = number.int();
const successCode = z.union([z.literal(200), z.literal("200")]);
const coordinates = z.object({ lat: number.min(-90).max(90), lon: number.min(-180).max(180) }).passthrough();
const condition = z.object({
  id: number.int(),
  main: z.string(),
  description: z.string(),
  icon: z.string().regex(/^\d{2}[dn]$/)
}).passthrough();
const temperatures = z.object({
  temp: number,
  feels_like: number,
  temp_min: number,
  temp_max: number,
  pressure: number,
  humidity: number.min(0).max(100)
}).passthrough();
const wind = z.object({ speed: number, deg: number.optional(), gust: number.optional() }).passthrough();
const precipitation = z.object({ "1h": number.optional(), "3h": number.optional() }).passthrough();
export const citySchema = z.object({
  name: z.string().min(1),
  lat: coordinates.shape.lat,
  lon: coordinates.shape.lon,
  country: z.string(),
  state: z.string().optional(),
  local_names: z.record(z.string()).optional()
}).passthrough();
export const currentSchema = z.object({
  cod: successCode,
  coord: coordinates,
  weather: z.array(condition),
  main: temperatures,
  wind,
  clouds: z.object({ all: number }).passthrough(),
  visibility: number.optional(),
  rain: precipitation.optional(),
  snow: precipitation.optional(),
  dt: timestamp,
  sys: z.object({ country: z.string().optional(), sunrise: timestamp.optional(), sunset: timestamp.optional() }).passthrough(),
  timezone: number.int(),
  id: number.int(),
  name: z.string()
}).passthrough();
export const forecastEntrySchema = z.object({
  dt: timestamp,
  main: temperatures,
  weather: z.array(condition),
  clouds: z.object({ all: number }).passthrough(),
  wind,
  visibility: number.optional(),
  pop: number.min(0).max(1),
  rain: precipitation.optional(),
  snow: precipitation.optional(),
  sys: z.object({ pod: z.string().optional() }).passthrough(),
  dt_txt: z.string()
}).passthrough();
export const forecastSchema = z.object({
  cod: successCode,
  message: z.union([number, z.string()]),
  cnt: number.int().nonnegative(),
  list: z.array(forecastEntrySchema),
  city: z.object({
    id: number.int(), name: z.string(), coord: coordinates,
    country: z.string(), timezone: number.int(),
    sunrise: timestamp.optional(), sunset: timestamp.optional()
  }).passthrough()
}).passthrough().refine(data => data.cnt === data.list.length, "Forecast count must match list length");
export const credentialsSchema = z.object({
  email: z.string().trim().email().max(254).transform(value => value.toLowerCase()),
  password: z.string().min(12, "Use at least 12 characters").max(128, "Use at most 128 characters")
}).strict();
export const userSchema = z.object({ id: z.string(), email: z.string().email() });
export const weatherSchema = z.object({
  draftId: z.string().uuid().optional(),
  id: z.string().uuid().optional(),
  citySelection: citySchema,
  current: currentSchema,
  forecast: forecastSchema,
  fetchedAt: z.string().datetime(),
  savedAt: z.string().datetime().optional(),
  units: z.literal("metric")
});
export const snapshotSummarySchema = z.object({
  id: z.string().uuid(), citySelection: citySchema,
  fetchedAt: z.string().datetime(), savedAt: z.string().datetime()
});
export const snapshotListSchema = z.object({
  items: z.array(snapshotSummarySchema), nextCursor: z.string().uuid().nullable()
});
export type City = z.infer<typeof citySchema>;
export type CurrentWeather = z.infer<typeof currentSchema>;
export type Forecast = z.infer<typeof forecastSchema>;
export type WeatherData = z.infer<typeof weatherSchema>;
export type User = z.infer<typeof userSchema>;
export type SnapshotSummary = z.infer<typeof snapshotSummarySchema>;
