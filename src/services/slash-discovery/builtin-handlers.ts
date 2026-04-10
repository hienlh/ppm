import { VERSION } from "../../version.ts";
import { getBuiltinByName } from "./builtin-commands.ts";
import { discoverSkillRoots } from "./discover-skill-roots.ts";
import { loadItemsFromRoots } from "./skill-loader.ts";
import { resolveOverrides } from "./resolve-overrides.ts";

/**
 * Handle the /skills built-in command.
 * Returns a formatted text listing of discovered skills.
 */
function handleSkills(projectPath: string): string {
  // Call pipeline directly to avoid circular dependency with index.ts
  const roots = discoverSkillRoots(projectPath);
  const rawItems = loadItemsFromRoots(roots);
  const result = resolveOverrides(rawItems, roots);

  const lines: string[] = ["**Discovered Skills & Commands**\n"];

  if (result.roots.length > 0) {
    lines.push("Roots:");
    for (const root of result.roots) {
      lines.push(`  ${root.path}  (${root.source})`);
    }
    lines.push("");
  }

  const skills = result.active.filter((i) => i.type === "skill");
  const commands = result.active.filter((i) => i.type === "command");

  lines.push(`${skills.length} skills, ${commands.length} commands (${result.shadowed.length} shadowed)\n`);

  for (const item of result.active) {
    if (item.type === "builtin") continue;
    lines.push(`  /${item.name}  [${item.type}]  ${item.source}  — ${item.description || "(no description)"}`);
  }

  if (result.shadowed.length > 0) {
    lines.push("\nShadowed:");
    for (const item of result.shadowed) {
      lines.push(`  /${item.name}  [${item.type}]  ${item.source}  ← shadowed by ${item.shadowedBy.source}`);
    }
  }

  return lines.join("\n");
}

/** Handle the /version built-in command */
function handleVersion(): string {
  return `PPM v${VERSION}`;
}

/**
 * Execute a PPM-handled built-in command.
 * Returns the response text, or null if not a PPM-handled command.
 */
export function executeBuiltin(name: string, projectPath: string): string | null {
  const cmd = getBuiltinByName(name);
  if (!cmd || cmd.handler !== "ppm") return null;

  switch (cmd.name) {
    case "skills": return handleSkills(projectPath);
    case "version": return handleVersion();
    default: return null;
  }
}
