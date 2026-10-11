# Repository context

Atmosphere is a React/TypeScript weather app with an Express backend and Prisma/PostgreSQL persistence. See [README.md](../README.md) for environment setup and API contracts.

## Build, test and lint

- Install: `npm ci`; generate Prisma Client: `npm run db:generate`; apply committed migrations: `npm run db:migrate`.
- Run: `npm run dev`; production bundles: `npm run build`; built server: `npm start`.
- Validate: `npm run typecheck`, `npm run lint`, `npm test`.
- Single file: `npm test -- shared/src/index.test.ts`; single named test: `npm test -- server/tests/auth.test.ts -t "stores distinct"`.
- Real PostgreSQL tests: set `TEST_DATABASE_URL` to a separate migrated database, then `npm run test:integration`. Normal `npm test` skips database tests when that variable is absent.
- Node requirements follow root package.json; use npm workspaces and the committed root lockfile. Prisma CLI is a root devDependency so npm applies the patched `deepmerge-ts` override to its config dependency.

## Architecture

- `client` is React/Vite; `server` is Express; `shared` supplies Zod schemas and types to both. Vite proxies `/api` to port 3001. Backend builds use esbuild with an explicit shared-package alias; frontend builds use Vite.
- The browser calls Express; Express calls OpenWeather with a server-only API key. Use Direct Geocoding for city search and coordinates for Current Weather and the five-day forecast endpoints.
- Users register/login and select a city with country/state disambiguation. Show current conditions and the five-day forecast at three-hour intervals using responsive weather cards and a temperature chart.
- Default to Celsius with a Fahrenheit toggle. Unit conversion is a presentation concern; retain provider payloads in their fetched units.
- PostgreSQL holds users, revocable authentication sessions and private saved weather snapshots. Users can list, view and delete their own snapshots.

## Authentication contract

- Email/password registration and login. Hash passwords with Argon2id, using unique salts and explicit cost parameters; store only encoded hashes and use library verification for login.
- Short-lived access JWTs and rotating refresh tokens travel in HttpOnly cookies, not localStorage. Store refresh-token verifiers as hashes, support replay detection and revoke sessions on logout.
- Validate access-token session revocation on protected requests so logout also invalidates outstanding access tokens.
- Cookie-authenticated mutations need CSRF protection. Keep passwords, hashes, tokens and OpenWeather API keys out of responses, logs and the prompt transcript.

## Weather and snapshot contracts

- Preserve OpenWeather field names, nesting and unknown fields in stored JSONB; keep app metadata separate from provider payloads.
- Validate the fields the UI consumes while accommodating optional precipitation, gust, visibility and sunrise/sunset fields. Do not treat absent values as measured zero.
- Handle provider `cod` string/number differences explicitly. The five-day forecast is three-hourly, not hourly.
- Provider timestamps are Unix seconds; use the supplied city offset for display rather than the browser timezone. Do not treat `dt_txt` as browser-local time.
- Save both current weather and forecast together as the exact dataset displayed, not a new fetch on Save. The backend returns an owner/session-scoped, 30-minute draft ID and copies that draft into a snapshot transactionally; client-submitted JSON is not authoritative. Save is idempotent by source draft ID.
- Snapshot reads/deletes and draft saves must enforce authenticated ownership. Saved snapshot views do not require live OpenWeather calls.
- API metadata dates are ISO strings; provider dates remain Unix seconds. Database rows must be serialized through shared schemas before responding so owner/session fields do not leak.
- `server/tests/browser-server.ts` is a fixture-only browser harness; normal startup never substitutes fixtures for live weather. Integration tests create unique test users and clean up only those records.

## Repository-specific conventions

- Maintain [app_prompts.md](../app_prompts.md) with the user's prompts, clarification selections and assistant answers throughout this session. Explicitly notify the user whenever files are added, changed or deleted; redact secrets from the transcript.
- The existing [.gitignore](../.gitignore) excludes `.env` and `.env.*`, but permits `.env.example`. Use example files for placeholders and ignored environment files for real configuration.
- [.vscode/mcp.json](../.vscode/mcp.json) configures the Playwright MCP server for browser interactions through VS Code. It runs via `npx -y @playwright/mcp@latest` and requires Node.js 18 or newer. Start/approve it through VS Code's MCP controls; this configuration is not an application test runner.
- Backend configuration is loaded from `server/.env` because npm workspace scripts run in that directory. The root `.env` supplies Docker Compose only. Browser origin must match `APP_ORIGIN` exactly for mutations.
- The client serializes refresh attempts within a tab and independently bounds authentication/CSRF retries. Concurrent cross-tab refresh reuse fails closed by revoking the session.
