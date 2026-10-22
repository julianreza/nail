# Agent configuration

The owner can manage saved agents at **Agents** (`/agents`). The page supports creating, reading, editing and deleting agent configuration. Saved agents are configuration records, not proof that an agent is running.

## Create or edit an agent

Each agent has:

- **Name** — required, 1–80 Unicode characters.
- **Role** — lowercase slug, such as `pm`, `engineer`, `qa`, `frontend` or `backend`; a custom slug is allowed.
- **Project scope** — a saved project or no specific project.
- **Provider** — any saved provider, including one that is currently unavailable, or **Belum ditautkan**.
- **Model** — a model selected for this agent from the selected provider's available models. Each agent stores its own model. Direct Codex uses the connected account's selectable model catalog, so different agents can choose different listed models; DeepSeek and CLI providers continue to expose their configured model.
- **Skills** — up to ten curated instruction presets (planning, implementation, testing, review).
- **Additional instructions** — owner-authored text, up to 8,000 Unicode characters.

The skill presets are guidance text only. **Selecting a skill does not grant tools, install a plugin, or enable command execution.** Provider status is shown truthfully: an unavailable provider may be saved as configuration, but the agent cannot call it. For Codex-specific setup/status, see [Codex CLI OAuth](providers/codex-cli-oauth.md).

Changing a provider clears the previous model selection. A provider with one available model selects it automatically; when multiple models are available, the owner chooses one explicitly. A model that disappears from the provider's current options is reported as stale and blocks saving until the owner chooses a current model; Nail does not silently rewrite saved agent configuration.

## Edit conflicts and deletion

Updates carry a server-managed revision. If another request changed the agent since it was loaded, the server responds with a conflict; the page preserves the draft and asks the owner to explicitly reload the latest version before editing again.

Deletion requires an inline confirmation naming the selected agent. It is rejected while a nonterminal run is in the agent's affected project scope; editing is similarly blocked while a nonterminal run is in either the old or new scope. A global agent is considered to affect all projects, so an active run anywhere blocks editing it.

Agents referenced by task history cannot be hard-deleted. This preserves historical task ownership instead of silently nulling references. Archive/soft-delete is not implemented. An unused agent can be deleted after its exact absence is verified by the page.

## Dashboard

The Agent Studio roster and saved-agent count come from one authenticated, no-store overview response. Each saved agent produces a matching decorative actor and a configuration summary. An empty database shows no sample PM/Engineer/QA team. The dashboard reflects changes after local agent CRUD, a refresh, or focus returning to the tab; it does not poll and does not claim live execution status.

## API and persistence

Agent routes are owner-authenticated. Mutations require an exact same-origin `APP_ORIGIN` and JSON, and reject bodies above 64 KiB, unknown fields and invalid references. The API never returns provider secret references, subscription binding IDs, executable paths or raw skill catalogue instructions.

Migration 12 adds the selected model, skill-ID array, revision and update timestamp to PostgreSQL `agents`. Existing agent model values are backfilled from their provider; existing skills default to an empty array and timestamps preserve `created_at`. Task ownership now uses `ON DELETE RESTRICT`. This migration is applied lazily by the server's normal migration path; do not target production with test commands.

## Current limits

This feature stores and displays agent configuration. It does **not** yet route PM planning or engineer/QA inference by each agent's provider, model or skills. PM plan requests still use the provider selected for that request. Subscription inference remains fail-closed until the separate Codex CLI, outbound networking, isolation and usage-budget gates are verified. Saving a Codex assignment does not log in, enable inference or change a provider's `ready` state.
