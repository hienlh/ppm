import { resolve, sep } from "node:path";
import { configService } from "../../services/config.service.ts";

/**
 * Resolve a project name or path to an absolute filesystem path.
 * Name lookup first, then path fallback with security validation.
 */
export function resolveProjectPath(nameOrPath: string): string {
  const projects = configService.get("projects");

  // Try name lookup first
  const byName = projects.find((p) => p.name === nameOrPath);
  if (byName) return resolve(byName.path);

  // Path fallback — must be within a registered project
  const abs = resolve(nameOrPath);
  const allowed = projects.some(
    (p) => abs === resolve(p.path) || abs.startsWith(resolve(p.path) + sep),
  );
  if (!allowed) throw new Error(`Project not found: ${nameOrPath}`);
  return abs;
}
