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

it("reads account and model back after login, selects only listed models, and keeps inference disabled", async () => {
  let account: AccountFixture = baseAccount;
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
      return Response.json({ models: [{ id: "listed-model", label: "Listed model" }], checkedAt: "2026-10-22T00:00:00.000Z", account });
    }
    if (url === "/api/providers/codex-direct/model") {
      const body = JSON.parse(String(init?.body)) as { model: string };
      expect(body.model).toBe("listed-model");
      account = { ...connectedAccount, revision: 4, model: body.model };
      return Response.json(account);
    }
    throw new Error(`Unexpected request ${method} ${url}`);
  });
  render(<CodexDirectProviderCard />);
  const card = await screen.findByRole("article", { name: "Codex Subscription — tanpa CLI" });
  vi.useFakeTimers();
  await act(async () => { fireEvent.click(within(card).getByRole("button", { name: "Hubungkan ChatGPT" })); });
  expect(within(card).getByText("ABCD-EFGH")).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(within(card).getByRole("combobox", { name: "Model Codex" })).toBeTruthy();
  await act(async () => {
    fireEvent.change(within(card).getByRole("combobox", { name: "Model Codex" }), { target: { value: "listed-model" } });
    fireEvent.click(within(card).getByRole("button", { name: "Simpan model" }));
  });
  expect(within(card).getByText("Akun terhubung; penggunaan agent belum diaktifkan.")).toBeTruthy();
  expect(within(card).getByText("Model tersimpan: listed-model")).toBeTruthy();
  expect(calls).toContainEqual(["/api/providers/codex-direct/models", "POST"]);
  expect(calls).toContainEqual(["/api/providers/codex-direct/model", "POST"]);
  expect(calls.filter(([url]) => url === "/api/providers/codex-direct/login/start")).toHaveLength(1);
  expect(JSON.stringify(calls)).not.toContain("auth.json");
});

it("saves a listed model with ordinary browser selection and reads the same model back", async () => {
  let account: AccountFixture = { ...connectedAccount };
  const calls: Array<{ url: string; body: unknown }> = [];
  installFetch(async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url === "/api/providers/codex-direct/account") return Response.json(account);
    if (url === "/api/providers/codex-direct/models") {
      account = { ...account, revision: 3 };
      return Response.json({ models: [{ id: "gpt-6.1-sol", label: "GPT-6.1-Sol" }], checkedAt: new Date().toISOString(), account });
    }
    if (url === "/api/providers/codex-direct/model") {
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ model: "gpt-6.1-sol", expectedRevision: 3 });
      account = { ...account, model: body.model, revision: 4 };
      return Response.json(account);
    }
    throw new Error("Unexpected request");
  });
  const user = userEvent.setup();
  render(<CodexDirectProviderCard />);
  await screen.findByText("Akun terhubung; penggunaan agent belum diaktifkan.");
  await user.click(screen.getByRole("button", { name: "Perbarui daftar model" }));
  await screen.findByRole("option", { name: "GPT-6.1-Sol" });
  await user.selectOptions(screen.getByRole("combobox", { name: "Model Codex" }), "gpt-6.1-sol");
  expect((screen.getByRole("button", { name: "Simpan model" }) as HTMLButtonElement).disabled).toBe(false);
  await user.click(screen.getByRole("button", { name: "Simpan model" }));
  await screen.findByText("Model tersimpan: gpt-6.1-sol");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(calls.slice(-2).map((item) => item.url)).toEqual(["/api/providers/codex-direct/model", "/api/providers/codex-direct/account"]);
});

