# Atmosphere

A React/TypeScript weather app with an Express API, PostgreSQL and Prisma. Register or log in, find a city, view current conditions and a five-day forecast at three-hour intervals, and save the displayed data to your private collection.

## Local setup (PowerShell)

Requirements: Node.js 22.12+ on the 22 release line, Node.js 24.x, or Node.js 26+; npm; and PostgreSQL. Docker Desktop is an optional way to run PostgreSQL.

```powershell
npm ci
Copy-Item .env.example .env
Copy-Item server\.env.example server\.env
```

Edit the ignored environment files:

- Root `.env`: set `POSTGRES_PASSWORD` for the local Compose database.
- `server\.env`: set `DATABASE_URL` to that database with the same password (URL-encode special characters), a random `JWT_SECRET` of at least 32 characters, and your `OPENWEATHER_API_KEY`.
- Keep `APP_ORIGIN=http://localhost:5173` for development. Open the app using this exact origin rather than the IP address; CSRF validation checks the origin.

Generate a JWT secret locally, then paste it into the ignored server environment file:

```powershell
node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
```

Obtain an [OpenWeather API key](https://home.openweathermap.org/api_keys) with access to Current Weather, five-day/three-hour forecast and Direct Geocoding. Newly issued keys may take time to activate. Keys never belong in the client or prompt log.

```powershell
docker compose up -d db
npm run db:generate
npm run db:migrate
npm run dev
```

Open http://localhost:5173. Vite proxies `/api` to Express on `127.0.0.1:3001`. PostgreSQL is bound to localhost on port 5432, with data retained in the Compose named volume. You can use an existing PostgreSQL database instead of Compose.

`npm run dev` and `npm run build` are also available as VS Code tasks.

## Commands

Run from the repository root:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run Vite and Express in watch mode |
| `npm run typecheck` | Check frontend, backend, tests and shared types |
| `npm run lint` | ESLint application and shared TypeScript |
| `npm test` | Unit/UI tests; integration tests run when `TEST_DATABASE_URL` is set |
| `npm test -- shared/src/index.test.ts` | Run one test file |
| `npm test -- server/tests/auth.test.ts -t "stores distinct"` | Run a single named test |
| `npm run test:integration` | Run real PostgreSQL tests; requires `TEST_DATABASE_URL` |
| `npm run build` | Bundle backend and build frontend |
| `npm start` | Start the built backend; production mode serves the built frontend |
| `npm run db:generate` | Generate Prisma Client |
| `npm run db:migrate` | Apply committed migrations |
| `npm run db:cleanup` | Delete expired weather drafts in batches |

For integration tests use a **separate migrated database**, not your production database. Tests create uniquely named users and remove only their own records:

```powershell
$env:TEST_DATABASE_URL = "postgresql://USER:PASSWORD@localhost:5432/weather_test"
$env:DATABASE_URL = $env:TEST_DATABASE_URL
npm run db:migrate
npm run test:integration
npm test
```

Integration tests use documented-shape fixtures for OpenWeather but a real PostgreSQL connection for authentication, JSONB snapshots, ownership, pagination and deletion. `server\tests\browser-server.ts` is a fixture-only browser-validation API, requiring `TEST_DATABASE_URL`; it is not used by the normal app. Live API verification requires a real key and is separate from fixture validation.

## Architecture and data flow

- `client`: React UI, runtime-validated API client, unit conversion, city-local timestamp formatting and saved collection.
- `server`: Express routes, Argon2id authentication, JWT/refresh sessions, OpenWeather requests, Prisma persistence and explicit error envelopes.
- `shared`: Zod contracts shared by browser/server. Provider schemas retain unknown fields and documented optional properties.

The server queries:

1. [Direct Geocoding](https://openweathermap.org/api/geocoding-api): `/geo/1.0/direct?q=...&limit=5`.
2. [Current Weather](https://openweathermap.org/api/current): `/data/2.5/weather?lat=...&lon=...&units=metric&lang=en`.
3. [Five-day forecast](https://openweathermap.org/api/forecast5): `/data/2.5/forecast?lat=...&lon=...&units=metric&lang=en`.

Successful current/forecast results are stored in a 30-minute, owner/session-scoped draft before being returned to the UI. Save submits only its draft ID; the server copies the displayed dataset to a private snapshot without refetching. Repeated saves of a draft are idempotent. Saved snapshots keep original `fetchedAt` separately from `savedAt`; views do not call OpenWeather.

Weather JSON is stored as PostgreSQL JSONB with provider names/nesting and extra fields intact. JSONB does not preserve textual formatting/key order. App metadata is kept outside provider payloads. Display conversions do not alter storage: Celsius/m/s or Fahrenheit/mph, with pressure in hPa and visibility in km. Missing readings show as unavailable, not zero. Times use Unix seconds plus the provider's fixed city offset, not an inferred IANA timezone; this does not predict DST transitions. The chart plots the supplied three-hour intervals, not invented hourly/daily readings.

## Authentication

Passwords are 12-128 characters, hashed with Argon2id (19 MiB memory, two iterations, one lane, unique random salts). Emails are trimmed and normalized to lowercase; passwords are not trimmed.

Access JWTs last 15 minutes and are algorithm/issuer/audience/session validated. Refresh sessions have a seven-day absolute lifetime; opaque refresh tokens rotate on use and only SHA-256 verifiers are stored. Consumed tokens remain in the session to detect replay, which revokes the entire session. Simultaneous reuse fails closed; the client serializes refreshes within a tab. Concurrent refreshes from separate tabs can end the session and require login again.

Cookies are HttpOnly, SameSite=Lax, scoped to `/`, and Secure in production. Access JWTs never go in localStorage. Protected routes check session revocation in PostgreSQL, so logout invalidates outstanding access JWTs. Mutation routes require a signed CSRF cookie/header pair and the configured Origin. Auth and weather endpoints are IP-rate-limited. There is no password reset or email verification in this version.

## API

All API responses disable caching. Errors have `{ "error": { "code": "...", "message": "..." } }`.

| Endpoint | Contract |
| --- | --- |
| `GET /api/health` | Database health |
| `GET /api/auth/csrf` | CSRF cookie and `{ csrfToken }` |
| `POST /api/auth/register` | `{ email, password }`; returns `{ user }` and session cookies |
| `POST /api/auth/login` | `{ email, password }`; returns `{ user }` and session cookies |
| `POST /api/auth/refresh` | Rotate refresh token; returns `{ user }` |
| `POST /api/auth/logout` | Revoke session and clear cookies |
| `GET /api/auth/me` | Authenticated `{ user }` |
| `GET /api/cities?q=...` | Authenticated provider geocoding array |
| `POST /api/weather` | Selected geocoding object; returns `{ draftId, citySelection, current, forecast, fetchedAt, units }` |
| `POST /api/snapshots` | `{ draftId }`; returns saved weather plus `id` and `savedAt` |
| `GET /api/snapshots?limit=12&cursor=...` | `{ items, nextCursor }`; maximum page size 50 |
| `GET /api/snapshots/:id` | Owner-scoped saved dataset |
| `DELETE /api/snapshots/:id` | Owner-scoped delete; 204 |

Schedule `npm run db:cleanup` to remove expired drafts; weather fetches also perform bounded cleanup. Session/token records currently remain for replay auditing; add an explicit retention policy before a large production rollout.

## Production run

Build with `npm run build`. Set `NODE_ENV=production`, an HTTPS `APP_ORIGIN`, server secrets and `DATABASE_URL`, then run `npm start`. The built backend serves frontend assets, binds to loopback, and expects a same-origin HTTPS reverse proxy. Trust-proxy settings are deliberately not guessed: configure an exact trusted proxy topology before deployment so IP rate limiting uses the intended client address. Deployment is outside this version's scope.

## Session records and Copilot

[prompts.md](prompts.md) records the session conversation and file-change summaries, excluding secrets. [.github/copilot-instructions.md](.github/copilot-instructions.md) describes repository conventions. [.vscode/mcp.json](.vscode/mcp.json) configures Playwright MCP; start/approve it in VS Code for browser interactions.
