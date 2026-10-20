export const RUN_STATES = [
  "draft",
  "awaiting_approval",
  "queued",
  "running",
  "awaiting_review",
  "blocked",
  "interrupted",
  "failed",
  "done",
  "cancelled",
] as const;

export type RunState = (typeof RUN_STATES)[number];

const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set([
  "failed",
  "done",
  "cancelled",
]);

const RUN_STATE_TRANSITIONS: Record<RunState, readonly RunState[]> = {
  draft: ["awaiting_approval", "cancelled", "failed"],
  awaiting_approval: ["draft", "queued", "blocked", "cancelled"],
  queued: ["running", "blocked", "cancelled"],
  running: [
    "awaiting_review",
    "blocked",
    "interrupted",
    "failed",
    "cancelled",
  ],
  awaiting_review: ["queued", "done", "blocked", "cancelled"],
  blocked: ["draft", "awaiting_approval", "queued", "cancelled"],
  interrupted: ["queued", "cancelled"],
  failed: [],
  done: [],
  cancelled: [],
};

export function isTerminalRunState(state: RunState): boolean {
  return TERMINAL_RUN_STATES.has(state);
}

export function canTransitionRunState(
  current: RunState,
  next: RunState,
): boolean {
  return RUN_STATE_TRANSITIONS[current].includes(next);
}
