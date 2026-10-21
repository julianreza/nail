import type { Database } from "../db/database";
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

async function readBudget(database: Database, runId: string): Promise<RunUsageBudget> {
  const budget = (await database
    .prepare(
      `SELECT run_id AS "runId", max_requests AS "maxRequests",
              max_tool_calls AS "maxToolCalls", max_output_tokens AS "maxOutputTokens"
       FROM run_usage_budgets WHERE run_id = $1`,
    )
    .get(runId)) as RunUsageBudget | undefined;
  if (!budget) throw new Error("Finite run usage budget is not configured");
  return budget;
}

async function readUsed(database: Database, runId: string, exceptId?: string): Promise<RemainingUsageBudget> {
  const result = (await database
    .prepare(
      `SELECT COALESCE(SUM(request_count), 0) AS requests,
              COALESCE(SUM(tool_call_count), 0) AS "toolCalls",
              COALESCE(SUM(output_tokens), 0) AS "outputTokens"
       FROM usage_records WHERE run_id = $1 AND ($2::text IS NULL OR id <> $3)`,
    )
    .get(runId, exceptId ?? null, exceptId ?? null)) as unknown as RemainingUsageBudget | undefined;
  if (!result) return { requests: 0, toolCalls: 0, outputTokens: 0 };
  return result;
}

export async function configureRunUsageBudget(
  database: Database,
  input: RunUsageBudget,
): Promise<RunUsageBudget> {
  requireCount(input.maxRequests, "maxRequests");
  requireCount(input.maxToolCalls, "maxToolCalls", true);
  requireCount(input.maxOutputTokens, "maxOutputTokens");
  return (await withTransaction(database, async () => {
    if (!(await createRepositories(database).runs.getById(input.runId))) {
      throw new Error("Run does not exist");
    }
    const existing = (await database
      .prepare("SELECT run_id FROM run_usage_budgets WHERE run_id = $1")
      .get(input.runId));
    if (existing) throw new Error("Run usage budget is already configured");
    const priorUsage = (await readUsed(database, input.runId));
    if (priorUsage.requests || priorUsage.toolCalls || priorUsage.outputTokens) {
      throw new Error("Usage budget must be set before provider requests begin");
    }
    (await database
      .prepare(
        `INSERT INTO run_usage_budgets (run_id, max_requests, max_tool_calls, max_output_tokens)
         VALUES ($1, $2, $3, $4)`,
      )
      .run(input.runId, input.maxRequests, input.maxToolCalls, input.maxOutputTokens));
    return input;
  }));
}

export async function getRemainingUsageBudget(
  database: Database,
  runId: string,
): Promise<RemainingUsageBudget> {
  const budget = (await readBudget(database, runId));
  const used = (await readUsed(database, runId));
  return {
    requests: Math.max(0, budget.maxRequests - used.requests),
    toolCalls: Math.max(0, budget.maxToolCalls - used.toolCalls),
    outputTokens: Math.max(0, budget.maxOutputTokens - used.outputTokens),
  };
}

export async function reserveProviderRequest(
  database: Database,
  input: { runId: string; providerId: string; maxOutputTokens: number },
): Promise<UsageReservation> {
  requireCount(input.maxOutputTokens, "maxOutputTokens");
  return (await withTransaction(database, async () => {
    const budget = (await readBudget(database, input.runId));
    const used = (await readUsed(database, input.runId));
    if (used.requests + 1 > budget.maxRequests) {
      throw new UsageBudgetExceededError("requests");
    }
    if (used.outputTokens + input.maxOutputTokens > budget.maxOutputTokens) {
      throw new UsageBudgetExceededError("output_tokens");
    }
    const id = randomUUID();
    (await createRepositories(database).usageRecords.create({
      id,
      runId: input.runId,
      providerId: input.providerId,
      requestCount: 1,
      toolCallCount: 0,
      outputTokens: input.maxOutputTokens,
      usageState: "reserved",
    }));
    return {
      id,
      runId: input.runId,
      providerId: input.providerId,
      reservedOutputTokens: input.maxOutputTokens,
    };
  }));
}

export async function completeProviderUsage(
  database: Database,
  reservationId: string,
  input: { inputTokens: number | null; outputTokens: number | null; toolCalls: number },
): Promise<{ toolCallsAllowed: boolean }> {
  if (input.inputTokens !== null) requireCount(input.inputTokens, "inputTokens", true);
  if (input.outputTokens !== null) requireCount(input.outputTokens, "outputTokens", true);
  requireCount(input.toolCalls, "toolCalls", true);
  return (await withTransaction(database, async () => {
    const repositories = createRepositories(database);
    const reservation = (await repositories.usageRecords.getById(reservationId));
    if (!reservation || reservation.requestCount !== 1 || reservation.usageState !== "reserved") {
      throw new Error("Usage reservation does not exist or was already settled");
    }
    const budget = (await readBudget(database, reservation.runId));
    if (
      input.outputTokens !== null &&
      input.outputTokens > reservation.outputTokens
    ) {
      throw new UsageBudgetExceededError("output_tokens");
    }
    const used = (await readUsed(database, reservation.runId, reservationId));
    const toolCallsAllowed = used.toolCalls + input.toolCalls <= budget.maxToolCalls;
    const usageIsKnown = input.inputTokens !== null && input.outputTokens !== null;
    const result = (await database
      .prepare(
        `UPDATE usage_records
         SET input_tokens = $1, output_tokens = $2, tool_call_count = $3, usage_state = $4
         WHERE id = $5 AND request_count = 1 AND usage_state = 'reserved'`,
      )
      .run(
        input.inputTokens ?? reservation.inputTokens,
        input.outputTokens ?? reservation.outputTokens,
        input.toolCalls,
        usageIsKnown ? "known" : "unknown",
        reservationId,
      ));
    if (result.changes !== 1) throw new Error("Usage reservation changed before completion");
    return { toolCallsAllowed };
  }));
}
