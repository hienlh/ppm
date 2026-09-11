import type { CodexSkill, SkillListResponse } from "./codex-protocol.ts";

/**
 * Pure map of a `skills/list` response → the skills codex would actually run.
 *
 * The response groups skills by the cwd they were resolved for, because one
 * app-server can hold several workspaces at once. PPM asks about a single cwd,
 * so every group is flattened into one list.
 *
 * Disabled skills are dropped: codex will not run them, so offering them in the
 * picker would produce a prompt that silently does nothing. Nameless entries
 * are dropped for the same reason — the name is the only thing that invokes a
 * skill.
 *
 * Duplicates are possible (a project-scope skill shadowing a user-scope one of
 * the same name). First occurrence wins, matching the order codex returns.
 */
export function parseSkillList(res: unknown): CodexSkill[] {
  const groups = (res as SkillListResponse | undefined)?.data;
  if (!Array.isArray(groups)) return [];
  const out: CodexSkill[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    const skills = (group as { skills?: unknown })?.skills;
    if (!Array.isArray(skills)) continue;
    for (const raw of skills) {
      if (!raw || typeof raw !== "object") continue;
      const s = raw as Partial<CodexSkill>;
      if (typeof s.name !== "string" || !s.name) continue;
      if (s.enabled === false) continue;
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      out.push({
        name: s.name,
        description: typeof s.description === "string" ? s.description : undefined,
        scope: typeof s.scope === "string" ? s.scope : undefined,
        path: typeof s.path === "string" ? s.path : undefined,
        // Disabled entries were skipped above, so anything reaching here is enabled.
        enabled: true,
        interface: parseInterface(s.interface),
      });
    }
  }
  return out;
}

/**
 * The presentation block codex ships for its own skills — display name, one-line
 * blurb, and icon files on disk. Every field is optional: a user-authored skill
 * has no `interface` at all, so the caller must be able to fall back to `name`.
 */
function parseInterface(raw: unknown): CodexSkill["interface"] {
  if (!raw || typeof raw !== "object") return undefined;
  const i = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  return {
    displayName: str(i.displayName),
    shortDescription: str(i.shortDescription),
    iconSmall: str(i.iconSmall),
    iconLarge: str(i.iconLarge),
    defaultPrompt: str(i.defaultPrompt),
  };
}
