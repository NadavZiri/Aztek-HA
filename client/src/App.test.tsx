import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { city, current, forecast } from "../../shared/src/fixtures";
import { App } from "./App";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("wires city selection, unit conversion, exact draft saving and saved-snapshot viewing", async () => {
  const draftId = "11111111-1111-4111-8111-111111111111";
  const id = "22222222-2222-4222-8222-222222222222";
  const weather = { draftId, citySelection: city, current, forecast, fetchedAt: "2026-10-11T12:00:00.000Z", units: "metric" };
  const saved = { ...weather, draftId: undefined, id, savedAt: "2026-10-11T12:01:00.000Z" };
  let savedOnce = false;
  const fetcher = vi.fn<typeof fetch>(async (input, options) => {
    const path = String(input);
    if (path === "/api/auth/me") return Response.json({ user: { id: "owner", email: "user@example.com" } });
    if (path === "/api/auth/csrf") return Response.json({ csrfToken: "csrf" });
    if (path === "/api/snapshots" && options?.method === "POST") { savedOnce = true; return Response.json(saved, { status: 201 }); }
    if (path === "/api/snapshots") return Response.json({ items: savedOnce ? [{ id, citySelection: city, fetchedAt: weather.fetchedAt, savedAt: saved.savedAt }] : [], nextCursor: null });
    if (path.startsWith("/api/cities")) return Response.json([city]);
    if (path === "/api/weather") return Response.json(weather);
    if (path === `/api/snapshots/${id}`) return Response.json(saved);
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal("fetch", fetcher);
  render(<App />);
  await screen.findByText("Your forecast, in focus.");
  fireEvent.change(screen.getByLabelText("Search for a city"), { target: { value: "London" } });
  fireEvent.click(screen.getByRole("button", { name: "Find city" }));
  fireEvent.click(await screen.findByRole("button", { name: /London.*GB/ }));
  await screen.findByText("Save this forecast");
  fireEvent.click(screen.getByRole("button", { name: "°F" }));
  expect(screen.getByRole("button", { name: "°F" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "Save this forecast" }));
  await screen.findByText("Snapshot saved to your collection.");
  await waitFor(() => expect(fetcher.mock.calls.find(call => String(call[0]) === "/api/snapshots" && call[1]?.method === "POST")?.[1]?.body).toBe(JSON.stringify({ draftId })));
  fireEvent.click(await screen.findByRole("button", { name: /London GB/ }));
  await screen.findByText("From your collection");
  expect(screen.queryByRole("button", { name: "Save this forecast" })).not.toBeInTheDocument();
});
