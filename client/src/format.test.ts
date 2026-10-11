import { describe, expect, it } from "vitest";
import { cityTime, offsetLabel, temperature, windSpeed } from "./format";

describe("weather presentation", () => {
  it("converts metric values only for display", () => {
    expect(temperature(0, "fahrenheit")).toBe(32);
    expect(temperature(20, "celsius")).toBe(20);
    expect(windSpeed(1, "celsius")).toBe("1.0 m/s");
    expect(windSpeed(1, "fahrenheit")).toBe("2.2 mph");
  });
  it("uses city offsets rather than browser timezone, including fractional-hour offsets", () => {
    expect(cityTime(0, 19800, { hour: "2-digit", minute: "2-digit", hour12: false })).toBe("05:30");
    expect(offsetLabel(19800)).toBe("UTC+05:30");
    expect(offsetLabel(-12600)).toBe("UTC-03:30");
  });
});
