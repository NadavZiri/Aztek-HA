import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { WeatherView } from "./WeatherView";
import { city, current, forecast } from "../../shared/src/fixtures";

afterEach(cleanup);
it("shows actual three-hour intervals, units, provider attribution and missing optional values", () => {
  render(<WeatherView data={{ citySelection: city, current: { ...current, visibility: undefined, weather: [] }, forecast, units: "metric", fetchedAt: new Date().toISOString() }} units="fahrenheit" />);
  expect(screen.getByText("Condition unavailable")).toBeInTheDocument();
  expect(screen.getByText("Unavailable")).toBeInTheDocument();
  expect(screen.getByText("3-hour intervals")).toBeInTheDocument();
  expect(screen.getByRole("img", { name: /40 three-hour forecast intervals/ })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "OpenWeather" })).toBeInTheDocument();
  expect(document.querySelectorAll(".forecast-item")).toHaveLength(40);
});
