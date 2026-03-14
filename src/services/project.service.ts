import { existsSync, readdirSync, statSync } from "fs";
import { basename, resolve } from "path";
import type { ConfigService } from "./config.service.ts";
import type { Project, ProjectInfo } from "../types/project.ts";

export class ProjectService {
  constructor(private config: ConfigService) {}

  list(): ProjectInfo[] {
    const projects = this.config.get("projects");
    return projects.map((p) => ({
      name: p.name,
      path: p.path,
      hasGit: existsSync(`${p.path}/.git`),
    }));
  }

  add(path: string, name?: string): void {
    const absPath = resolve(path);
    const projectName = name ?? basename(absPath);
    const projects = this.config.get("projects");

    const exists = projects.some((p) => p.path === absPath || p.name === projectName);
    if (exists) {
      throw new Error(`Project "${projectName}" or path "${absPath}" already registered`);
    }

    this.config.set("projects", [...projects, { path: absPath, name: projectName }]);
    this.config.save();
  }

  remove(nameOrPath: string): void {
    const projects = this.config.get("projects");
    const abs = resolve(nameOrPath);
    const filtered = projects.filter(
      (p) => p.name !== nameOrPath && p.path !== abs
    );

    if (filtered.length === projects.length) {
      throw new Error(`Project "${nameOrPath}" not found`);
    }

    this.config.set("projects", filtered);
    this.config.save();
  }

  resolve(nameOrPath?: string): Project {
    const projects = this.config.get("projects");

    if (!nameOrPath) {
      const cwd = process.cwd();
      const found = projects.find(
        (p) => cwd === p.path || cwd.startsWith(p.path + "/")
      );
      if (!found) {
        throw new Error(`No PPM project found for CWD: ${cwd}`);
      }
      return { ...found, hasGit: existsSync(`${found.path}/.git`) };
    }

    const abs = resolve(nameOrPath);
    const found = projects.find((p) => p.name === nameOrPath || p.path === abs);
    if (!found) {
      throw new Error(`Project "${nameOrPath}" not found`);
    }
    return { ...found, hasGit: existsSync(`${found.path}/.git`) };
  }

  scanForGitRepos(dir: string, depth = 3): string[] {
    const results: string[] = [];
    this._scan(resolve(dir), depth, results);
    return results;
  }

  private _scan(dir: string, depth: number, results: string[]): void {
    if (depth < 0) return;

    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      const hasGit = entries.some((e) => e.name === ".git" && e.isDirectory());

      if (hasGit) {
        results.push(dir);
        return; // Don't recurse into git repos
      }

      if (depth === 0) return;

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const child = `${dir}/${entry.name}`;
        try {
          statSync(child);
          this._scan(child, depth - 1, results);
        } catch {
          // skip inaccessible dirs
        }
      }
    } catch {
      // skip unreadable dirs
    }
  }
}
