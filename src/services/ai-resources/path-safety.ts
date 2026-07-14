import { resolve, sep } from "node:path";
import { homedir } from "node:os";
import { discoverSkillRoots } from "../slash-discovery/discover-skill-roots.ts";
import { TYPE_TO_ORIGIN, type CreatableScope, type CreatableType } from "./types.ts";

/** Resource names: no slashes, no traversal, filesystem-safe. */
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function isValidResourceName(name: string): boolean {
  return NAME_RE.test(name) && !name.includes("..");
}

function isWithin(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p + sep);
}

/**
 * Assert a filePath belongs to a discovered resource root for this project.
 * Prevents reading/writing arbitrary filesystem paths via the API.
 */
export function assertWithinRoots(filePath: string, projectPath: string): void {
  const roots = discoverSkillRoots(projectPath);
  const ok = roots.some((r) => isWithin(filePath, r.path));
  if (!ok) throw new Error("Path is outside managed resource roots");
}

/** Base `.claude` directory for a given scope. */
function scopeBaseDir(scope: CreatableScope, projectPath: string): string {
  if (scope === "project") {
    if (!projectPath) throw new Error("project scope requires an active project");
    return resolve(projectPath, ".claude");
  }
  return resolve(homedir(), ".claude");
}

/**
 * Compute the target file path for a new resource, with traversal guard.
 * skill   → <base>/skills/<name>/SKILL.md
 * agent   → <base>/agents/<name>.md
 * command → <base>/commands/<name>.md
 */
export function resolveCreateTarget(
  type: CreatableType,
  scope: CreatableScope,
  name: string,
  projectPath: string,
): { dir: string; filePath: string } {
  if (!isValidResourceName(name)) throw new Error("Invalid resource name");
  const originDir = resolve(scopeBaseDir(scope, projectPath), TYPE_TO_ORIGIN[type]);
  if (type === "skill") {
    const dir = resolve(originDir, name);
    const filePath = resolve(dir, "SKILL.md");
    if (!isWithin(filePath, originDir)) throw new Error("Resolved path escapes origin dir");
    return { dir, filePath };
  }
  const filePath = resolve(originDir, `${name}.md`);
  if (!isWithin(filePath, originDir)) throw new Error("Resolved path escapes origin dir");
  return { dir: originDir, filePath };
}
