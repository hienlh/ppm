import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { providerRegistry } from "../../providers/registry.ts";
import type { DefinitionSource, SlashItem, SlashItemWithSource } from "../slash-discovery/types.ts";
import type { DesignSkillRuntime } from "./design-user-instructions.ts";

export interface ProviderSkills {
  runtime: DesignSkillRuntime;
  items: SlashItem[];
}

/**
 * Where the Claude runtime itself loads skills from (`settingSources: ["user", "project"]`
 * plus plugins). Slash discovery also reads `.ppm`, `.claw`, `.codex` and PPM's bundled
 * folder for the composer's list, but a directive to invoke one of those would fail in
 * the Skill tool, so they are left out here.
 */
const CLAUDE_LOADED_SOURCES = new Set<DefinitionSource>(["project-claude", "user-claude", "user-plugin"]);

function isInside(path: string, dir: string): boolean {
  const fold = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  const child = fold(path), parent = fold(dir);
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** `CLAUDE_CONFIG_DIR` is Claude's own config folder; the other env-var root (`PPM_SKILLS_DIR`) is not. */
function claudeCanLoad(item: SlashItemWithSource): boolean {
  if (CLAUDE_LOADED_SOURCES.has(item.source)) return true;
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  return item.source === "env-var" && !!configDir && isInside(item.rootPath, configDir);
}

/** Agents are delegated to, not followed, and built-ins are the runtime's own commands. */
function isSkillItem(item: SlashItem): boolean {
  return item.type === "skill" || item.type === "command";
}

/**
 * The skills one provider's session can actually load, from the same discovery the chat
 * composer uses, narrowed to what that runtime loads.
 *
 * A provider with its own skill runtime (codex, which exposes `listSkills`) answers for
 * itself, for the session's cwd and account; anything else is a Claude session, which
 * loads what disk discovery finds for the project. The two are never merged, for the
 * composer's reason: a skill only one runtime can load would be a dead directive in the
 * other. With no project (Settings is global), discovery starts from the home folder,
 * which still covers every user-level skill and plugin.
 *
 * `fresh` drops codex's cached list first — for the settings pane, where the user has often
 * just installed the skill they are about to name. Claude's side is read from disk every
 * time: the composer's cached list carries no source, and the source is what filters it.
 */
export async function listProviderSkills(
  providerId: string,
  where: { projectPath?: string | null; sessionId?: string; fresh?: boolean } = {},
): Promise<ProviderSkills> {
  const provider = providerRegistry.get(providerId);
  if (provider?.listSkills) {
    if (where.fresh) provider.invalidateSkillsCache?.();
    const { codexSkillsToSlashItems } = await import("../slash-discovery/codex-skill-items.ts");
    const skills = await provider.listSkills(where.sessionId, where.projectPath ?? undefined);
    return { runtime: "codex", items: codexSkillsToSlashItems(skills.filter((s) => s.enabled !== false)) };
  }
  const { listSlashItemsDetailed } = await import("../slash-discovery/index.ts");
  const { active } = listSlashItemsDetailed(where.projectPath || homedir());
  const items = active
    .filter((item) => isSkillItem(item) && claudeCanLoad(item))
    .map(({ source: _source, rootPath: _root, filePath: _file, ...item }) => item);
  return { runtime: "claude", items };
}
