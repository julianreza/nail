// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import CodexDirectProviderCard from "../../app/codex-direct-provider-card";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

interface AccountFixture {
  enabled: boolean;
  providerId: string | null;
  state: "not_configured" | "connected";
  model: string | null;
  revision: number;
  inferenceReady: false;
}
const baseAccount: AccountFixture = { enabled: true, providerId: null, state: "not_configured", model: null, revision: 0, inferenceReady: false };
const connectedAccount: AccountFixture = { enabled: true, providerId: "provider-direct", state: "connected", model: null, revision: 2, inferenceReady: false };

function installFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

it("offers direct ChatGPT connection without binding/model/token inputs", async () => {
  const fetcher = installFetch(async (url) => {
    if (url === "/api/providers/codex-direct/account") return Response.json(baseAccount);
    if (url === "/api/providers/codex-direct/login/start") return Response.json({
      providerId: "provider-direct", loginId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      verificationUri: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGH",
      intervalSeconds: 5, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    }, { status: 201 });
    throw new Error(`Unexpected request ${url}`);
  });
  const user = userEvent.setup();
  render(<CodexDirectProviderCard />);
  const card = await screen.findByRole("article", { name: "Codex Subscription — tanpa CLI" });
  expect(within(card).queryByLabelText("Binding ID")).toBeNull();
  expect(within(card).queryByLabelText("Model ID")).toBeNull();
  expect(within(card).queryByLabelText(/token|API key/i)).toBeNull();
  await user.click(within(card).getByRole("button", { name: "Hubungkan ChatGPT" }));
  const link = await within(card).findByRole("link", { name: "Buka halaman login ChatGPT" });
  expect(link.getAttribute("href")).toBe("https://auth.openai.com/codex/device");
  expect(link.getAttribute("rel")).toContain("noopener");
  expect(within(card).getByText("ABCD-EFGH")).toBeTruthy();
  expect(within(card).getByText("Gunakan kode ini hanya jika Anda sendiri memulai login di Nail.")).toBeTruthy();
  expect(fetcher.mock.calls.some(([url]) => String(url).includes("code="))).toBe(false);
});

it("polls no sooner than the interval and never overlaps requests", async () => {
  const pollCalls: RequestInit[] = [];
  const fetcher = installFetch(async (url, init) => {
    if (url === "/api/providers/codex-direct/account") return Response.json(baseAccount);
    if (url === "/api/providers/codex-direct/login/start") return Response.json({
      providerId: "provider-direct", loginId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      verificationUri: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGH",
      intervalSeconds: 5, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    }, { status: 201 });
    if (url === "/api/providers/codex-direct/login/poll") {
      pollCalls.push(init ?? {});
      return Response.json({ state: "pending", retryAfterSeconds: 7 });
    }
    throw new Error(`Unexpected request ${url}`);
  });
  render(<CodexDirectProviderCard />);
  const card = await screen.findByRole("article", { name: "Codex Subscription — tanpa CLI" });
  vi.useFakeTimers();
  await act(async () => { fireEvent.click(within(card).getByRole("button", { name: "Hubungkan ChatGPT" })); });
  expect(within(card).getByText("ABCD-EFGH")).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(4_999); });
  expect(pollCalls).toHaveLength(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(within(card).getByText("Menunggu konfirmasi login ChatGPT…")).toBeTruthy();
  expect(pollCalls).toHaveLength(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(6_999); });
  expect(pollCalls).toHaveLength(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(pollCalls).toHaveLength(2);
  expect(fetcher.mock.calls.filter(([url]) => url === "/api/providers/codex-direct/login/poll")).toHaveLength(2);
});

