import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
it("serializes simultaneous access-token refresh attempts and retries both requests", async () => {
  let refreshed = false;
  let refreshCalls = 0;
  const fetcher = vi.fn<typeof fetch>(async input => {
    const path = String(input);
    if (path === "/api/auth/csrf") return Response.json({ csrfToken: "csrf-value" });
    if (path === "/api/auth/refresh") {
      refreshCalls++;
      await new Promise(resolve => setTimeout(resolve, 10));
      refreshed = true;
      return Response.json({ user: { id: "test", email: "test@example.com" } });
    }
    return refreshed ? Response.json({ value: 1 }) : Response.json({ error: { code: "AUTH_REQUIRED", message: "Please log in" } }, { status: 401 });
  });
  vi.stubGlobal("fetch", fetcher);
  const { api } = await import("./api");
  const schema = z.object({ value: z.number() });
  expect(await Promise.all([api("/one", schema), api("/two", schema)])).toEqual([{ value: 1 }, { value: 1 }]);
  expect(refreshCalls).toBe(1);
});
it("reports provider errors rather than returning fabricated data", async () => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { code: "WEATHER_QUOTA", message: "Quota reached" } }, { status: 503 })));
  const { api } = await import("./api");
  await expect(api("/weather", z.object({}))).rejects.toMatchObject({ code: "WEATHER_QUOTA", message: "Quota reached" });
});
it("can renew CSRF during refresh without retrying invalid authentication forever", async () => {
  let csrfCalls = 0;
  let refreshCalls = 0;
  let refreshed = false;
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async input => {
    if (String(input) === "/api/auth/csrf") return Response.json({ csrfToken: `csrf-${++csrfCalls}` });
    if (String(input) === "/api/auth/refresh") {
      if (++refreshCalls === 1) return Response.json({ error: { code: "CSRF_INVALID", message: "Renew CSRF" } }, { status: 403 });
      refreshed = true;
      return Response.json({});
    }
    return refreshed ? Response.json({ value: 1 }) : Response.json({ error: { code: "AUTH_REQUIRED", message: "Please log in" } }, { status: 401 });
  }));
  const { api } = await import("./api");
  expect(await api("/protected", z.object({ value: z.number() }))).toEqual({ value: 1 });
  expect(refreshCalls).toBe(2);
  expect(csrfCalls).toBe(2);
});
