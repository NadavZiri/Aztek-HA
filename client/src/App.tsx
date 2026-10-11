import { useEffect, useRef, useState, type FormEvent } from "react";
import { z } from "zod";
import { citySchema, userSchema, weatherSchema, snapshotListSchema, type City, type User, type WeatherData, type SnapshotSummary } from "@weather/shared";
import { api, ApiError, logout, message, post, removeSnapshot } from "./api";
import { WeatherView } from "./WeatherView";
import type { Units } from "./format";

const authResponse = z.object({ user: userSchema });

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [register, setRegister] = useState(false);
  const [busy, setBusy] = useState(false);
  const [weatherBusy, setWeatherBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [cities, setCities] = useState<City[]>([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searched, setSearched] = useState(false);
  const [data, setData] = useState<WeatherData | null>(null);
  const [units, setUnits] = useState<Units>("celsius");
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const detailRef = useRef<HTMLElement>(null);

  function fail(error: unknown) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    setError(message(error));
    if (error instanceof ApiError && error.status === 401 && error.code !== "INVALID_CREDENTIALS") {
      requestRef.current?.abort();
      setUser(null); setData(null); setSnapshots([]); setCities([]); setQuery(""); setNotice("");
    }
  }
  useEffect(() => {
    let active = true;
    api("/auth/me", authResponse).then(result => { if (active) setUser(result.user); })
      .catch(error => { if (active && !(error instanceof ApiError && error.status === 401)) setError(message(error)); })
      .finally(() => { if (active) setInitializing(false); });
    return () => { active = false; requestRef.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    api("/snapshots", snapshotListSchema, { signal: controller.signal })
      .then(result => { setSnapshots(result.items); setNextCursor(result.nextCursor); }).catch(fail);
    return () => controller.abort();
  }, [user]);
  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    const values = new FormData(event.currentTarget);
    try {
      const result = await api(`/auth/${register ? "register" : "login"}`, authResponse, post({ email: values.get("email"), password: values.get("password") }));
      setUser(result.user);
    } catch (error) { fail(error); } finally { setBusy(false); }
  }
  async function search(event: FormEvent) {
    event.preventDefault();
    requestRef.current?.abort();
    const controller = new AbortController(); requestRef.current = controller;
    setSearchBusy(true); setWeatherBusy(false); setSearched(false); setError(""); setCities([]);
    try {
      const result = await api(`/cities?q=${encodeURIComponent(query.trim())}`, z.array(citySchema), { signal: controller.signal });
      if (!controller.signal.aborted) { setCities(result); setSearched(true); }
    } catch (error) { fail(error); } finally { if (!controller.signal.aborted) setSearchBusy(false); }
  }
  async function selectCity(city: City) {
    requestRef.current?.abort();
    const controller = new AbortController(); requestRef.current = controller;
    setWeatherBusy(true); setSearchBusy(false); setError(""); setNotice(""); setData(null); setCities([]); setSearched(false);
    try {
      const result = await api("/weather", weatherSchema, { ...post(city), signal: controller.signal });
      if (!controller.signal.aborted) { setData(result); detailRef.current?.focus(); }
    } catch (error) { fail(error); } finally { if (!controller.signal.aborted) setWeatherBusy(false); }
  }
  async function refreshList(cursor?: string) {
    const result = await api(`/snapshots${cursor ? `?cursor=${cursor}` : ""}`, snapshotListSchema);
    setSnapshots(previous => cursor ? [...previous, ...result.items] : result.items); setNextCursor(result.nextCursor);
  }
  async function save() {
    if (!data?.draftId || busy || weatherBusy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const saved = await api("/snapshots", weatherSchema, post({ draftId: data.draftId }));
      setData(saved); setNotice("Snapshot saved to your collection."); await refreshList();
    } catch (error) { fail(error); } finally { setBusy(false); }
  }
  async function view(id: string) {
    requestRef.current?.abort();
    const controller = new AbortController(); requestRef.current = controller;
    setWeatherBusy(true); setSearchBusy(false); setData(null); setError(""); setNotice("");
    try {
      const result = await api(`/snapshots/${id}`, weatherSchema, { signal: controller.signal });
      if (!controller.signal.aborted) { setData(result); detailRef.current?.focus(); }
    } catch (error) { fail(error); } finally { if (!controller.signal.aborted) setWeatherBusy(false); }
  }
  async function erase(id: string) {
    if (!window.confirm("Delete this saved snapshot? This cannot be undone.")) return;
    setBusy(true); setError("");
    try {
      await removeSnapshot(id); if (data?.id === id) setData(null);
      setNotice("Snapshot deleted."); await refreshList();
    } catch (error) { fail(error); } finally { setBusy(false); }
  }
  async function signOut() {
    setBusy(true); setError("");
    try {
      await logout(); requestRef.current?.abort(); setUser(null); setData(null); setSnapshots([]); setCities([]);
      setQuery(""); setNotice(""); setWeatherBusy(false); setSearchBusy(false); setSearched(false);
    } catch (error) { fail(error); } finally { setBusy(false); }
  }

  return <div className="app-shell">
    <header className="header">
      <a className="brand" href="/"><span className="brand-mark" aria-hidden="true">A</span><span>atmosphere<small>WEATHER, COLLECTED</small></span></a>
      {user && <div className="account"><span>{user.email}</span><button className="subtle" onClick={() => void signOut()} disabled={busy}>Log out</button></div>}
    </header>
    <main>
      {error && <div className="alert" role="alert">{error}<button aria-label="Dismiss error" onClick={() => setError("")}>×</button></div>}
      {notice && <div className="notice" role="status">{notice}</div>}
      {initializing ? <p className="loading" role="status">Checking your session...</p> : !user ? <div className="welcome-layout">
        <section className="welcome"><div className="eyebrow">YOUR WINDOW TO THE WORLD</div><h1>A little weather.<br /><em>A wider perspective.</em></h1><p>Find the forecast wherever life takes you. Keep a snapshot of the skies that matter.</p><div className="decorative-orbit" aria-hidden="true"><div className="sun" /><span>EVERY CITY. EVERY SEASON.</span></div></section>
        <section className="panel auth-panel"><div className="eyebrow">MAKE YOURSELF AT HOME</div><h2>{register ? "Create your account" : "Welcome back"}</h2><p className="muted">{register ? "Start your own weather collection." : "Log in to explore and save forecasts."}</p>
          <form onSubmit={event => void authenticate(event)}>
            <label htmlFor="email">Email address</label><input id="email" name="email" type="email" autoComplete="email" required maxLength={254} placeholder="you@example.com" />
            <label htmlFor="password">Password</label><input id="password" name="password" type="password" autoComplete={register ? "new-password" : "current-password"} required minLength={12} maxLength={128} aria-describedby="password-help" />
            <small id="password-help">12-128 characters. Your password is securely hashed.</small>
            <button className="primary" disabled={busy}>{busy ? "Please wait..." : register ? "Create account" : "Log in"}</button>
          </form>
          <button className="text-button" disabled={busy} onClick={() => { setRegister(!register); setError(""); }}>{register ? "Already have an account? Log in" : "New here? Create an account"}</button>
        </section>
      </div> : <>
        <section className="dashboard-heading"><div><div className="eyebrow">EXPLORE THE ELEMENTS</div><h1>Your forecast, in focus.</h1><p className="muted">Choose a city. Get a fresh outlook. Save the moment.</p></div><div className="unit-toggle" aria-label="Temperature units"><button aria-pressed={units === "celsius"} onClick={() => setUnits("celsius")}>°C</button><button aria-pressed={units === "fahrenheit"} onClick={() => setUnits("fahrenheit")}>°F</button></div></section>
        <div className="dashboard-grid">
          <div className="weather-column">
            <section className="search-panel panel">
              <form onSubmit={event => void search(event)} className="search-form"><label className="sr-only" htmlFor="city">Search for a city</label><input id="city" value={query} onChange={event => { requestRef.current?.abort(); setSearchBusy(false); setWeatherBusy(false); setQuery(event.target.value); setCities([]); setSearched(false); }} placeholder="Search city, country (e.g. London, GB)" minLength={2} maxLength={100} required /><button className="primary" disabled={searchBusy || busy}>{searchBusy ? "Searching..." : "Find city"}</button></form>
              {cities.length > 0 && <ul className="city-results">{cities.map(city => <li key={`${city.lat}:${city.lon}:${city.name}`}><button disabled={busy} onClick={() => void selectCity(city)}><strong>{city.name}</strong><span>{[city.state, city.country].filter(Boolean).join(", ")} · {city.lat.toFixed(2)}, {city.lon.toFixed(2)}</span></button></li>)}</ul>}
              {searched && !cities.length && <p role="status">No cities found. Try adding a country code.</p>}
            </section>
            <section ref={detailRef} tabIndex={-1} className="weather-detail">
              {weatherBusy ? <div className="panel empty-state" role="status"><div className="loader" /><h2>Gathering your forecast...</h2></div> : data ? <><div className="weather-actions"><span className="tag">{data.savedAt ? "From your collection" : "Fresh from OpenWeather"}</span>{data.draftId && <button className="primary" onClick={() => void save()} disabled={busy}>{busy ? "Saving..." : "Save this forecast"}</button>}</div><WeatherView data={data} units={units} /></> : <div className="panel empty-state"><div className="empty-symbol" aria-hidden="true">☀</div><h2>Where to?</h2><p className="muted">Search for a city above to see what the sky has in store.</p></div>}
            </section>
          </div>
          <aside className="panel collection"><div className="eyebrow">YOUR PERSONAL ARCHIVE</div><h2>Saved skies <span>{snapshots.length}</span></h2><p className="muted">Forecasts preserved exactly as you saw them.</p>
            {!snapshots.length && <div className="collection-empty">No snapshots yet.<br />Find a city and save your first forecast.</div>}
            <ul>{snapshots.map(snapshot => <li key={snapshot.id}><button className="snapshot-link" disabled={busy} onClick={() => void view(snapshot.id)}><strong>{snapshot.citySelection.name}</strong><span>{snapshot.citySelection.country} · {new Date(snapshot.savedAt).toLocaleDateString()}</span><small>{new Date(snapshot.savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small></button><button className="delete-button" disabled={busy} aria-label={`Delete snapshot for ${snapshot.citySelection.name}`} onClick={() => void erase(snapshot.id)}>×</button></li>)}</ul>
            {nextCursor && <button className="subtle" disabled={busy} onClick={() => { setBusy(true); void refreshList(nextCursor).catch(fail).finally(() => setBusy(false)); }}>Load more</button>}
          </aside>
        </div>
      </>}
    </main>
    <footer>Made for the curious. Powered by <a href="https://openweathermap.org/" target="_blank" rel="noreferrer">OpenWeather</a>.</footer>
  </div>;
}