it("refreshes catalog after login without showing provider-level model controls", async () => {
  let account: AccountFixture = baseAccount;
  let providerRefreshEvents = 0;
  const onProviderRefresh = () => { providerRefreshEvents += 1; };
  window.addEventListener("provider-list-refresh", onProviderRefresh);
  const calls: Array<[string, string]> = [];
  installFetch(async (url, init) => {
    const method = init?.method ?? "GET";
    calls.push([url, method]);
    if (url === "/api/providers/codex-direct/account") return Response.json(account);
    if (url === "/api/providers/codex-direct/login/start") return Response.json({
      providerId: "provider-direct", loginId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      verificationUri: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGH",
      intervalSeconds: 1, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    }, { status: 201 });
    if (url === "/api/providers/codex-direct/login/poll") {
      account = connectedAccount;
      return Response.json({ state: "connected", account });
    }
    if (url === "/api/providers/codex-direct/models") {
      account = { ...connectedAccount, revision: 3 };
      return Response.json({ models: [
        { id: "catalog-one", label: "Catalog One" },
        { id: "catalog-two", label: "Catalog Two" },
      ], account });
    }
    throw new Error(`Unexpected request ${method} ${url}`);
  });
  render(<CodexDirectProviderCard />);
  const card = await screen.findByRole("article", { name: "Codex Subscription — tanpa CLI" });
  vi.useFakeTimers();
  await act(async () => { fireEvent.click(within(card).getByRole("button", { name: "Hubungkan ChatGPT" })); });
  expect(within(card).getByText("ABCD-EFGH")).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(within(card).getByText("Pilih model saat menambah atau mengedit agent.")).toBeTruthy();
  expect(within(card).getByText("2 model tersedia untuk agent.")).toBeTruthy();
  expect(within(card).queryByRole("combobox")).toBeNull();
  expect(within(card).queryByRole("button", { name: "Simpan model" })).toBeNull();
  expect(within(card).queryByText(/^Model saat ini:/)).toBeNull();
  expect(calls.filter(([url]) => url === "/api/providers/codex-direct/models")).toHaveLength(1);
  expect(calls.some(([url]) => url === "/api/providers/codex-direct/model")).toBe(false);
  expect(calls.filter(([url]) => url === "/api/providers/codex-direct/login/start")).toHaveLength(1);
  expect(JSON.stringify(calls)).not.toContain("auth.json");
  expect(providerRefreshEvents).toBe(1);
  window.removeEventListener("provider-list-refresh", onProviderRefresh);
});


it("shows refreshed catalog counts without provider-level model controls", async () => {
  let account: AccountFixture = { ...connectedAccount };
  const revisions: number[] = [];
  const fetcher = installFetch(async (url, init) => {
    if (url === "/api/providers/codex-direct/account") return Response.json(account);
    if (url === "/api/providers/codex-direct/models") {
      revisions.push((JSON.parse(String(init?.body)) as { expectedRevision: number }).expectedRevision);
      account = { ...account, revision: account.revision + 1 };
      return Response.json({ models: [
        { id: "catalog-one", label: "Catalog One" },
        { id: "catalog-two", label: "Catalog Two" },
      ], account });
    }
    throw new Error(`Unexpected request ${url}`);
  });
  const user = userEvent.setup();
  render(<CodexDirectProviderCard />);
  await screen.findByText("Akun terhubung; penggunaan agent belum diaktifkan.");
  expect(screen.queryByText("Tidak ada model yang tersedia.")).toBeNull();
  expect(screen.getByText("Pilih model saat menambah atau mengedit agent.")).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "Perbarui daftar model" }));
  await screen.findByText("2 model tersedia untuk agent.");
  await user.click(screen.getByRole("button", { name: "Perbarui daftar model" }));
  await screen.findByText("2 model tersedia untuk agent.");
  expect(revisions).toEqual([2, 3]);
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Simpan model" })).toBeNull();
  expect(screen.queryByText(/^Model saat ini:/)).toBeNull();
  expect(fetcher.mock.calls.some(([url]) => String(url) === "/api/providers/codex-direct/model")).toBe(false);
});

