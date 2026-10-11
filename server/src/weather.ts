import { z } from "zod";
import { citySchema, currentSchema, forecastSchema, type City, type CurrentWeather, type Forecast } from "@weather/shared";
import { AppError } from "./errors.js";

export interface WeatherProvider {
  cities(query: string): Promise<City[]>;
  weather(city: City): Promise<{ current: CurrentWeather; forecast: Forecast }>;
}
export function openWeather(apiKey: string, fetcher: typeof fetch = fetch): WeatherProvider {
  async function request<T>(path: string, parameters: Record<string, string>, schema: z.ZodType<T>): Promise<T> {
    const url = new URL(path, "https://api.openweathermap.org");
    url.search = new URLSearchParams({ ...parameters, appid: apiKey }).toString();
    let response: Response;
    try {
      response = await fetcher(url, { signal: AbortSignal.timeout(10000) });
    } catch (error) {
      if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) {
        throw new AppError(504, "WEATHER_TIMEOUT", "OpenWeather took too long. Please try again.");
      }
      if (error instanceof TypeError) throw new AppError(502, "WEATHER_UNAVAILABLE", "Cannot reach OpenWeather. Please try again.");
      throw error;
    }
    if (response.status === 401 || response.status === 403) throw new AppError(502, "WEATHER_KEY_INVALID", "The server's OpenWeather key is invalid or lacks API access.");
    if (response.status === 429) throw new AppError(503, "WEATHER_QUOTA", "OpenWeather request quota reached. Please try later.");
    if (!response.ok) throw new AppError(502, "WEATHER_UNAVAILABLE", "OpenWeather could not provide this weather.");
    let raw: unknown;
    try {
      raw = await response.json();
    } catch (error) {
      if (error instanceof SyntaxError) throw new AppError(502, "WEATHER_INVALID", "OpenWeather returned invalid JSON.");
      throw error;
    }
    const result = schema.safeParse(raw);
    if (!result.success) throw new AppError(502, "WEATHER_INVALID", "OpenWeather returned an unexpected response.");
    return result.data;
  }
  return {
    cities: query => request("/geo/1.0/direct", { q: query, limit: "5" }, z.array(citySchema)),
    async weather(city) {
      const parameters = { lat: String(city.lat), lon: String(city.lon), units: "metric", lang: "en" };
      const [current, forecast] = await Promise.all([
        request("/data/2.5/weather", parameters, currentSchema),
        request("/data/2.5/forecast", parameters, forecastSchema)
      ]);
      return { current, forecast };
    }
  };
}
