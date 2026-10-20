import type { DatabaseSync } from "node:sqlite";
import { createRepositories } from "../db/repositories";
import { reserveProviderRequest, completeProviderUsage, UsageBudgetExceededError } from "./usage-budget";
import { SubscriptionProviderError } from "./subscription-errors";
import type { SubscriptionCompletion, SubscriptionConnector } from "../../domain/subscription-provider";

const MAX_PROMPT_BYTES = 64 * 1024;
const MAX_OUTPUT_TOKENS = 32768;
const MAX_RESULT_BYTES = 512 * 1024;
const BINDING_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function validUsageCount(value: number | null): boolean {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

function validateResult(value: SubscriptionCompletion, providerModel: string): void {
  if (
    !value ||
    typeof value.text !== "string" ||
    value.text.length === 0 ||
    Buffer.byteLength(value.text, "utf8") > MAX_RESULT_BYTES ||
    value.model !== providerModel ||
    value.finishReason !== "stop" ||
    !value.usage ||
    !validUsageCount(value.usage.inputTokens) ||
    !validUsageCount(value.usage.outputTokens)
  ) throw new SubscriptionProviderError("invalid_output");
}

export async function completeProviderText(
  database: DatabaseSync,
  providerId: string,
  runId: string,
  prompt: string,
  maxOutputTokens: number,
  signal: AbortSignal,
  connector: SubscriptionConnector,
): Promise<SubscriptionCompletion> {
  if (
    !providerId || !runId || typeof prompt !== "string" ||
    Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES
  ) throw new SubscriptionProviderError("invalid_binding");
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > MAX_OUTPUT_TOKENS) {
    throw new SubscriptionProviderError("budget_unenforceable");
  }
  if (signal.aborted) throw new SubscriptionProviderError("cancelled");

  const repositories = createRepositories(database);
  const provider = repositories.providers.getById(providerId);
  const run = repositories.runs.getById(runId);
  if (!provider || !run || !["draft", "running"].includes(run.state)) {
    throw new SubscriptionProviderError("invalid_binding");
  }
  if (
    provider.authMode !== "subscription_cli" ||
    provider.kind === null ||
    provider.kind === "deepseek" ||
    provider.secretReference !== null
  ) throw new SubscriptionProviderError("wrong_auth_mode");
  if (provider.status !== "ready") throw new SubscriptionProviderError("unavailable");
  const binding = repositories.accountBindings.getByProviderId(provider.id);
  if (
    !binding || binding.state !== "ready" ||
    !BINDING_ID.test(binding.bindingId)
  ) throw new SubscriptionProviderError("invalid_binding");
  if (!provider.model) throw new SubscriptionProviderError("invalid_model");

  const reservation = reserveProviderRequest(database, { runId, providerId, maxOutputTokens });
  let settled = false;
  try {
    const result = await connector.complete({
      bindingId: binding.bindingId,
      prompt,
      model: provider.model,
      maxOutputTokens,
    }, signal);
    try {
      validateResult(result, provider.model);
    } catch (error) {
      completeProviderUsage(database, reservation.id, {
        inputTokens: null,
        outputTokens: null,
        toolCalls: 0,
      });
      settled = true;
      throw error;
    }

    if (result.usage.outputTokens !== null && result.usage.outputTokens > maxOutputTokens) {
      completeProviderUsage(database, reservation.id, {
        inputTokens: null,
        outputTokens: null,
        toolCalls: 0,
      });
      settled = true;
      throw new UsageBudgetExceededError("output_tokens");
    }

    const budgetResult = completeProviderUsage(database, reservation.id, {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      toolCalls: 0,
    });
    settled = true;
    if (!budgetResult.toolCallsAllowed) throw new UsageBudgetExceededError("tool_calls");
    return result;
  } catch (error) {
    if (!settled) {
      try {
        completeProviderUsage(database, reservation.id, {
          inputTokens: null,
          outputTokens: null,
          toolCalls: 0,
        });
        settled = true;
      } catch {
        // Keep the original failure. The reserved output remains conservatively charged.
      }
    }
    throw error;
  }
}