it("releases stuck loading after a stalled model refresh and preserves the chosen model", async () => {
  let catalogReads = 0;
  let stalledSignal: AbortSignal | null | undefined;
  installFetch(async (url, init) => {
    if (url === "/api/providers/codex-direct/account") return Response.json(connectedAccount);
    if (url === "/api/providers/codex-direct/models") {
      catalogReads += 1;
      if (catalogReads === 1) return Response.json({ models: [{ id: "gpt-6.1-sol", label: "GPT-6.1-Sol" }], account: { ...connectedAccount, revision: 3 } });
      stalledSignal = init?.signal;
      return new Promise<Response>(() => {});
    }
    throw new Error("Unexpected request");
  });
  const user = userEvent.setup();
  render(<CodexDirectProviderCard />);
  await screen.findByText("Akun terhubung; penggunaan agent belum diaktifkan.");
  await user.click(screen.getByRole("button", { name: "Perbarui daftar model" }));
  await screen.findByRole("option", { name: "GPT-6.1-Sol" });
  await user.selectOptions(screen.getByRole("combobox", { name: "Model Codex" }), "gpt-6.1-sol");
  vi.useFakeTimers();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Perbarui daftar model" })); });
  expect((screen.getByRole("button", { name: "Simpan model" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(screen.getByRole("alert").textContent).toContain("Permintaan Codex melewati batas waktu");
  expect(stalledSignal?.aborted).toBe(true);
  expect((screen.getByRole("combobox", { name: "Model Codex" }) as HTMLSelectElement).value).toBe("gpt-6.1-sol");
  expect((screen.getByRole("button", { name: "Simpan model" }) as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByRole("button", { name: "Perbarui daftar model" }) as HTMLButtonElement).disabled).toBe(false);
});

it("releases loading if a save response body stalls and does not show a false save success", async () => {
  installFetch(async (url) => {
    if (url === "/api/providers/codex-direct/account") return Response.json(connectedAccount);
    if (url === "/api/providers/codex-direct/models") return Response.json({ models: [{ id: "gpt-6.1-sol", label: "GPT-6.1-Sol" }], account: { ...connectedAccount, revision: 3 } });
    if (url === "/api/providers/codex-direct/model") return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
    throw new Error("Unexpected request");
  });
  const user = userEvent.setup();
  render(<CodexDirectProviderCard />);
  await screen.findByText("Akun terhubung; penggunaan agent belum diaktifkan.");
  await user.click(screen.getByRole("button", { name: "Perbarui daftar model" }));
  await screen.findByRole("option", { name: "GPT-6.1-Sol" });
  await user.selectOptions(screen.getByRole("combobox", { name: "Model Codex" }), "gpt-6.1-sol");
  vi.useFakeTimers();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Simpan model" })); });
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(screen.getByRole("alert").textContent).toContain("Permintaan Codex melewati batas waktu");
  expect(screen.queryByText("Model tersimpan: gpt-6.1-sol")).toBeNull();
  expect((screen.getByRole("button", { name: "Simpan model" }) as HTMLButtonElement).disabled).toBe(false);
});

it("checks a timed-out save through explicit status readback without resubmitting it", async () => {
  let stored: AccountFixture = { ...connectedAccount };
  let saves = 0;
  installFetch(async (url, init) => {
    if (url === "/api/providers/codex-direct/account") return Response.json(stored);
    if (url === "/api/providers/codex-direct/models") {
      stored = { ...stored, revision: 3 };
      return Response.json({ models: [{ id: "gpt-6.1-sol", label: "GPT-6.1-Sol" }], account: stored });
    }
    if (url === "/api/providers/codex-direct/model") {
      saves += 1;
      expect(JSON.parse(String(init?.body)).model).toBe("gpt-6.1-sol");
      stored = { ...stored, model: "gpt-6.1-sol", revision: 4 };
      return new Promise<Response>(() => {});
    }
    throw new Error("Unexpected request");
  });
  const user = userEvent.setup();
  render(<CodexDirectProviderCard />);
  await screen.findByText("Akun terhubung; penggunaan agent belum diaktifkan.");
  await user.click(screen.getByRole("button", { name: "Perbarui daftar model" }));
  await screen.findByRole("option", { name: "GPT-6.1-Sol" });
  await user.selectOptions(screen.getByRole("combobox", { name: "Model Codex" }), "gpt-6.1-sol");
  vi.useFakeTimers();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Simpan model" })); });
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(screen.getByRole("alert")).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Muat ulang status" })); });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("Model saat ini: gpt-6.1-sol")).toBeTruthy();
  expect(saves).toBe(1);
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
