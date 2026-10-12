import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const base = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3309";
const standby = process.env.SMOKE_STANDBY_URL ?? "http://127.0.0.1:3310";
const headers = {
  "X-Azure-FDID": "11111111-1111-4111-8111-111111111111",
  "X-Origin-Secret": "isolated-validation-origin-secret-32",
  Origin: "https://weather.example.test"
};
let cookies = new Map();
async function call(path, init = {}) {
  const response = await fetch(base + path, {
    ...init, headers: { ...headers, Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; "), ...init.headers }
  });
  for (const cookie of response.headers.getSetCookie()) {
    const [name, ...value] = cookie.split(";")[0].split("=");
    cookies.set(name, value.join("="));
  }
  return response;
}
assert.equal((await fetch(base + "/health/live")).status, 200);
assert.equal((await fetch(base + "/health/ready")).status, 200);
assert.equal((await fetch(base + "/")).status, 403);
const home = await call("/");
assert.equal(home.status, 200);
assert.match(home.headers.get("cache-control"), /s-maxage=60/);
const html = await home.text();
const asset = html.match(/src="([^"]+\.js)"/)?.[1];
assert.ok(asset);
assert.match((await call(asset)).headers.get("cache-control"), /immutable/);
const csrfResponse = await call("/api/auth/csrf");
assert.match(csrfResponse.headers.get("cache-control"), /no-store/);
const csrf = (await csrfResponse.json()).csrfToken;
const registration = await call("/api/auth/register", {
  method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
  body: JSON.stringify({ email: `container-${randomUUID()}@example.test`, password: "isolated validation password" })
});
assert.equal(registration.status, 201);
const user = (await registration.json()).user;
assert.ok(user.id);
assert.equal((await call("/api/auth/me")).status, 200);
assert.deepEqual((await (await call("/api/snapshots")).json()).items, []);
assert.equal((await call("/api/auth/logout", { method: "POST", headers: { "X-CSRF-Token": csrf } })).status, 204);
assert.equal((await call("/api/auth/me")).status, 401);
assert.equal((await fetch(standby + "/health/live")).status, 200);
assert.equal((await fetch(standby + "/health/ready")).status, 503);
assert.equal((await fetch(standby + "/api/auth/csrf", { headers })).status, 503);
cookies = new Map();
console.info("Container smoke passed: origin gate, static cache, non-cached auth, database writes, logout and standby. No live provider calls.");
