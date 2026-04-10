import { resolve, basename, relative, sep } from "node:path";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import yaml from "js-yaml";
import { sourceToScope } from "./definition-source.ts";
import type { SkillRoot, SlashItemWithSource } from "./types.ts";

/** Safely coerce a frontmatter value to string */
function str(val: unknown): string | undefined {
  if (typeof val === "string") return val;
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  return undefined;
}

/** Parse YAML frontmatter from a Markdown file */
function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match || !match[1]) return { meta: {}, body: content };
  try {
    // maxAliasCount prevents YAML bomb DoS (supported in js-yaml >=4.1, not in @types)
    const meta = yaml.load(match[1], { maxAliasCount: 100 } as yaml.LoadOptions) as Record<string, unknown>;
    return { meta: meta ?? {}, body: content.slice(match[0]!.length).trim() };
  } catch {
    return { meta: {}, body: content };
  }
}

/** Recursively walk a directory, calling visitor for every file. Tracks visited paths to prevent symlink cycles and enforces root boundary. */
function walkDir(dir: string, visitor: (filePath: string) => void, visited = new Set<string>(), rootBoundary?: string): void {
  const resolved = resolve(dir);
  if (visited.has(resolved)) return;
  // Prevent symlink escape: resolved path must stay within root boundary
  if (rootBoundary && resolved !== rootBoundary && !resolved.startsWith(rootBoundary + "/")) return;
  visited.add(resolved);
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    const full = resolve(dir, entry);
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) walkDir(full, visitor, visited, rootBoundary);
      else if (stat.isFile()) visitor(full);
    } catch { /* skip */ }
  }
}

/** Collect commands from a root with origin "commands" */
function loadCommands(root: SkillRoot): SlashItemWithSource[] {
  const items: SlashItemWithSource[] = [];
  if (!existsSync(root.path)) return items;
  const scope = sourceToScope(root.source);
  const boundary = resolve(root.path);

  walkDir(root.path, (filePath) => {
    if (!filePath.endsWith(".md")) return;
    try {
      const content = readFileSync(filePath, "utf-8");
      const { meta } = parseFrontmatter(content);
      const rel = relative(root.path, filePath);
      const name = rel.replace(/\.md$/, "").split(sep).join("/");
      items.push({
        type: "command",
        name: str(meta.name) ?? name,
        description: str(meta.description) ?? "",
        argumentHint: str(meta["argument-hint"]),
        scope,
        source: root.source,
        rootPath: root.path,
        filePath,
      });
    } catch { /* skip */ }
  }, new Set(), boundary);
  return items;
}

/**
 * Collect skills from a root with origin "skills".
 * User-global roots use strict mode (SKILL.md only).
 * Project/env roots use relaxed mode (also loose .md files).
 */
function loadSkills(root: SkillRoot): SlashItemWithSource[] {
  const items: SlashItemWithSource[] = [];
  if (!existsSync(root.path)) return items;
  const scope = sourceToScope(root.source);
  const strictMode = scope === "user" || scope === "bundled";
  const dirsWithSkillMd = new Set<string>();

  const boundary = resolve(root.path);

  // Pass 1: SKILL.md directory-based skills
  walkDir(root.path, (filePath) => {
    if (basename(filePath) !== "SKILL.md") return;
    try {
      const content = readFileSync(filePath, "utf-8");
      const { meta } = parseFrontmatter(content);
      const skillDir = resolve(filePath, "..");
      dirsWithSkillMd.add(skillDir);
      const rel = relative(root.path, skillDir);
      const pathName = rel.split(sep).join("/");
      const name = str(meta.name) ?? pathName;
      if (!name) return;
      items.push({
        type: "skill",
        name,
        description: str(meta.description) ?? "",
        argumentHint: str(meta["argument-hint"]),
        scope,
        source: root.source,
        rootPath: root.path,
        filePath,
      });
    } catch { /* skip */ }
  }, new Set(), boundary);

  // Pass 2 (relaxed mode only): loose .md files not inside a SKILL.md directory
  if (!strictMode) {
    walkDir(root.path, (filePath) => {
      if (!filePath.endsWith(".md") || basename(filePath) === "SKILL.md") return;
      const dir = resolve(filePath, "..");
      let ancestor = dir;
      while ((ancestor + "/").startsWith(boundary + "/") && ancestor !== boundary) {
        if (dirsWithSkillMd.has(ancestor)) return;
        ancestor = resolve(ancestor, "..");
      }
      try {
        const content = readFileSync(filePath, "utf-8");
        const { meta } = parseFrontmatter(content);
        const rel = relative(root.path, filePath);
        const pathName = rel.replace(/\.md$/, "").split(sep).join("/");
        const name = str(meta.name) ?? pathName;
        if (!name) return;
        items.push({
          type: "skill",
          name,
          description: str(meta.description) ?? "",
          argumentHint: str(meta["argument-hint"]),
          scope,
          source: root.source,
          rootPath: root.path,
          filePath,
        });
      } catch { /* skip */ }
    }, new Set(), boundary);
  }

  return items;
}

/** Load all slash items from a single root */
export function loadItemsFromRoot(root: SkillRoot): SlashItemWithSource[] {
  return root.origin === "commands" ? loadCommands(root) : loadSkills(root);
}

/** Load items from all roots */
export function loadItemsFromRoots(roots: SkillRoot[]): SlashItemWithSource[] {
  return roots.flatMap(loadItemsFromRoot);
}
