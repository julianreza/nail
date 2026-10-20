export const DEFAULT_ALLOWED_RUN_PERMISSIONS = [
  "workspace:read",
  "workspace:write",
  "terminal:execute",
] as const;

export const DEFAULT_ALLOWED_TOOLS = [
  "workspace:read",
  "workspace:write",
  "terminal:execute",
] as const;

export function allowedRunPermissionsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  const configured = environment.NAIL_ALLOWED_RUN_PERMISSIONS;
  if (!configured) return [...DEFAULT_ALLOWED_RUN_PERMISSIONS];
  const permissions = configured.split(",").map((value) => value.trim()).filter(Boolean);
  if (permissions.length === 0 || new Set(permissions).size !== permissions.length) {
    throw new Error("NAIL_ALLOWED_RUN_PERMISSIONS is invalid");
  }
  return permissions;
}
