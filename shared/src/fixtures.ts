import { currentSchema, forecastSchema, type City } from "./index";

export const city: City = { name: "London", country: "GB", lat: 51.5074, lon: -0.1278 };
export const current = currentSchema.parse({
  coord: { lat: city.lat, lon: city.lon },
  weather: [{ id: 800, main: "Clear", description: "clear sky", icon: "01d" }],
  base: "stations",
  main: { temp: 16.5, feels_like: 15.8, temp_min: 15.3, temp_max: 17.2, pressure: 1018, humidity: 65, sea_level: 1018 },
  visibility: 10000, wind: { speed: 3.1, deg: 240 }, clouds: { all: 0 },
  dt: 1791716400, sys: { country: "GB", sunrise: 1791698100, sunset: 1791737400 },
  timezone: 3600, id: 2643743, name: "London", cod: 200
});
export const forecast = forecastSchema.parse({
  cod: "200", message: 0, cnt: 40,
  list: Array.from({ length: 40 }, (_, index) => ({
    dt: current.dt + (index + 1) * 10800,
    main: { temp: Number((16 + Math.sin(index / 3) * 5).toFixed(2)), feels_like: 15, temp_min: 15, temp_max: 17, pressure: 1017, humidity: 70, temp_kf: 0 },
    weather: [{ id: 801, main: "Clouds", description: "few clouds", icon: index % 8 < 4 ? "02d" : "02n" }],
    clouds: { all: 20 }, wind: { speed: 2.5, deg: 230 }, visibility: 10000,
    pop: .2, sys: { pod: index % 8 < 4 ? "d" : "n" },
    dt_txt: new Date((current.dt + (index + 1) * 10800) * 1000).toISOString().slice(0, 19).replace("T", " ")
  })),
  city: { id: 2643743, name: "London", coord: { lat: city.lat, lon: city.lon }, country: "GB", population: 1000000, timezone: 3600, sunrise: 1791698100, sunset: 1791737400 }
});
