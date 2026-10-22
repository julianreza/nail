// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OverviewPayload } from "../../app/dashboard-overview";
import DashboardOverview from "../../app/dashboard-overview";

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => Object.assign(new EventTarget(), {
    matches: false,
    media: "(prefers-reduced-motion: reduce)",
  }));
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function payload(name: string): OverviewPayload {
  return {
    projectsCount: 0,
    agentsCount: 1,
    agents: [{
      id: "saved-agent", name, role: "pm", projectId: null, providerId: null,
      providerName: null, providerStatus: null, model: null, modelMatchesProvider: true,
      skillIds: ["planning"],
    }],
    activeRunsCount: 0,
    queuedRunsCount: 0,
    pendingApprovalsCount: 0,
  };
}

function response(value: unknown, status = 200) {
  return Response.json(value, { status });
}

it("loads the saved roster and refreshes it after an agent-list event", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(response(payload("Original")))
    .mockResolvedValueOnce(response(payload("Renamed elsewhere")));
  vi.stubGlobal("fetch", fetcher);
  const { container } = render(<DashboardOverview />);
  await waitFor(() => expect(container.querySelector('[data-agent-card="saved-agent"]')?.textContent).toContain("Original"));
  await act(async () => { window.dispatchEvent(new Event("agent-list-refresh")); });
  await waitFor(() => expect(container.querySelector('[data-agent-card="saved-agent"]')?.textContent).toContain("Renamed elsewhere"));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls.every(([url, init]) => url === "/api/overview" && init.cache === "no-store")).toBe(true);
});

it("refreshes on focus for changes made in another tab", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(response(payload("Before focus")))
    .mockResolvedValueOnce(response(payload("After focus")));
  vi.stubGlobal("fetch", fetcher);
  const { container } = render(<DashboardOverview />);
  await waitFor(() => expect(container.textContent).toContain("Before focus"));
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  await waitFor(() => expect(container.textContent).toContain("After focus"));
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("preserves the last good roster on refresh error and retries explicitly", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(response(payload("Saved safely")))
    .mockResolvedValueOnce(response({ error: "temporary outage" }, 503))
    .mockResolvedValueOnce(response(payload("Saved after retry")));
  vi.stubGlobal("fetch", fetcher);
  const { container, getByRole, queryByRole } = render(<DashboardOverview />);
  await waitFor(() => expect(container.textContent).toContain("Saved safely"));
  await act(async () => { window.dispatchEvent(new Event("agent-list-refresh")); });
  await waitFor(() => expect(getByRole("alert").textContent).toContain("temporary outage"));
  expect(container.querySelector('[data-agent-card="saved-agent"]')?.textContent).toContain("Saved safely");
  expect(container.textContent).toContain("1 agent tersimpan");
  await act(async () => { getByRole("button", { name: "Coba lagi" }).click(); });
  await waitFor(() => expect(container.textContent).toContain("Saved after retry"));
  expect(queryByRole("alert")).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("does not let a slower older response replace a newer roster", async () => {
  let finishOld!: (value: Response) => void;
  const oldResponse = new Promise<Response>((resolve) => { finishOld = resolve; });
  const fetcher = vi.fn().mockReturnValueOnce(oldResponse).mockResolvedValueOnce(response(payload("Newest")));
  vi.stubGlobal("fetch", fetcher);
  const { container } = render(<DashboardOverview />);
  await act(async () => { window.dispatchEvent(new Event("agent-list-refresh")); });
  await waitFor(() => expect(container.textContent).toContain("Newest"));
  await act(async () => { finishOld(response(payload("Stale"))); });
  expect(container.textContent).toContain("Newest");
  expect(container.textContent).not.toContain("Stale");
});

it("aborts the active request and removes listeners on unmount", async () => {
  let signal: AbortSignal | undefined;
  const fetcher = vi.fn((_url: string, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>(() => undefined);
  });
  vi.stubGlobal("fetch", fetcher);
  const { unmount } = render(<DashboardOverview />);
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  unmount();
  expect(signal?.aborted).toBe(true);
  window.dispatchEvent(new Event("agent-list-refresh"));
  window.dispatchEvent(new Event("focus"));
  expect(fetcher).toHaveBeenCalledTimes(1);
});
