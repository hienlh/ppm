import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve, basename, join } from "node:path";
import { configService } from "./config.service.ts";
import type { ProjectConfig } from "../types/config.ts";
import type { ProjectInfo } from "../types/project.ts";

const MAX_SCAN_DEPTH = 3;

class ProjectService {
  /** List all registered projects with optional git info */
  list(): ProjectInfo[] {
    const projects = configService.get("projects");
    return projects.map((p) => ({
      name: p.name,
      path: p.path,
      ...(p.color ? { color: p.color } : {}),
    }));
  }

  /** Add a project by path. Auto-derives name from folder if not given. */
  add(projectPath: string, name?: string): ProjectConfig {
    const abs = resolve(projectPath);
    if (!existsSync(abs)) {
      throw new Error(`Path does not exist: ${abs}`);
    }

    const projects = configService.get("projects");
    const projectName = name ?? basename(abs);

    // Check duplicates
    if (projects.some((p) => p.name === projectName)) {
      throw new Error(`Project "${projectName}" already exists`);
    }
    if (projects.some((p) => resolve(p.path) === abs)) {
      throw new Error(`Path "${abs}" already registered`);
    }

    const entry: ProjectConfig = { path: abs, name: projectName };
    configService.set("projects", [...projects, entry]);
    configService.save();
    return entry;
  }

  /** Update a project's name and/or path */
  update(
    currentName: string,
    updates: { name?: string; path?: string },
  ): ProjectConfig {
    const projects = configService.get("projects");
    const idx = projects.findIndex((p) => p.name === currentName);
    if (idx === -1) {
      throw new Error(`Project not found: ${currentName}`);
    }

    const current = projects[idx]!;
    const newName = updates.name?.trim() || current.name;
    const newPath = updates.path ? resolve(updates.path) : current.path;

    // Validate new path exists
    if (updates.path && !existsSync(newPath)) {
      throw new Error(`Path does not exist: ${newPath}`);
    }

    // Check name uniqueness (skip self)
    if (
      newName !== currentName &&
      projects.some((p) => p.name === newName)
    ) {
      throw new Error(`Project "${newName}" already exists`);
    }

    // Check path uniqueness (skip self)
    if (
      newPath !== current.path &&
      projects.some((p, i) => i !== idx && resolve(p.path) === newPath)
    ) {
      throw new Error(`Path "${newPath}" already registered`);
    }

    const updated: ProjectConfig = { path: newPath, name: newName };
    projects[idx] = updated;
    configService.set("projects", projects);
    configService.save();
    return updated;
  }

  /** Remove a project by name or path */
  remove(nameOrPath: string): void {
    const projects = configService.get("projects");
    const abs = resolve(nameOrPath);
    const filtered = projects.filter(
      (p) => p.name !== nameOrPath && resolve(p.path) !== abs,
    );

    if (filtered.length === projects.length) {
      throw new Error(`Project not found: ${nameOrPath}`);
    }

    configService.set("projects", filtered);
    configService.save();
  }

  /** Resolve a project by name or path */
  resolve(nameOrPath: string): ProjectConfig {
    const projects = configService.get("projects");

    // Try name first
    const byName = projects.find((p) => p.name === nameOrPath);
    if (byName) return byName;

    // Try path
    const abs = resolve(nameOrPath);
    const byPath = projects.find((p) => resolve(p.path) === abs);
    if (byPath) return byPath;

    throw new Error(`Project not found: ${nameOrPath}`);
  }

  /** Scan a directory recursively for .git folders (up to MAX_SCAN_DEPTH) */
  scanForGitRepos(dir: string, depth = 0): string[] {
    const results: string[] = [];
    const abs = resolve(dir);

    if (depth > MAX_SCAN_DEPTH || !existsSync(abs)) return results;

    try {
      const entries = readdirSync(abs, { withFileTypes: true });

      // Check if this directory itself is a git repo
      if (entries.some((e) => e.name === ".git" && e.isDirectory())) {
        results.push(abs);
        return results; // Don't scan inside git repos
      }

      // Recurse into subdirectories
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith(".") || entry.name === "node_modules") {
          continue;
        }
        results.push(...this.scanForGitRepos(join(abs, entry.name), depth + 1));
      }
    } catch {
      // Permission denied or other FS error — skip
    }

    return results;
  }
}

export const projectService = new ProjectService();
