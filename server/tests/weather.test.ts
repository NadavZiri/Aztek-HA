import { describe, expect, it, vi } from "vitest";
import { openWeather } from "../src/weather";
import { city, current, forecast } from "../../shared/src/fixtures";

describe("OpenWeather client", () => {
  it("calls coordinate endpoints in metric units and retains responses", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(current)).mockResolvedValueOnce(Response.json(forecast));
    expect(await openWeather("test-key", fetcher).weather(city)).toEqual({ current, forecast });
    const urls = fetcher.mock.calls.map(call => new URL(String(call[0])));
    expect(urls.map(url => url.pathname)).toEqual(["/data/2.5/weather", "/data/2.5/forecast"]);
    expect(urls.every(url => url.searchParams.get("units") === "metric" && url.searchParams.get("lat") === String(city.lat))).toBe(true);
  });
  it("uses geocoding and preserves disambiguation metadata", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json([{ ...city, state: "England" }]));
    const result = await openWeather("test-key", fetcher).cities("London,GB");
    expect(result[0].state).toBe("England");
    expect(new URL(String(fetcher.mock.calls[0][0])).pathname).toBe("/geo/1.0/direct");
  });
  it.each([[401, "WEATHER_KEY_INVALID"], [403, "WEATHER_KEY_INVALID"], [429, "WEATHER_QUOTA"], [500, "WEATHER_UNAVAILABLE"]])("reports upstream %s without exposing credentials", async (status, code) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("provider error", { status }));
    await expect(openWeather("private-key", fetcher).cities("London")).rejects.toMatchObject({ code });
  });
  it("reports invalid JSON, unexpected payloads, network errors and timeouts", async () => {
    const badJson = vi.fn<typeof fetch>().mockResolvedValue(new Response("not json"));
    await expect(openWeather("key", badJson).cities("London")).rejects.toMatchObject({ code: "WEATHER_INVALID" });
    const badSchema = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ cod: 200 }));
    await expect(openWeather("key", badSchema).cities("London")).rejects.toMatchObject({ code: "WEATHER_INVALID" });
    const network = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("request failed"));
    await expect(openWeather("key", network).cities("London")).rejects.toMatchObject({ code: "WEATHER_UNAVAILABLE" });
    const timeout = vi.fn<typeof fetch>().mockRejectedValue(new DOMException("timeout", "TimeoutError"));
    await expect(openWeather("key", timeout).cities("London")).rejects.toMatchObject({ code: "WEATHER_TIMEOUT" });
  });
});
