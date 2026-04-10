/** Priority ranking — lower numeric value = higher priority */
export type DefinitionSource =
  | "project-ppm"      // 0 — .ppm/ in project tree
  | "project-claw"     // 1 — .claw/ in project tree
  | "project-codex"    // 2 — .codex/ in project tree
  | "project-claude"   // 3 — .claude/ in project tree
  | "env-var"          // 4 — $PPM_SKILLS_DIR or $CLAUDE_CONFIG_DIR
  | "user-ppm"         // 5 — ~/.ppm/
  | "user-claw"        // 6 — ~/.claw/
  | "user-codex"       // 7 — ~/.codex/
  | "user-claude"      // 8 — ~/.claude/
  | "bundled";         // 9 — shipped with PPM package

export type SlashItemType = "skill" | "command" | "builtin";
export type SlashItemScope = "project" | "user" | "bundled";
export type ItemOrigin = "skills" | "commands";

export interface SlashItem {
  type: SlashItemType;
  /** Slash name, e.g. "review", "devops/deploy", "ck:research" */
  name: string;
  description: string;
  argumentHint?: string;
  /** Where the item comes from */
  scope: SlashItemScope;
  category?: string;
  aliases?: string[];
}

export interface SkillRoot {
  path: string;              // Resolved absolute path
  source: DefinitionSource;
  origin: ItemOrigin;
}

/** Extends SlashItem with source metadata */
export interface SlashItemWithSource extends SlashItem {
  source: DefinitionSource;
  rootPath: string;
  filePath: string;
}

export interface ShadowedItem extends SlashItemWithSource {
  shadowedBy: { name: string; source: DefinitionSource };
}

export interface DiscoveryResult {
  active: SlashItemWithSource[];
  shadowed: ShadowedItem[];
  roots: SkillRoot[];
}
