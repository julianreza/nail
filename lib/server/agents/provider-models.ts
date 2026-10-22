import type { Database } from "../db/database";
import type { ProviderRecord } from "../db/repositories";
import { createCodexDirectRepository } from "../providers/codex-direct/repository";

export async function getProviderModels(
  database: Database,
  provider: ProviderRecord,
): Promise<Array<{ id: string; label: string }>> {
  if (provider.authMode !== "subscription_oauth") {
    return provider.model ? [{ id: provider.model, label: provider.model }] : [];
  }
  if (provider.kind !== "codex") return [];
  const account = await createCodexDirectRepository(database).readAccount(provider.id);
  if (account?.state !== "connected") return [];
  return account.catalog.map(({ id, label }) => ({ id, label }));
}
