// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentOptions, AgentView } from "../../lib/domain/agent";
import AgentManager from "../../app/agents/agent-manager";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const options: AgentOptions = {
  providers: [{ id: "provider-1", name: "Codex Subscription", kind: "codex", status: "unavailable", models: [{ id: "codex-model", label: "codex-model" }] }],
  projects: [{ id: "project-1", name: "Nail" }],
  skills: [{ id: "planning", name: "Perencanaan", description: "Tujuan dan langkah." }],
};
const savedAgent: AgentView = {
  id: "agent-1", name: "Saved Planner", role: "pm", projectId: "project-1",
  providerId: "provider-1", model: "codex-model", skillIds: ["planning"], instructions: "Keep it small.",
  revision: 1, createdAt: "2026-10-22T00:00:00.000Z", updatedAt: "2026-10-22T00:00:00.000Z",
};

function installFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

it("shows loading then a truthful empty state from the saved agents endpoint", async () => {
  let resolveAgents!: (response: Response) => void;
  const agentResponse = new Promise<Response>((resolve) => { resolveAgents = resolve; });
  installFetch(async (url) => {
    if (url === "/api/agents") return await agentResponse;
    if (url === "/api/agents/options") return Response.json(options);
    throw new Error(`Unexpected request ${url}`);
  });
  render(<AgentManager />);
  expect(screen.getByText("Memuat agent tersimpan…")).toBeTruthy();
  resolveAgents(Response.json([]));
  expect(await screen.findByText("Belum ada agent tersimpan.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Tambah agent" })).toBeTruthy();
});

