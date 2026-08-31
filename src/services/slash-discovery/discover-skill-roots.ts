import { resolve, dirname, basename } from "node:path";
import { existsSync, statSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadDisabledPluginKeys } from "./plugin-enablement.ts";
import type { SkillRoot, DefinitionSource, ItemOrigin } from "./types.ts";

/** Tool ecosystem prefixes mapped to their DefinitionSource for project-level roots */
const PROJECT_ECOSYSTEMS: Array<{ dir: string; source: DefinitionSource }> = [
  { dir: ".ppm", source: "project-ppm" },
  { dir: ".claw", source: "project-claw" },
  { dir: ".codex", source: "project-codex" },
  { dir: ".claude", source: "project-claude" },
];

/** User-global ecosystem roots (same prefixes, different source) */
const USER_ECOSYSTEMS: Array<{ dir: string; source: DefinitionSource }> = [
  { dir: ".ppm", source: "user-ppm" },
  { dir: ".claw", source: "user-claw" },
  { dir: ".codex", source: "user-codex" },
  { dir: ".claude", source: "user-claude" },
];

const ORIGINS: ItemOrigin[] = ["skills", "commands", "agents"];

/** Resolve PPM package root for bundled skills */
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BUNDLED_SKILLS_DIR = resolve(PKG_ROOT, "assets/skills");

/** Check if a path is a readable directory */
function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/** Push root if the directory exists and hasn't been seen yet */
function addRoot(
  roots: SkillRoot[],
  seen: Set<string>,
  basePath: string,
  origin: ItemOrigin,
  source: DefinitionSource,
  pluginName?: string,
): void {
  const full = resolve(basePath, origin);
  if (!isDir(full)) return;
  const resolved = resolve(full);
  if (seen.has(resolved)) return;
  seen.add(resolved);
  roots.push({ path: resolved, source, origin, ...(pluginName && { pluginName }) });
}

/**
 * Walk ancestor directories from projectPath upward, stopping at git root.
 * At each level, check for ecosystem skill/command directories.
 */
function walkAncestors(projectPath: string, roots: SkillRoot[], seen: Set<string>): void {
  let current = resolve(projectPath);
  const root = (current.startsWith("/") ? "/" : current.slice(0, 3)); // unix root or Windows drive

  while (current !== root) {
    for (const eco of PROJECT_ECOSYSTEMS) {
      const base = resolve(current, eco.dir);
      for (const origin of ORIGINS) {
        addRoot(roots, seen, base, origin, eco.source);
      }
    }
    // Stop at git root boundary
    if (isDir(resolve(current, ".git"))) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/** Check environment variable paths for additional roots */
function checkEnvVars(roots: SkillRoot[], seen: Set<string>): void {
  const ppmSkillsDir = process.env.PPM_SKILLS_DIR;
  if (ppmSkillsDir && isDir(ppmSkillsDir)) {
    const resolved = resolve(ppmSkillsDir);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      roots.push({ path: resolved, source: "env-var", origin: "skills" });
    }
  }

  const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  if (claudeConfigDir) {
    for (const origin of ORIGINS) {
      addRoot(roots, seen, claudeConfigDir, origin, "env-var");
    }
  }
}

/** Add user-global roots (~/.ppm, ~/.claw, ~/.codex, ~/.claude) */
function addUserGlobalRoots(roots: SkillRoot[], seen: Set<string>): void {
  const home = homedir();
  for (const eco of USER_ECOSYSTEMS) {
    const base = resolve(home, eco.dir);
    for (const origin of ORIGINS) {
      addRoot(roots, seen, base, origin, eco.source);
    }
  }
}

/** Entry shape we rely on from ~/.claude/plugins/installed_plugins.json (schema version 2) */
interface InstalledPluginsFile {
  plugins?: Record<string, Array<{ installPath?: string }>>;
}

/** An installed plugin. `key` is `plugin-id@marketplace-id`, absent for scanned fallbacks. */
export interface InstalledPlugin {
  key?: string;
  path: string;
}

/**
 * Resolve installed Claude Code plugins.
 * Prefers the registry file (it pins the active version and covers remote
 * marketplaces); falls back to scanning for directories carrying a manifest.
 */
export function resolveInstalledPlugins(pluginsDir: string): InstalledPlugin[] {
  try {
    const parsed = JSON.parse(
      readFileSync(resolve(pluginsDir, "installed_plugins.json"), "utf-8"),
    ) as InstalledPluginsFile;
    const installs: InstalledPlugin[] = [];
    for (const [key, entries] of Object.entries(parsed.plugins ?? {})) {
      for (const entry of entries ?? []) {
        if (typeof entry?.installPath === "string" && isDir(entry.installPath)) {
          installs.push({ key, path: entry.installPath });
        }
      }
    }
    if (installs.length) return installs;
  } catch { /* registry missing or malformed — fall through to scan */ }

  try {
    return readdirSync(pluginsDir)
      .map((entry) => resolve(pluginsDir, entry))
      .filter((p) => isDir(p) && existsSync(resolve(p, ".claude-plugin", "plugin.json")))
      .map((path) => ({ path }));
  } catch {
    return [];
  }
}

/**
 * Plugin identifier used as the namespace prefix. The registry key is
 * `plugin-id@marketplace-id`, so the id is everything before the `@`; scanned
 * fallbacks read the manifest, and the directory name is the last resort.
 */
export function resolvePluginName(plugin: InstalledPlugin): string {
  const fromKey = plugin.key?.split("@")[0]?.trim();
  if (fromKey) return fromKey;
  try {
    const manifest = JSON.parse(
      readFileSync(resolve(plugin.path, ".claude-plugin", "plugin.json"), "utf-8"),
    ) as { name?: unknown };
    if (typeof manifest.name === "string" && manifest.name.trim()) return manifest.name.trim();
  } catch { /* manifest missing or malformed — fall through */ }
  return basename(plugin.path);
}

/** Add roots for Claude Code plugins, which ship their own skills/commands/agents */
function addPluginRoots(roots: SkillRoot[], seen: Set<string>, projectPath: string): void {
  const pluginsDir = resolve(homedir(), ".claude", "plugins");
  if (!isDir(pluginsDir)) return;
  const disabled = loadDisabledPluginKeys(projectPath);
  for (const plugin of resolveInstalledPlugins(pluginsDir)) {
    if (plugin.key && disabled.has(plugin.key)) continue;
    const pluginName = resolvePluginName(plugin);
    for (const origin of ORIGINS) {
      addRoot(roots, seen, plugin.path, origin, "user-plugin", pluginName);
    }
  }
}

/** Add bundled skills root (shipped with PPM package) */
function addBundledRoot(roots: SkillRoot[], seen: Set<string>): void {
  if (isDir(BUNDLED_SKILLS_DIR)) {
    const resolved = resolve(BUNDLED_SKILLS_DIR);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      roots.push({ path: resolved, source: "bundled", origin: "skills" });
    }
  }
}

/**
 * Discover all skill/command roots for a project.
 * Returns ordered array (highest priority first).
 */
export function discoverSkillRoots(projectPath: string): SkillRoot[] {
  const roots: SkillRoot[] = [];
  const seen = new Set<string>();

  walkAncestors(projectPath, roots, seen);
  checkEnvVars(roots, seen);
  addUserGlobalRoots(roots, seen);
  addPluginRoots(roots, seen, projectPath);
  addBundledRoot(roots, seen);

  return roots;
}
