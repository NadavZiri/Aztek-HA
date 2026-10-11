export type Units = "celsius" | "fahrenheit";
export const temperature = (celsius: number, units: Units) => Math.round(units === "celsius" ? celsius : celsius * 9 / 5 + 32);
export const windSpeed = (ms: number, units: Units) => `${(units === "celsius" ? ms : ms * 2.236936).toFixed(1)} ${units === "celsius" ? "m/s" : "mph"}`;
export function cityTime(seconds: number, offset: number, options: Intl.DateTimeFormatOptions = { weekday: "short", hour: "numeric", minute: "2-digit" }) {
  return new Intl.DateTimeFormat("en", { ...options, timeZone: "UTC" }).format(new Date((seconds + offset) * 1000));
}
export function offsetLabel(offset: number) {
  const sign = offset >= 0 ? "+" : "-";
  const minutes = Math.abs(offset) / 60;
  return `UTC${sign}${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
