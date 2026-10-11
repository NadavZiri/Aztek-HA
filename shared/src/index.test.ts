import { describe, expect, it } from "vitest";
import { citySchema, credentialsSchema, currentSchema, forecastSchema } from "./index";
import { city, current, forecast } from "./fixtures";

describe("OpenWeather response contracts", () => {
  it("preserves provider fields, nesting, unknown properties and code types", () => {
    expect(currentSchema.parse(current)).toEqual(current);
    expect(forecastSchema.parse(forecast)).toEqual(forecast);
    expect(currentSchema.parse({ ...current, extra: { retained: true }, cod: "200" }).extra).toEqual({ retained: true });
    expect(forecastSchema.parse({ ...forecast, cod: 200 }).cod).toBe(200);
    expect(citySchema.parse({ ...city, local_names: { he: "London" }, state: "England" }).state).toBe("England");
  });
  it("allows missing optional readings and empty conditions", () => {
    const without = { ...current };
    delete without.visibility;
    const parsed = currentSchema.parse({ ...without, weather: [], sys: {}, wind: { speed: 0 } });
    expect(parsed.visibility).toBeUndefined();
    expect(parsed.rain).toBeUndefined();
    expect(parsed.sys.sunrise).toBeUndefined();
  });
  it("rejects provider errors, inconsistent forecasts and invalid coordinates", () => {
    expect(currentSchema.safeParse({ cod: 401, message: "Invalid API key" }).success).toBe(false);
    expect(forecastSchema.safeParse({ ...forecast, cnt: 1 }).success).toBe(false);
    expect(citySchema.safeParse({ ...city, lat: 91 }).success).toBe(false);
  });
  it("normalizes emails without changing passwords", () => {
    const parsed = credentialsSchema.parse({ email: " USER@EXAMPLE.COM ", password: "  long password  " });
    expect(parsed.email).toBe("user@example.com");
    expect(parsed.password).toBe("  long password  ");
    expect(credentialsSchema.safeParse({ email: "a@b.com", password: "short" }).success).toBe(false);
  });
});
