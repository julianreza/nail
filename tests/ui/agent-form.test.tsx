// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { AgentOptions, AgentView } from "../../lib/domain/agent";
import AgentForm from "../../app/agents/agent-form";

afterEach(cleanup);

const options: AgentOptions = {
  providers: [
    { id: "p1", name: "Provider One", kind: "codex", status: "unavailable", models: [{ id: "model-one", label: "model-one" }] },
    { id: "p2", name: "Provider Two", kind: "deepseek", status: "ready", models: [{ id: "model-two", label: "model-two" }] },
  ],
  projects: [{ id: "project-1", name: "Nail" }],
  skills: [
    { id: "planning", name: "Perencanaan", description: "Tujuan dan langkah." },
    { id: "review", name: "Review", description: "Risiko dan bukti." },
  ],
};

function renderForm(props: Partial<ComponentProps<typeof AgentForm>> = {}) {
  const onSubmit = props.onSubmit ?? vi.fn();
  const onCancel = props.onCancel ?? vi.fn();
  render(<AgentForm options={options} pending={false} error={null} onSubmit={onSubmit} onCancel={onCancel} {...props} />);
  return { onSubmit, onCancel };
}

it("saves an unbound configured agent without invented provider data", async () => {
  const submit = vi.fn();
  const user = userEvent.setup();
  render(<AgentForm options={{ providers: [], projects: [], skills: [] }} pending={false} error={null} onSubmit={submit} onCancel={() => undefined} />);
  await user.type(screen.getByLabelText("Nama"), "Nail PM");
  await user.selectOptions(screen.getByLabelText("Peran"), "pm");
  await user.click(screen.getByRole("button", { name: "Simpan agent" }));
  expect(submit).toHaveBeenCalledWith({
    name: "Nail PM", role: "pm", projectId: null,
    providerId: null, model: null, skillIds: [], instructions: "",
  });
  expect((screen.getByLabelText("Model") as HTMLSelectElement).disabled).toBe(true);
  expect(screen.getByText(/Skill adalah panduan instruksi, bukan izin tool/).textContent).toContain("Skill adalah panduan instruksi, bukan izin tool");
});

it("switching provider selects only that provider's configured model and saves skills", async () => {
  const submit = vi.fn();
  const user = userEvent.setup();
  renderForm({ onSubmit: submit });
  await user.type(screen.getByLabelText("Nama"), "QA Agent");
  await user.selectOptions(screen.getByLabelText("Peran"), "qa");
  await user.selectOptions(screen.getByLabelText("Provider"), "p1");
  expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe("model-one");
  await user.selectOptions(screen.getByLabelText("Provider"), "p2");
  expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe("model-two");
  await user.selectOptions(screen.getByLabelText("Lingkup project"), "project-1");
  await user.click(screen.getByLabelText(/Perencanaan/));
  await user.type(screen.getByLabelText("Instruksi tambahan"), "Review tests only.");
  await user.click(screen.getByRole("button", { name: "Simpan agent" }));
  expect(submit).toHaveBeenCalledWith({
    name: "QA Agent", role: "qa", projectId: "project-1",
    providerId: "p2", model: "model-two", skillIds: ["planning"],
    instructions: "Review tests only.",
  });
});

it("retains a legacy mismatched model until the owner chooses a current one", async () => {
  const initial: AgentView = {
    id: "agent-1", name: "Legacy", role: "engineer", projectId: null,
    providerId: "p1", model: "removed-model", skillIds: [], instructions: "legacy",
    revision: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const user = userEvent.setup();
  renderForm({ initial });
  expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe("removed-model");
  expect(screen.getByText(/model tidak lagi tersedia/i).textContent).toContain("Model tidak lagi tersedia");
  expect((screen.getByRole("button", { name: "Simpan perubahan" }) as HTMLButtonElement).disabled).toBe(true);
  await user.selectOptions(screen.getByLabelText("Model"), "model-one");
  expect(screen.queryByText(/model tidak lagi tersedia/i)).toBeNull();
});

it("disables controls and shows errors while a save is pending", () => {
  renderForm({ pending: true, error: "Model tidak tersedia" });
  expect((screen.getByLabelText("Nama") as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByRole("alert").textContent).toContain("Model tidak tersedia");
  expect((screen.getByRole("button", { name: "Menyimpan…" }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(screen.getByRole("group", { name: "Skill" })).getByLabelText(/Perencanaan/) as HTMLInputElement).disabled).toBe(true);
});

it("calls cancel from the editor", async () => {
  const user = userEvent.setup();
  const { onCancel } = renderForm();
  await user.click(screen.getByRole("button", { name: "Batal" }));
  expect(onCancel).toHaveBeenCalledTimes(1);
});
