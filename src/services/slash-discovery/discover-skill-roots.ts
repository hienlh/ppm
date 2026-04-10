import { resolve, dirname } from "node:path";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
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

const ORIGINS: ItemOrigin[] = ["skills", "commands"];

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
): void {
  const full = resolve(basePath, origin);
  if (!isDir(full)) return;
  const resolved = resolve(full);
  if (seen.has(resolved)) return;
  seen.add(resolved);
  roots.push({ path: resolved, source, origin });
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
  addBundledRoot(roots, seen);

  return roots;
}
