"use client";

import { useState, type FormEvent } from "react";
import { parseAgentInput, type AgentInput, type AgentOptions, type AgentView } from "../../lib/domain/agent";

const ROLE_OPTIONS = [
  { id: "pm", label: "PM" },
  { id: "engineer", label: "Engineer" },
  { id: "qa", label: "QA" },
  { id: "frontend", label: "Frontend" },
  { id: "backend", label: "Backend" },
] as const;

const EMPTY_AGENT: AgentInput = {
  name: "",
  role: "pm",
  projectId: null,
  providerId: null,
  model: null,
  skillIds: [],
  instructions: "",
};

export interface AgentFormProps {
  options: AgentOptions;
  initial?: AgentView;
  pending: boolean;
  error: string | null;
  onSubmit(input: AgentInput): void;
  onCancel(): void;
}

export default function AgentForm({ options, initial, pending, error, onSubmit, onCancel }: AgentFormProps) {
  const [value, setValue] = useState<AgentInput>(() => initial ? {
    name: initial.name,
    role: initial.role,
    projectId: initial.projectId,
    providerId: initial.providerId,
    model: initial.model,
    skillIds: [...initial.skillIds],
    instructions: initial.instructions,
  } : { ...EMPTY_AGENT });
  const [roleChoice, setRoleChoice] = useState<string>(() => {
    if (!initial) return "pm";
    return ROLE_OPTIONS.some((role) => role.id === initial.role) ? initial.role : "custom";
  });
  const [customRole, setCustomRole] = useState(() =>
    initial && !ROLE_OPTIONS.some((role) => role.id === initial.role) ? initial.role : "",
  );
  const [validationError, setValidationError] = useState<string | null>(null);
  const provider = options.providers.find((item) => item.id === value.providerId);
  const models = provider?.models ?? [];
  const modelIsStale = value.providerId !== null && Boolean(value.model) && !models.some((model) => model.id === value.model);

  function changeProvider(providerId: string) {
    const selected = options.providers.find((item) => item.id === providerId);
    setValue((current) => ({
      ...current,
      providerId: selected?.id ?? null,
      model: selected?.models.length === 1 ? selected.models[0].id : null,
    }));
  }

  function toggleSkill(skillId: string, checked: boolean) {
    setValue((current) => ({
      ...current,
      skillIds: checked
        ? [...current.skillIds, skillId]
        : current.skillIds.filter((id) => id !== skillId),
    }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setValidationError(null);
    try {
      const input = parseAgentInput({
        ...value,
        role: roleChoice === "custom" ? customRole : roleChoice,
      });
      if (modelIsStale) {
        setValidationError("Pilih model yang masih dikonfigurasi untuk provider ini.");
        return;
      }
      onSubmit(input);
    } catch {
      setValidationError("Periksa nama, peran, provider, model, skill, dan instruksi agent.");
    }
  }

  return (
    <form className="agent-form" onSubmit={submit} noValidate>
      <div className="agent-form-grid">
        <div className="agent-form-field">
          <label htmlFor="agent-name">Nama</label>
          <input
            autoComplete="off"
            disabled={pending}
            id="agent-name"
            maxLength={80}
            onChange={(event) => setValue((current) => ({ ...current, name: event.target.value }))}
            required
            value={value.name}
          />
        </div>

        <div className="agent-form-field">
          <label htmlFor="agent-role">Peran</label>
          <select
            disabled={pending}
            id="agent-role"
            onChange={(event) => {
              const next = event.target.value;
              setRoleChoice(next);
              if (next !== "custom") setValue((current) => ({ ...current, role: next }));
              else setValue((current) => ({ ...current, role: customRole }));
            }}
            value={roleChoice}
          >
            {ROLE_OPTIONS.map((role) => <option key={role.id} value={role.id}>{role.label}</option>)}
            <option value="custom">Peran khusus</option>
          </select>
        </div>

        {roleChoice === "custom" ? (
          <div className="agent-form-field">
            <label htmlFor="agent-custom-role">Slug peran khusus</label>
            <input
              autoComplete="off"
              disabled={pending}
              id="agent-custom-role"
              maxLength={32}
              onChange={(event) => {
                setCustomRole(event.target.value);
                setValue((current) => ({ ...current, role: event.target.value }));
              }}
              pattern="[a-z][a-z0-9_-]{0,31}"
              required
              value={customRole}
            />
          </div>
        ) : null}

        <div className="agent-form-field">
          <label htmlFor="agent-project">Lingkup project</label>
          <select
            disabled={pending}
            id="agent-project"
            onChange={(event) => setValue((current) => ({ ...current, projectId: event.target.value || null }))}
            value={value.projectId ?? ""}
          >
            <option value="">Semua project / belum ditetapkan</option>
            {options.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </div>

        <div className="agent-form-field">
          <label htmlFor="agent-provider">Provider</label>
          <select disabled={pending} id="agent-provider" onChange={(event) => changeProvider(event.target.value)} value={value.providerId ?? ""}>
            <option value="">Belum ditautkan</option>
            {options.providers.map((item) => (
              <option key={item.id} value={item.id}>{item.name} · {item.status}</option>
            ))}
          </select>
          {provider && provider.status !== "ready" ? (
            <p className="agent-form-hint" role="status">Konfigurasi tersimpan; provider belum siap menjalankan agent.</p>
          ) : null}
        </div>

        <div className="agent-form-field">
          <label htmlFor="agent-model">Model</label>
          <select
            disabled={pending || !value.providerId || models.length === 0}
            id="agent-model"
            onChange={(event) => setValue((current) => ({ ...current, model: event.target.value || null }))}
            value={value.model ?? ""}
          >
            {!value.model ? <option value="">Pilih model</option> : null}
            {modelIsStale ? <option disabled value={value.model!}>{value.model} (tidak lagi dikonfigurasi)</option> : null}
            {models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
          </select>
          {!value.providerId ? <p className="agent-form-hint">Pilih provider untuk melihat model.</p> : null}
          {value.providerId && models.length === 0 ? <p className="agent-form-hint">Provider belum memiliki model terkonfigurasi.</p> : null}
          {modelIsStale ? <p className="agent-form-error" role="alert">Model tidak lagi tersedia pada provider ini.</p> : null}
        </div>

        <fieldset className="agent-form-field agent-form-skills">
          <legend>Skill</legend>
          {options.skills.length === 0 ? <p className="agent-form-hint">Belum ada skill tersedia.</p> : null}
          {options.skills.map((skill) => (
            <label className="agent-skill-option" key={skill.id}>
              <input
                checked={value.skillIds.includes(skill.id)}
                disabled={pending}
                onChange={(event) => toggleSkill(skill.id, event.target.checked)}
                type="checkbox"
                value={skill.id}
              />
              <span><strong>{skill.name}</strong><small>{skill.description}</small></span>
            </label>
          ))}
          <p className="agent-form-hint">Skill adalah panduan instruksi, bukan izin tool.</p>
        </fieldset>

        <div className="agent-form-field agent-form-instructions">
          <label htmlFor="agent-instructions">Instruksi tambahan</label>
          <textarea
            disabled={pending}
            id="agent-instructions"
            maxLength={8000}
            onChange={(event) => setValue((current) => ({ ...current, instructions: event.target.value }))}
            rows={5}
            value={value.instructions}
          />
        </div>
      </div>

      {validationError ? <p className="agent-form-error" role="alert">{validationError}</p> : null}
      {error ? <p className="agent-form-error" role="alert">{error}</p> : null}
      <div className="agent-form-actions">
        <button className="button-secondary" disabled={pending} onClick={onCancel} type="button">Batal</button>
        <button className="button-primary" disabled={pending || modelIsStale} type="submit">
          {pending ? "Menyimpan…" : initial ? "Simpan perubahan" : "Simpan agent"}
        </button>
      </div>
    </form>
  );
}
