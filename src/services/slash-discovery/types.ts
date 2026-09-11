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
  | "user-plugin"      // 9 — ~/.claude/plugins/<plugin>/
  | "bundled";         // 10 — shipped with PPM package

export type SlashItemType = "skill" | "command" | "builtin" | "agent";
export type SlashItemScope = "project" | "user" | "bundled";
export type ItemOrigin = "skills" | "commands" | "agents";

/** Who runs a built-in: PPM server, the web client, or the Claude SDK */
export type SlashHandler = "ppm" | "sdk" | "client";

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
  /** Agent-only: model the subagent runs on (e.g. "sonnet", "opus", "inherit") */
  model?: string;
  /** Agent-only: allowed tools (parsed from comma-separated string or YAML list) */
  tools?: string[];
  /** Built-in only: which layer executes the command */
  handler?: SlashHandler;
  /**
   * Sigil the runtime expects when the item is invoked. Absent means `/`, which
   * is every Claude-side skill and command. Codex resolves its skills from a
   * `$name` mention inside the prompt instead, so an item carrying `"$"` must be
   * sent with that prefix or codex treats it as ordinary prose.
   */
  invokeSigil?: "/" | "$";
  /** Pretty label the runtime supplies for itself, when it does (codex system skills). */
  displayName?: string;
  /**
   * Runtime-supplied icon, inlined as a data URI rather than a URL.
   *
   * The source files sit inside the codex account home, which the credential
   * path guard refuses on every generic file route — correctly, since
   * `auth.json` is a sibling. Inlining keeps that door shut: the icon never
   * needs a servable path, and the client never sends one back. They are small
   * enough for this to be cheap (under 3 KB each).
   */
  iconDataUri?: string;
}

export interface SkillRoot {
  path: string;              // Resolved absolute path
  source: DefinitionSource;
  origin: ItemOrigin;
  /**
   * Owning Claude Code plugin, set only for roots under ~/.claude/plugins/.
   * Items below such a root are namespaced `<pluginName>:<path>`, matching how
   * Claude Code itself registers them.
   */
  pluginName?: string;
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