it("shows options failure separately without fabricating providers", async () => {
  installFetch(async (url) => {
    if (url === "/api/agents") return Response.json([]);
    if (url === "/api/agents/options") return Response.json({ error: "options unavailable" }, { status: 503 });
    throw new Error(`Unexpected request ${url}`);
  });
  render(<AgentManager />);
  expect(await screen.findByText("Belum ada agent tersimpan.")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("options unavailable");
  expect((screen.getByRole("button", { name: "Tambah agent" }) as HTMLButtonElement).disabled).toBe(true);
});

it("cancels the editor without changing an existing saved row", async () => {
  const fetcher = installFetch(async (url) => {
    if (url === "/api/agents") return Response.json([savedAgent]);
    if (url === "/api/agents/options") return Response.json(options);
    throw new Error(`Unexpected request ${url}`);
  });
  const user = userEvent.setup();
  render(<AgentManager />);
  expect(await screen.findByText("Saved Planner")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Tambah agent" }));
  await user.type(screen.getByLabelText("Nama"), "Draft only");
  await user.click(screen.getByRole("button", { name: "Batal" }));
  expect(screen.getByText("Saved Planner")).toBeTruthy();
  expect(screen.queryByLabelText("Nama")).toBeNull();
  expect(fetcher.mock.calls.some(([url, init]) => String(url) === "/api/agents" && init?.method === "POST")).toBe(false);
});

it("creates only after reading the exact saved row back", async () => {
  const created = { ...savedAgent, id: "agent-created", name: "Nail PM" };
  const calls: Array<{ url: string; method: string }> = [];
  let listReads = 0;
  installFetch(async (url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (url === "/api/agents/options") return Response.json(options);
    if (url === "/api/agents" && method === "POST") return Response.json({ agent: created }, { status: 201 });
    if (url === "/api/agents" && method === "GET") {
      listReads += 1;
      return Response.json(listReads === 1 ? [] : [created]);
    }
    if (url === "/api/agents/agent-created" && method === "GET") return Response.json({ agent: created });
    throw new Error(`Unexpected request ${method} ${url}`);
  });
  const user = userEvent.setup();
  render(<AgentManager />);
  await screen.findByText("Belum ada agent tersimpan.");
  await user.click(screen.getByRole("button", { name: "Tambah agent" }));
  await user.clear(screen.getByLabelText("Nama"));
  await user.type(screen.getByLabelText("Nama"), "Nail PM");
  await user.selectOptions(screen.getByLabelText("Provider"), "provider-1");
  await user.click(screen.getByRole("button", { name: "Simpan agent" }));
  expect(await screen.findByText("Nail PM")).toBeTruthy();
  expect(screen.getByText("Agent tersimpan.")).toBeTruthy();
  expect(calls.slice(-3)).toEqual([
    { url: "/api/agents", method: "POST" },
    { url: "/api/agents/agent-created", method: "GET" },
    { url: "/api/agents", method: "GET" },
  ]);
});

it("keeps the typed draft and does not add a phantom row after a failed save", async () => {
  installFetch(async (url, init) => {
    if (url === "/api/agents/options") return Response.json(options);
    if (url === "/api/agents" && (init?.method ?? "GET") === "GET") return Response.json([]);
    if (url === "/api/agents" && init?.method === "POST") throw new Error("network offline");
    throw new Error(`Unexpected request ${init?.method ?? "GET"} ${url}`);
  });
  const user = userEvent.setup();
  render(<AgentManager />);
  await screen.findByText("Belum ada agent tersimpan.");
  await user.click(screen.getByRole("button", { name: "Tambah agent" }));
  const name = screen.getByLabelText("Nama") as HTMLInputElement;
  await user.type(name, "Unsaved draft");
  await user.click(screen.getByRole("button", { name: "Simpan agent" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect((screen.getByLabelText("Nama") as HTMLInputElement).value).toBe("Unsaved draft");
  expect(screen.queryByText("Unsaved draft")).toBeNull();
});

it("loads the saved revision and reads the exact updated agent back", async () => {
  const edited = { ...savedAgent, name: "Renamed Planner", revision: 2, updatedAt: "2026-10-22T01:00:00.000Z" };
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  let listReads = 0;
  let detailReads = 0;
  installFetch(async (url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });
    if (url === "/api/agents/options") return Response.json(options);
    if (url === "/api/agents" && method === "GET") {
      listReads += 1;
      return Response.json(listReads === 1 ? [savedAgent] : [edited]);
    }
    if (url === "/api/agents/agent-1" && method === "GET") {
      detailReads += 1;
      return Response.json({ agent: detailReads === 1 ? savedAgent : edited });
    }
    if (url === "/api/agents/agent-1" && method === "PUT") return Response.json({ agent: edited });
    throw new Error(`Unexpected request ${method} ${url}`);
  });
  const user = userEvent.setup();
  render(<AgentManager />);
  await screen.findByText("Saved Planner");
  await user.click(screen.getByRole("button", { name: "Ubah Saved Planner" }));
  expect((screen.getByLabelText("Nama") as HTMLInputElement).value).toBe("Saved Planner");
  await user.clear(screen.getByLabelText("Nama"));
  await user.type(screen.getByLabelText("Nama"), "Renamed Planner");
  await user.click(screen.getByRole("button", { name: "Simpan perubahan" }));
  expect(await screen.findByText("Renamed Planner")).toBeTruthy();
  expect(screen.getByText("Perubahan agent tersimpan.")).toBeTruthy();
  const put = calls.find((call) => call.method === "PUT");
  expect(put?.body).toBe(JSON.stringify({ revision: 1, agent: {
    name: "Renamed Planner", role: "pm", projectId: "project-1", providerId: "provider-1",
    model: "codex-model", skillIds: ["planning"], instructions: "Keep it small.",
  } }));
  expect(calls.slice(-3).map(({ url, method }) => [url, method])).toEqual([
    ["/api/agents/agent-1", "PUT"],
    ["/api/agents/agent-1", "GET"],
    ["/api/agents", "GET"],
  ]);
});

it("keeps conflicting edits and only replaces them after an explicit reload", async () => {
  const latest = { ...savedAgent, name: "Concurrent version", revision: 2 };
  let detailReads = 0;
  installFetch(async (url, init) => {
    const method = init?.method ?? "GET";
    if (url === "/api/agents/options") return Response.json(options);
    if (url === "/api/agents" && method === "GET") return Response.json([savedAgent]);
    if (url === "/api/agents/agent-1" && method === "GET") {
      detailReads += 1;
      return Response.json({ agent: detailReads === 1 ? savedAgent : latest });
    }
    if (url === "/api/agents/agent-1" && method === "PUT") {
      return Response.json({ error: "Agent changed since it was loaded", code: "revision_conflict" }, { status: 409 });
    }
    throw new Error(`Unexpected request ${method} ${url}`);
  });
  const user = userEvent.setup();
  render(<AgentManager />);
  await screen.findByText("Saved Planner");
  await user.click(screen.getByRole("button", { name: "Ubah Saved Planner" }));
  await user.clear(screen.getByLabelText("Nama"));
  await user.type(screen.getByLabelText("Nama"), "My unsaved draft");
  await user.click(screen.getByRole("button", { name: "Simpan perubahan" }));
  expect((screen.getByLabelText("Nama") as HTMLInputElement).value).toBe("My unsaved draft");
  expect(screen.getByRole("alert").textContent).toContain("Agent changed since it was loaded");
  await user.click(screen.getByRole("button", { name: "Muat versi terbaru" }));
  expect((screen.getByLabelText("Nama") as HTMLInputElement).value).toBe("Concurrent version");
  expect(detailReads).toBe(2);
});

it("requires exact-name delete confirmation and verifies absence before removing the card", async () => {
  const calls: Array<[string, string]> = [];
  let listReads = 0;
  installFetch(async (url, init) => {
    const method = init?.method ?? "GET";
    calls.push([url, method]);
    if (url === "/api/agents/options") return Response.json(options);
    if (url === "/api/agents" && method === "GET") {
      listReads += 1;
      return Response.json(listReads === 1 ? [savedAgent] : []);
    }
    if (url === "/api/agents/agent-1" && method === "DELETE") return Response.json({ deleted: true, id: "agent-1" });
    if (url === "/api/agents/agent-1" && method === "GET") return Response.json({ error: "Agent was not found", code: "not_found" }, { status: 404 });
    throw new Error(`Unexpected request ${method} ${url}`);
  });
  const user = userEvent.setup();
  render(<AgentManager />);
  await screen.findByText("Saved Planner");
  await user.click(screen.getByRole("button", { name: "Hapus Saved Planner" }));
  expect(screen.getByRole("alertdialog").textContent).toContain("Saved Planner");
  expect(calls.some(([, method]) => method === "DELETE")).toBe(false);
  await user.click(screen.getByRole("button", { name: "Batalkan penghapusan" }));
  expect(screen.getByText("Saved Planner")).toBeTruthy();
  expect(calls.some(([, method]) => method === "DELETE")).toBe(false);

  await user.click(screen.getByRole("button", { name: "Hapus Saved Planner" }));
  await user.click(screen.getByRole("button", { name: "Hapus agent" }));
  expect(await screen.findByText("Belum ada agent tersimpan.")).toBeTruthy();
  expect(calls.slice(-3)).toEqual([
    ["/api/agents/agent-1", "DELETE"],
    ["/api/agents/agent-1", "GET"],
    ["/api/agents", "GET"],
  ]);
});

it("restores focus to the opener after cancelling create, edit and delete", async () => {
  installFetch(async (url, init) => {
    const method = init?.method ?? "GET";
    if (url === "/api/agents/options") return Response.json(options);
    if (url === "/api/agents" && method === "GET") return Response.json([savedAgent]);
    if (url === "/api/agents/agent-1" && method === "GET") return Response.json({ agent: savedAgent });
    throw new Error(`Unexpected request ${method} ${url}`);
  });
  const user = userEvent.setup();
  render(<AgentManager />);
  await screen.findByText("Saved Planner");

  const add = screen.getByRole("button", { name: "Tambah agent" });
  await user.click(add);
  await user.click(screen.getByRole("button", { name: "Batal" }));
  expect(document.activeElement).toBe(add);

  const edit = screen.getByRole("button", { name: "Ubah Saved Planner" });
  await user.click(edit);
  await screen.findByRole("button", { name: "Simpan perubahan" });
  await user.click(screen.getByRole("button", { name: "Batal" }));
  expect(document.activeElement).toBe(edit);

  const remove = screen.getByRole("button", { name: "Hapus Saved Planner" });
  await user.click(remove);
  await user.click(screen.getByRole("button", { name: "Batalkan penghapusan" }));
  expect(document.activeElement).toBe(remove);
});

it("retries exact readback after a successful POST without sending a duplicate create", async () => {
  const created = { ...savedAgent, id: "agent-readback", name: "Readback PM" };
  let detailReads = 0;
  let createCalls = 0;
  let listReads = 0;
  installFetch(async (url, init) => {
    const method = init?.method ?? "GET";
    if (url === "/api/agents/options") return Response.json(options);
    if (url === "/api/agents" && method === "GET") {
      listReads += 1;
      return Response.json(listReads === 1 ? [] : [created]);
    }
    if (url === "/api/agents" && method === "POST") {
      createCalls += 1;
      return Response.json({ agent: created }, { status: 201 });
    }
    if (url === "/api/agents/agent-readback" && method === "GET") {
      detailReads += 1;
      return detailReads === 1
        ? Response.json({ error: "temporary readback failure" }, { status: 503 })
        : Response.json({ agent: created });
    }
    throw new Error(`Unexpected request ${method} ${url}`);
  });
  const user = userEvent.setup();
  render(<AgentManager />);
  await screen.findByText("Belum ada agent tersimpan.");
  await user.click(screen.getByRole("button", { name: "Tambah agent" }));
  await user.type(screen.getByLabelText("Nama"), "Readback PM");
  await user.click(screen.getByRole("button", { name: "Simpan agent" }));
  await screen.findByRole("button", { name: "Verifikasi agent tersimpan" });
  expect((screen.getByLabelText("Nama") as HTMLInputElement).value).toBe("Readback PM");
  await user.click(screen.getByRole("button", { name: "Verifikasi agent tersimpan" }));
  expect(await screen.findByText("Readback PM")).toBeTruthy();
  expect(createCalls).toBe(1);
});

it("keeps an agent row when deletion is blocked by its task history", async () => {
  installFetch(async (url, init) => {
    const method = init?.method ?? "GET";
    if (url === "/api/agents/options") return Response.json(options);
    if (url === "/api/agents" && method === "GET") return Response.json([savedAgent]);
    if (url === "/api/agents/agent-1" && method === "DELETE") {
      return Response.json({ error: "Agent is referenced by saved task history", code: "agent_referenced" }, { status: 409 });
    }
    throw new Error(`Unexpected request ${method} ${url}`);
  });
  const user = userEvent.setup();
  render(<AgentManager />);
  await screen.findByText("Saved Planner");
  await user.click(screen.getByRole("button", { name: "Hapus Saved Planner" }));
  await user.click(screen.getByRole("button", { name: "Hapus agent" }));
  expect(screen.getByRole("heading", { name: "Saved Planner" })).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("Agent is referenced by saved task history");
});
