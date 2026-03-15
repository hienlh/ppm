import { resolve, basename, relative, sep } from "node:path";
import { homedir } from "node:os";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import yaml from "js-yaml";

export interface SlashItem {
  type: "skill" | "command";
  /** Slash name, e.g. "review", "devops/deploy", "ck:research" */
  name: string;
  description: string;
  argumentHint?: string;
  /** Where the item comes from */
  scope: "project" | "user";
}

/** Safely coerce a frontmatter value to string, returns undefined if not a scalar. */
function str(val: unknown): string | undefined {
  if (typeof val === "string") return val;
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  return undefined;
}

/**
 * Parse YAML frontmatter from a Markdown file.
 */
function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match || !match[1]) return { meta: {}, body: content };
  try {
    const meta = yaml.load(match[1]) as Record<string, unknown>;
    const body = content.slice(match[0]!.length).trim();
    return { meta: meta ?? {}, body };
  } catch {
    return { meta: {}, body: content };
  }
}

/**
 * Recursively walk a directory tree, calling `visitor` for every file.
 * Ignores unreadable dirs/files silently.
 */
function walkDir(dir: string, visitor: (filePath: string) => void): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = resolve(dir, entry);
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walkDir(full, visitor);
      } else if (stat.isFile()) {
        visitor(full);
      }
    } catch { /* skip */ }
  }
}

/**
 * Collect commands from a commands directory (recursive).
 * `commands/devops/deploy.md` → name `devops/deploy`
 */
function collectCommands(commandsDir: string, scope: "project" | "user"): SlashItem[] {
  const items: SlashItem[] = [];
  if (!existsSync(commandsDir)) return items;
  walkDir(commandsDir, (filePath) => {
    if (!filePath.endsWith(".md")) return;
    try {
      const content = readFileSync(filePath, "utf-8");
      const { meta } = parseFrontmatter(content);
      const rel = relative(commandsDir, filePath);
      const name = rel.replace(/\.md$/, "").split(sep).join("/");
      items.push({
        type: "command",
        name: str(meta.name) ?? name,
        description: str(meta.description) ?? "",
        argumentHint: str(meta["argument-hint"]),
        scope,
      });
    } catch { /* skip */ }
  });
  return items;
}

/**
 * Collect skills from a skills directory.
 *
 * @param skillsDir    Root skills directory to scan
 * @param scope        "project" or "user"
 * @param strictMode   When true, ONLY pick up SKILL.md files (used for user-global
 *                     which can have many supporting .md files per skill).
 *                     When false, also pick up loose .md files outside SKILL.md dirs
 *                     (used for project-local where flat layout is common).
 */
function collectSkills(skillsDir: string, scope: "project" | "user", strictMode: boolean): SlashItem[] {
  const items: SlashItem[] = [];
  if (!existsSync(skillsDir)) return items;

  const dirsWithSkillMd = new Set<string>();

  // Pass 1: SKILL.md files (directory-based skills)
  walkDir(skillsDir, (filePath) => {
    if (basename(filePath) !== "SKILL.md") return;
    try {
      const content = readFileSync(filePath, "utf-8");
      const { meta } = parseFrontmatter(content);
      const skillDir = resolve(filePath, "..");
      dirsWithSkillMd.add(skillDir);
      const rel = relative(skillsDir, skillDir);
      const pathName = rel.split(sep).join("/");
      const name = str(meta.name) ?? pathName;
      if (!name) return;
      items.push({
        type: "skill",
        name,
        description: str(meta.description) ?? "",
        scope,
      });
    } catch { /* skip */ }
  });

  // Pass 2 (only in relaxed mode): loose .md files not inside a SKILL.md directory
  if (!strictMode) {
    walkDir(skillsDir, (filePath) => {
      if (!filePath.endsWith(".md")) return;
      if (basename(filePath) === "SKILL.md") return;
      const dir = resolve(filePath, "..");
      // Skip supporting files inside a skill dir (or any ancestor)
      let ancestor = dir;
      while (ancestor.startsWith(skillsDir) && ancestor !== skillsDir) {
        if (dirsWithSkillMd.has(ancestor)) return;
        ancestor = resolve(ancestor, "..");
      }
      try {
        const content = readFileSync(filePath, "utf-8");
        const { meta } = parseFrontmatter(content);
        const rel = relative(skillsDir, filePath);
        const pathName = rel.replace(/\.md$/, "").split(sep).join("/");
        const name = str(meta.name) ?? pathName;
        if (!name) return;
        items.push({
          type: "skill",
          name,
          description: str(meta.description) ?? "",
          scope,
        });
      } catch { /* skip */ }
    });
  }

  return items;
}

/**
 * Scan for available slash commands and skills.
 *
 * Sources (merged, project overrides user if same name):
 *   1. User-global:   ~/.claude/commands/  and  ~/.claude/skills/   (strict: SKILL.md only)
 *   2. Project-local:  <projectPath>/.claude/commands/  and  .claude/skills/  (relaxed: also loose .md)
 */
export function listSlashItems(projectPath: string): SlashItem[] {
  const home = homedir();
  const globalClaude = resolve(home, ".claude");

  // Collect from both scopes (user-global uses strict mode)
  const userCommands = collectCommands(resolve(globalClaude, "commands"), "user");
  const userSkills = collectSkills(resolve(globalClaude, "skills"), "user", true);
  const projectCommands = collectCommands(resolve(projectPath, ".claude", "commands"), "project");
  const projectSkills = collectSkills(resolve(projectPath, ".claude", "skills"), "project", false);

  // Merge: project items override user items with the same name
  const map = new Map<string, SlashItem>();
  for (const item of [...userCommands, ...userSkills]) {
    map.set(`${item.type}:${item.name}`, item);
  }
  for (const item of [...projectCommands, ...projectSkills]) {
    map.set(`${item.type}:${item.name}`, item);
  }

  return Array.from(map.values());
}
