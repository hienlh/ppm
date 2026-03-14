import { existsSync, statSync, readdirSync, mkdirSync, rmSync, renameSync } from "fs";
import { resolve, relative, basename, dirname } from "path";
import type { FileEntry } from "../types/api.ts";
import type { ConfigService } from "./config.service.ts";

const SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", "__pycache__"]);

export class FileService {
  constructor(private config: ConfigService) {}

  private assertAllowed(filePath: string): string {
    const abs = resolve(filePath);
    const projects = this.config.get("projects");
    const allowed = projects.some((p) => abs === p.path || abs.startsWith(p.path + "/"));
    if (!allowed) {
      throw new Error(`Path not within a registered project: ${abs}`);
    }
    return abs;
  }

  getTree(projectName: string, depth = 3): FileEntry[] {
    const projects = this.config.get("projects");
    const project = projects.find((p) => p.name === projectName);
    if (!project) {
      throw new Error(`Project not found: ${projectName}`);
    }
    const abs = resolve(project.path);
    return this._buildTree(abs, depth);
  }

  private _buildTree(dir: string, depth: number): FileEntry[] {
    if (depth < 0) return [];
    const entries: FileEntry[] = [];

    let items: string[];
    try {
      items = readdirSync(dir) as string[];
    } catch {
      return [];
    }

    for (const name of items) {
      if (name.startsWith(".") && SKIP_DIRS.has(name)) continue;
      if (SKIP_DIRS.has(name)) continue;

      const fullPath = `${dir}/${name}`;
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        const entry: FileEntry = {
          name,
          path: fullPath,
          type: "directory",
          children: depth > 0 ? this._buildTree(fullPath, depth - 1) : [],
        };
        entries.push(entry);
      } else if (stat.isFile()) {
        entries.push({ name, path: fullPath, type: "file", size: stat.size });
      }
    }

    return entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  async readFile(filePath: string): Promise<{ content: string; encoding: string }> {
    const abs = this.assertAllowed(filePath);
    const file = Bun.file(abs);
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);

    // Detect if binary by checking for null bytes in first 8kb
    const sample = bytes.slice(0, 8192);
    const isBinary = sample.includes(0);

    if (isBinary) {
      return { content: Buffer.from(bytes).toString("base64"), encoding: "base64" };
    }
    return { content: Buffer.from(bytes).toString("utf8"), encoding: "utf-8" };
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const abs = this.assertAllowed(filePath);
    await Bun.write(abs, content);
  }

  async createFile(filePath: string, type: "file" | "directory"): Promise<void> {
    const abs = this.assertAllowed(filePath);
    if (type === "directory") {
      mkdirSync(abs, { recursive: true });
    } else {
      const dir = dirname(abs);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      await Bun.write(abs, "");
    }
  }

  deleteFile(filePath: string): void {
    const abs = this.assertAllowed(filePath);
    if (!existsSync(abs)) throw new Error(`Path not found: ${abs}`);
    const stat = statSync(abs);
    rmSync(abs, { recursive: stat.isDirectory(), force: true });
  }

  renameFile(oldPath: string, newPath: string): void {
    const absOld = this.assertAllowed(oldPath);
    // newPath must be within same project — validate by checking old project root
    const projects = this.config.get("projects");
    const project = projects.find((p) => absOld === p.path || absOld.startsWith(p.path + "/"));
    if (!project) throw new Error("Source not within a registered project");
    const absNew = resolve(newPath);
    if (!absNew.startsWith(project.path + "/") && absNew !== project.path) {
      throw new Error("Destination must be within the same project");
    }
    renameSync(absOld, absNew);
  }
}
