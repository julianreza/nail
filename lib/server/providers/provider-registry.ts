import type { Database } from "../db/database";
import type { SubscriptionCompletion, SubscriptionConnector } from "../../domain/subscription-provider";
import { createRepositories } from "../db/repositories";
import type { EncryptedSecretStore } from "./secret-store";
import { DeepSeekAdapter, ProviderConfigurationError, ProviderUnavailableError } from "./deepseek-adapter";
import { SubscriptionProviderError } from "./subscription-errors";
import { completeProviderText } from "./subscription-adapter";

export interface ProviderRegistryDependencies {
  database: Database;
  connector: SubscriptionConnector;
  secretStore?: EncryptedSecretStore;
  getSecretStore?: () => EncryptedSecretStore;
  fetcher?: typeof fetch;
}

export interface CompleteProviderTextRequest {
  providerId: string;
  runId: string;
  prompt: string;
  maxOutputTokens: number;
  signal: AbortSignal;
}

export interface ProviderRegistry {
  completeText(input: CompleteProviderTextRequest): Promise<SubscriptionCompletion>;
}

function normalizeDeepSeekResult(
  result: Awaited<ReturnType<DeepSeekAdapter["complete"]>>,
  model: string,
): SubscriptionCompletion {
  if (
    result.kind !== "complete" ||
    typeof result.content !== "string" ||
    result.finishReason !== "stop" ||
    result.toolCalls.length > 0
  ) throw new SubscriptionProviderError("invalid_output");
  return {
    text: result.content,
    model,
    usage: {
      inputTokens: result.usage?.inputTokens ?? null,
      outputTokens: result.usage?.outputTokens ?? null,
    },
    finishReason: "stop",
  };
}

export function createProviderRegistry(dependencies: ProviderRegistryDependencies): ProviderRegistry {
  return {
    async completeText(input: CompleteProviderTextRequest): Promise<SubscriptionCompletion> {
      const provider = (await createRepositories(dependencies.database).providers.getById(input.providerId));
      if (!provider) throw new SubscriptionProviderError("invalid_binding");
      if (provider.kind === "deepseek" && provider.authMode === "api_key") {
        const secretStore = dependencies.secretStore ?? dependencies.getSecretStore?.();
        if (!secretStore) throw new ProviderConfigurationError();
        if (!provider.model || provider.status !== "ready" || !provider.secretReference) {
          throw new ProviderUnavailableError();
        }
        const adapter = new DeepSeekAdapter({
          database: dependencies.database,
          secretStore,
          fetcher: dependencies.fetcher,
        });
        const result = await adapter.complete({
          runId: input.runId,
          providerId: provider.id,
          maxOutputTokens: input.maxOutputTokens,
          messages: [{ role: "user", content: input.prompt }],
          signal: input.signal,
        });
        return normalizeDeepSeekResult(result, provider.model);
      }
      if (provider.kind && provider.kind !== "deepseek" && provider.authMode === "subscription_cli") {
        return completeProviderText(
          dependencies.database,
          provider.id,
          input.runId,
          input.prompt,
          input.maxOutputTokens,
          input.signal,
          dependencies.connector,
        );
      }
      throw new SubscriptionProviderError("wrong_auth_mode");
    },
  };
}