it("shows an empty catalog only after a successful refresh", async () => {
  installFetch(async (url) => {
    if (url === "/api/providers/codex-direct/account") return Response.json(connectedAccount);
    if (url === "/api/providers/codex-direct/models") return Response.json({ models: [], account: { ...connectedAccount, revision: 3 } });
    throw new Error(`Unexpected request ${url}`);
  });
  const user = userEvent.setup();
  render(<CodexDirectProviderCard />);
  await screen.findByText("Akun terhubung; penggunaan agent belum diaktifkan.");
  expect(screen.queryByText("Tidak ada model yang tersedia.")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Perbarui daftar model" }));
  expect(await screen.findByText("Tidak ada model yang tersedia.")).toBeTruthy();
});

it("keeps provider disconnect behind its confirmation dialog", async () => {
  installFetch(async (url) => {
    if (url === "/api/providers/codex-direct/account") return Response.json(connectedAccount);
    throw new Error(`Unexpected request ${url}`);
  });
  const user = userEvent.setup();
  render(<CodexDirectProviderCard />);
  await screen.findByText("Akun terhubung; penggunaan agent belum diaktifkan.");
  await user.click(screen.getByRole("button", { name: "Putuskan koneksi" }));
  expect(screen.getByRole("alertdialog", { name: "Konfirmasi putus koneksi Codex" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Batalkan" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("releases loading after a stalled catalog refresh and preserves the last count", async () => {
  let catalogReads = 0;
  let stalledSignal: AbortSignal | null | undefined;
  installFetch(async (url, init) => {
    if (url === "/api/providers/codex-direct/account") return Response.json(connectedAccount);
    if (url === "/api/providers/codex-direct/models") {
      catalogReads += 1;
      if (catalogReads === 1) return Response.json({ models: [{ id: "catalog-one", label: "Catalog One" }], account: { ...connectedAccount, revision: 3 } });
      stalledSignal = init?.signal;
      return new Promise<Response>(() => {});
    }
    throw new Error(`Unexpected request ${url}`);
  });
  const user = userEvent.setup();
  render(<CodexDirectProviderCard />);
  await screen.findByText("Akun terhubung; penggunaan agent belum diaktifkan.");
  await user.click(screen.getByRole("button", { name: "Perbarui daftar model" }));
  await screen.findByText("1 model tersedia untuk agent.");
  vi.useFakeTimers();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Perbarui daftar model" })); });
  expect((screen.getByRole("button", { name: "Perbarui daftar model" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(screen.getByRole("alert").textContent).toContain("Permintaan Codex melewati batas waktu");
  expect(stalledSignal?.aborted).toBe(true);
  expect(screen.getByText("1 model tersedia untuk agent.")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Perbarui daftar model" }) as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByRole("button", { name: "Muat ulang status" }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.queryByRole("combobox")).toBeNull();
});

it("keeps the last successful catalog count visible when refresh fails", async () => {
  let catalogReads = 0;
  installFetch(async (url) => {
    if (url === "/api/providers/codex-direct/account") return Response.json(connectedAccount);
    if (url === "/api/providers/codex-direct/models") {
      catalogReads += 1;
      if (catalogReads === 1) return Response.json({ models: [
        { id: "catalog-one", label: "Catalog One" },
        { id: "catalog-two", label: "Catalog Two" },
      ], account: { ...connectedAccount, revision: 3 } });
      return Response.json({ error: "Catalog refresh failed" }, { status: 503 });
    }
    throw new Error(`Unexpected request ${url}`);
  });
  const user = userEvent.setup();
  render(<CodexDirectProviderCard />);
  await screen.findByText("Akun terhubung; penggunaan agent belum diaktifkan.");
  await user.click(screen.getByRole("button", { name: "Perbarui daftar model" }));
  await screen.findByText("2 model tersedia untuk agent.");
  await user.click(screen.getByRole("button", { name: "Perbarui daftar model" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByText("2 model tersedia untuk agent.")).toBeTruthy();
  expect(screen.queryByText("0 model tersedia untuk agent.")).toBeNull();
});


it("aborts active polling and clears timer on unmount", async () => {
  let pollSignal: AbortSignal | undefined;
  const fetcher = installFetch(async (url, init) => {
    if (url === "/api/providers/codex-direct/account") return Response.json(baseAccount);
    if (url === "/api/providers/codex-direct/login/start") return Response.json({
      providerId: "provider-direct", loginId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      verificationUri: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGH", intervalSeconds: 1,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    }, { status: 201 });
    if (url === "/api/providers/codex-direct/login/poll") {
      pollSignal = init?.signal as AbortSignal;
      return await new Promise<Response>((_resolve, reject) => pollSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
    }
    throw new Error(`Unexpected request ${url}`);
  });
  const rendered = render(<CodexDirectProviderCard />);
  const card = await screen.findByRole("article", { name: "Codex Subscription — tanpa CLI" });
  vi.useFakeTimers();
  await act(async () => { fireEvent.click(within(card).getByRole("button", { name: "Hubungkan ChatGPT" })); });
  expect(within(card).getByText("ABCD-EFGH")).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(pollSignal).toBeDefined();
  rendered.unmount();
  expect(pollSignal?.aborted).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(fetcher.mock.calls.filter(([url]) => url === "/api/providers/codex-direct/login/poll")).toHaveLength(1);
});
