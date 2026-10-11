import { z } from "zod";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
let csrfToken: string | undefined;
let csrfPromise: Promise<string> | undefined;
let refreshPromise: Promise<void> | undefined;
const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

async function parseError(response: Response) {
  const result = errorSchema.safeParse(await response.json());
  return result.success
    ? new ApiError(response.status, result.data.error.code, result.data.error.message)
    : new ApiError(response.status, "INVALID_RESPONSE", "The server returned an unexpected error.");
}
async function csrf(): Promise<string> {
  if (csrfToken) return csrfToken;
  csrfPromise ??= fetch("/api/auth/csrf", { credentials: "same-origin" }).then(async response => {
    if (!response.ok) throw await parseError(response);
    csrfToken = z.object({ csrfToken: z.string() }).parse(await response.json()).csrfToken;
    return csrfToken;
  }).finally(() => { csrfPromise = undefined; });
  return csrfPromise;
}
async function request(path: string, options: RequestInit = {}, retryAuth = true, retryCsrf = true): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set("Content-Type", "application/json");
  if (options.method && options.method !== "GET") headers.set("X-CSRF-Token", await csrf());
  const response = await fetch(`/api${path}`, { ...options, credentials: "same-origin", headers });
  if (response.status === 401 && retryAuth && !["/auth/login", "/auth/register", "/auth/refresh", "/auth/logout"].includes(path)) {
    refreshPromise ??= request("/auth/refresh", { method: "POST" }, false)
      .then(() => undefined).finally(() => { refreshPromise = undefined; });
    await refreshPromise;
    return request(path, options, false, retryCsrf);
  }
  if (response.status === 403 && retryCsrf) {
    const error = await parseError(response);
    if (error.code === "CSRF_INVALID") {
      csrfToken = undefined;
      await csrf();
      return request(path, options, retryAuth, false);
    }
    throw error;
  }
  if (!response.ok) throw await parseError(response);
  return response;
}
export async function api<T>(path: string, schema: z.ZodType<T>, options?: RequestInit): Promise<T> {
  return schema.parse(await (await request(path, options)).json());
}
export async function removeSnapshot(id: string) { await request(`/snapshots/${id}`, { method: "DELETE" }); }
export async function logout() { await request("/auth/logout", { method: "POST" }); }
export const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
export const message = (error: unknown) => {
  if (error instanceof z.ZodError) return "The server returned an unexpected response.";
  if (error instanceof TypeError) return "Cannot reach the server. Check your connection and try again.";
  return error instanceof Error ? error.message : "An unexpected error occurred. Please try again.";
};
