import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createRepositories } from "../db/repositories";
import { withTransaction } from "../db/database";

export interface RunUsageBudget {
  runId: string;
  maxRequests: number;
  maxToolCalls: number;
  maxOutputTokens: number;
}

export interface UsageReservation {
  id: string;
  runId: string;
  providerId: string | null;
  reservedOutputTokens: number;
}

export interface RemainingUsageBudget {
  requests: number;
  toolCalls: number;
  outputTokens: number;
}

export class UsageBudgetExceededError extends Error {
  constructor(public readonly limit: "requests" | "tool_calls" | "output_tokens") {
    super(`Run ${limit} budget exceeded`);
    this.name = "UsageBudgetExceededError";
  }
}

function requireCount(value: number, name: string, allowZero = false): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`${name} must be a finite ${allowZero ? "non-negative" : "positive"} integer`);
  }
}

function readBudget(database: DatabaseSync, runId: string): RunUsageBudget {
  const budget = database
    .prepare(
      `SELECT run_id AS runId, max_requests AS maxRequests,
              max_tool_calls AS maxToolCalls, max_output_tokens AS maxOutputTokens
       FROM run_usage_budgets WHERE run_id = ?`,
    )
    .get(runId) as RunUsageBudget | undefined;
  if (!budget) throw new Error("Finite run usage budget is not configured");
  return budget;
}

function readUsed(database: DatabaseSync, runId: string, exceptId?: string): RemainingUsageBudget {
  const result = database
    .prepare(
      `SELECT COALESCE(SUM(request_count), 0) AS requests,
              COALESCE(SUM(tool_call_count), 0) AS toolCalls,
              COALESCE(SUM(output_tokens), 0) AS outputTokens
       FROM usage_records WHERE run_id = ? AND (? IS NULL OR id <> ?)`,
    )
    .get(runId, exceptId ?? null, exceptId ?? null) as unknown as RemainingUsageBudget | undefined;
  if (!result) return { requests: 0, toolCalls: 0, outputTokens: 0 };
  return result;
}

export function configureRunUsageBudget(
  database: DatabaseSync,
  input: RunUsageBudget,
): RunUsageBudget {
  requireCount(input.maxRequests, "maxRequests");
  requireCount(input.maxToolCalls, "maxToolCalls", true);
  requireCount(input.maxOutputTokens, "maxOutputTokens");
  return withTransaction(database, () => {
    if (!createRepositories(database).runs.getById(input.runId)) {
      throw new Error("Run does not exist");
    }
    const existing = database
      .prepare("SELECT run_id FROM run_usage_budgets WHERE run_id = ?")
      .get(input.runId);
    if (existing) throw new Error("Run usage budget is already configured");
    const priorUsage = readUsed(database, input.runId);
    if (priorUsage.requests || priorUsage.toolCalls || priorUsage.outputTokens) {
      throw new Error("Usage budget must be set before provider requests begin");
    }
    database
      .prepare(
        `INSERT INTO run_usage_budgets (run_id, max_requests, max_tool_calls, max_output_tokens)
         VALUES (?, ?, ?, ?)`,
      )
      .run(input.runId, input.maxRequests, input.maxToolCalls, input.maxOutputTokens);
    return input;
  });
}

export function getRemainingUsageBudget(
  database: DatabaseSync,
  runId: string,
): RemainingUsageBudget {
  const budget = readBudget(database, runId);
  const used = readUsed(database, runId);
  return {
    requests: Math.max(0, budget.maxRequests - used.requests),
    toolCalls: Math.max(0, budget.maxToolCalls - used.toolCalls),
    outputTokens: Math.max(0, budget.maxOutputTokens - used.outputTokens),
  };
}

export function reserveProviderRequest(
  database: DatabaseSync,
  input: { runId: string; providerId: string; maxOutputTokens: number },
): UsageReservation {
  requireCount(input.maxOutputTokens, "maxOutputTokens");
  return withTransaction(database, () => {
    const budget = readBudget(database, input.runId);
    const used = readUsed(database, input.runId);
    if (used.requests + 1 > budget.maxRequests) {
      throw new UsageBudgetExceededError("requests");
    }
    if (used.outputTokens + input.maxOutputTokens > budget.maxOutputTokens) {
      throw new UsageBudgetExceededError("output_tokens");
    }
    const id = randomUUID();
    createRepositories(database).usageRecords.create({
      id,
      runId: input.runId,
      providerId: input.providerId,
      requestCount: 1,
      toolCallCount: 0,
      outputTokens: input.maxOutputTokens,
      usageState: "reserved",
    });
    return {
      id,
      runId: input.runId,
      providerId: input.providerId,
      reservedOutputTokens: input.maxOutputTokens,
    };
  });
}

export function completeProviderUsage(
  database: DatabaseSync,
  reservationId: string,
  input: { inputTokens: number | null; outputTokens: number | null; toolCalls: number },
): { toolCallsAllowed: boolean } {
  if (input.inputTokens !== null) requireCount(input.inputTokens, "inputTokens", true);
  if (input.outputTokens !== null) requireCount(input.outputTokens, "outputTokens", true);
  requireCount(input.toolCalls, "toolCalls", true);
  return withTransaction(database, () => {
    const repositories = createRepositories(database);
    const reservation = repositories.usageRecords.getById(reservationId);
    if (!reservation || reservation.requestCount !== 1 || reservation.usageState !== "reserved") {
      throw new Error("Usage reservation does not exist or was already settled");
    }
    const budget = readBudget(database, reservation.runId);
    if (
      input.outputTokens !== null &&
      input.outputTokens > reservation.outputTokens
    ) {
      throw new UsageBudgetExceededError("output_tokens");
    }
    const used = readUsed(database, reservation.runId, reservationId);
    const toolCallsAllowed = used.toolCalls + input.toolCalls <= budget.maxToolCalls;
    const usageIsKnown = input.inputTokens !== null && input.outputTokens !== null;
    const result = database
      .prepare(
        `UPDATE usage_records
         SET input_tokens = ?, output_tokens = ?, tool_call_count = ?, usage_state = ?
         WHERE id = ? AND request_count = 1 AND usage_state = 'reserved'`,
      )
      .run(
        input.inputTokens ?? reservation.inputTokens,
        input.outputTokens ?? reservation.outputTokens,
        input.toolCalls,
        usageIsKnown ? "known" : "unknown",
        reservationId,
      );
    if (result.changes !== 1) throw new Error("Usage reservation changed before completion");
    return { toolCallsAllowed };
  });
}
