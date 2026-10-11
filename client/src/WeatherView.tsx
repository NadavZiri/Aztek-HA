import type { WeatherData } from "@weather/shared";
import { cityTime, offsetLabel, temperature, windSpeed, type Units } from "./format";

export function WeatherView({ data, units }: { data: WeatherData; units: Units }) {
  const { current, forecast, citySelection } = data;
  const condition = current.weather[0];
  const suffix = units === "celsius" ? "C" : "F";
  const offset = current.timezone;
  const points = forecast.list.map(entry => ({ dt: entry.dt, value: temperature(entry.main.temp, units) }));
  const values = points.map(point => point.value);
  const min = Math.min(...values);
  const range = Math.max(1, Math.max(...values) - min);
  const x = (index: number) => 30 + index / Math.max(1, points.length - 1) * 740;
  const y = (value: number) => 145 - (value - min) / range * 110;
  return <section aria-label={`Weather for ${citySelection.name}`} className="weather-view">
    <article className={`current-card ${condition?.icon.endsWith("n") ? "night" : ""}`}>
      <div className="eyebrow">{data.savedAt ? "SAVED SNAPSHOT" : "CURRENT CONDITIONS"}</div>
      <div className="current-top">
        <div>
          <h2>{citySelection.name}</h2>
          <p className="location">{[citySelection.state, citySelection.country].filter(Boolean).join(", ")}</p>
          <p className="city-clock">{cityTime(current.dt, offset)} · {offsetLabel(offset)}</p>
        </div>
        {condition && <img className="condition-icon" src={`https://openweathermap.org/img/wn/${condition.icon}@4x.png`} alt={condition.description} />}
      </div>
      <div className="temperature">{temperature(current.main.temp, units)}<span>°{suffix}</span></div>
      <p className="condition">{condition?.description ?? "Condition unavailable"}</p>
      <p>Feels like {temperature(current.main.feels_like, units)}° · Observed low {temperature(current.main.temp_min, units)}° / high {temperature(current.main.temp_max, units)}°</p>
      <div className="metrics">
        <div><span>Humidity</span><strong>{current.main.humidity}%</strong></div>
        <div><span>Wind</span><strong>{windSpeed(current.wind.speed, units)}</strong></div>
        <div><span>Pressure</span><strong>{current.main.pressure} hPa</strong></div>
        <div><span>Visibility</span><strong>{current.visibility === undefined ? "Unavailable" : `${(current.visibility / 1000).toFixed(1)} km`}</strong></div>
      </div>
    </article>
    <article className="panel forecast-panel">
      <div className="section-heading"><div><div className="eyebrow">THE DAYS AHEAD</div><h3>5-day outlook</h3></div><span className="tag">3-hour intervals</span></div>
      <p className="muted">Forecast local time uses {offsetLabel(forecast.city.timezone)} (fixed provider offset).</p>
      {points.length ? <>
        <svg className="chart" viewBox="0 0 800 180" role="img" aria-label={`Temperature trend across ${points.length} three-hour forecast intervals, in degrees ${suffix}`}>
          <defs><linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#6fd9df" stopOpacity=".3" /><stop offset="100%" stopColor="#6fd9df" stopOpacity="0" /></linearGradient></defs>
          <path d={`M ${x(0)} 170 ${points.map((point, index) => `L ${x(index)} ${y(point.value)}`).join(" ")} L ${x(points.length - 1)} 170 Z`} fill="url(#chart-fill)" />
          <polyline points={points.map((point, index) => `${x(index)},${y(point.value)}`).join(" ")} fill="none" stroke="#6fd9df" strokeWidth="3" />
          <text x="8" y="25" fill="#a6b6cb" fontSize="14">{Math.max(...values)}°</text><text x="8" y="167" fill="#a6b6cb" fontSize="14">{min}°</text>
        </svg>
        <div className="forecast-scroll" tabIndex={0} aria-label="Scrollable three-hour forecast">
          {forecast.list.map(entry => <div className="forecast-item" key={entry.dt}>
            <time dateTime={new Date(entry.dt * 1000).toISOString()}>{cityTime(entry.dt, forecast.city.timezone, { weekday: "short", hour: "numeric" })}</time>
            {entry.weather[0] && <img src={`https://openweathermap.org/img/wn/${entry.weather[0].icon}@2x.png`} alt={entry.weather[0].description} />}
            <strong>{temperature(entry.main.temp, units)}°{suffix}</strong>
            <span>{Math.round(entry.pop * 100)}% rain/snow</span>
            <small>{entry.rain?.["3h"] === undefined ? "" : `${entry.rain["3h"]} mm rain`}{entry.snow?.["3h"] === undefined ? "" : ` ${entry.snow["3h"]} mm snow`}</small>
          </div>)}
        </div>
      </> : <p>No forecast intervals were returned.</p>}
    </article>
    <p className="data-note">Retrieved {new Date(data.fetchedAt).toLocaleString()}{data.savedAt ? ` · Saved ${new Date(data.savedAt).toLocaleString()}` : ""} · Weather data by <a href="https://openweathermap.org/" target="_blank" rel="noreferrer">OpenWeather</a></p>
  </section>;
}
