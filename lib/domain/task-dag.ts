export interface TaskDependency {
  id: string;
  dependsOn: string[];
}

export type TaskDagValidation =
  | { valid: true }
  | {
      valid: false;
      reason: "duplicate_id" | "missing_dependency" | "cycle" | "self_dependency";
    };

export function validateTaskDag(tasks: readonly TaskDependency[]): TaskDagValidation {
  const byId = new Map<string, TaskDependency>();

  for (const task of tasks) {
    if (byId.has(task.id)) {
      return { valid: false, reason: "duplicate_id" };
    }
    byId.set(task.id, task);
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) {
        return { valid: false, reason: "self_dependency" };
      }
      if (!byId.has(dependency)) {
        return { valid: false, reason: "missing_dependency" };
      }
    }
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();

  function hasCycle(id: string): boolean {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;

    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (hasCycle(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }

  for (const task of tasks) {
    if (hasCycle(task.id)) {
      return { valid: false, reason: "cycle" };
    }
  }

  return { valid: true };
}
