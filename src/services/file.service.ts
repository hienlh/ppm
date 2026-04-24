import {
  existsSync,
  readdirSync,
  statSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  rmSync,
  renameSync,
  cpSync,
} from "node:fs";
import { resolve, relative, dirname, join, normalize, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
import type { FileNode, FileEntry, FileDirEntry } from "../types/project.ts";
import {
  listDir as listDirImpl,
  buildIndex as buildIndexImpl,
  invalidateIndexCache,
  clearIndexCache,
} from "./file-list-index.service.ts";

export { invalidateIndexCache, clearIndexCache };

/** Directories/files excluded from tree listing (legacy — kept for getTree back-compat) */
const EXCLUDED_NAMES = new Set([".git", "node_modules"]);

/** Load and compile gitignore rules from a project root */
function loadGitignore(projectPath: string): Ignore {
  const ig = ignore();
  const gitignorePath = join(projectPath, ".gitignore");
  if (existsSync(gitignorePath)) {
    try {
      const content = readFileSync(gitignorePath, "utf-8");
      ig.add(content);
    } catch {
      // Unreadable — skip
    }
  }
  return ig;
}

/** Max buffer size for binary detection (first 8KB) */
const BINARY_CHECK_BYTES = 8192;

class FileService {
  /**
   * Validate that `targetPath` is inside `projectPath`.
   * Blocks path traversal (../) and access outside project root.
   */
  private assertWithinProject(targetPath: string, projectPath: string): void {
    const normalizedTarget = normalize(resolve(projectPath, targetPath));
    const normalizedProject = normalize(projectPath);
    if (
      !normalizedTarget.startsWith(normalizedProject + sep) &&
      normalizedTarget !== normalizedProject
    ) {
      throw new SecurityError("Path traversal not allowed");
    }
  }

  /** Resolve a relative file path against a project root, with security check */
  private resolveSafe(projectPath: string, filePath: string): string {
    this.assertWithinProject(filePath, projectPath);
    return resolve(projectPath, filePath);
  }

  /** Check if a name is in the exclusion list */
  private isExcluded(name: string): boolean {
    return EXCLUDED_NAMES.has(name);
  }

  /** Build a recursive file tree for a project directory */
  getTree(projectPath: string, depth = 3): FileNode[] {
    const ig = loadGitignore(projectPath);
    return this.buildTree(projectPath, projectPath, 0, depth, ig);
  }

  private buildTree(
    rootPath: string,
    dirPath: string,
    currentDepth: number,
    maxDepth: number,
    ig: Ignore,
  ): FileNode[] {
    if (currentDepth > maxDepth) return [];
    if (!existsSync(dirPath)) return [];

    const entries = readdirSync(dirPath, { withFileTypes: true });
    const nodes: FileNode[] = [];

    for (const entry of entries) {
      if (this.isExcluded(entry.name)) continue;

      const fullPath = join(dirPath, entry.name);
      const relPath = relative(rootPath, fullPath);

      // Check gitignore — `ignore` requires forward slashes, no leading slash
      const relPosix = relPath.split("\\").join("/");
      const checkPath = entry.isDirectory() ? `${relPosix}/` : relPosix;
      const isIgnored = ig.ignores(checkPath) || ig.ignores(relPosix);

      try {
        const stat = statSync(fullPath);
        const node: FileNode = {
          name: entry.name,
          path: relPath,
          type: entry.isDirectory() ? "directory" : "file",
          size: entry.isFile() ? stat.size : undefined,
          modified: stat.mtime.toISOString(),
          ignored: isIgnored || undefined,
        };

        if (entry.isDirectory()) {
          node.children = this.buildTree(rootPath, fullPath, currentDepth + 1, maxDepth, ig);
        }

        nodes.push(node);
      } catch {
        // Permission denied or broken symlink — skip
      }
    }

    // Sort: directories first, then alphabetically
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return nodes;
  }

  /** Search project for files matching a given filename (exact, case-sensitive) */
  resolveFilename(projectPath: string, filename: string, maxResults = 20): FileNode[] {
    const ig = loadGitignore(projectPath);
    const matches: FileNode[] = [];
    this.walkForFilename(projectPath, projectPath, filename, ig, matches, maxResults);
    return matches;
  }

  private walkForFilename(
    rootPath: string,
    dirPath: string,
    targetName: string,
    ig: Ignore,
    results: FileNode[],
    maxResults: number,
  ): void {
    if (results.length >= maxResults) return;
    if (!existsSync(dirPath)) return;

    let entries;
    try { entries = readdirSync(dirPath, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      if (results.length >= maxResults) return;
      if (this.isExcluded(entry.name)) continue;

      const fullPath = join(dirPath, entry.name);
      const relPath = relative(rootPath, fullPath);
      const relPosix = relPath.split("\\").join("/");

      const checkPath = entry.isDirectory() ? `${relPosix}/` : relPosix;
      if (ig.ignores(checkPath) || ig.ignores(relPosix)) continue;

      if (entry.isDirectory()) {
        this.walkForFilename(rootPath, fullPath, targetName, ig, results, maxResults);
      } else if (entry.name === targetName) {
        results.push({ name: entry.name, path: relPath, type: "file" });
      }
    }
  }

  /** Read file content with encoding detection */
  readFile(projectPath: string, filePath: string): { content: string; encoding: string } {
    const absPath = this.resolveSafe(projectPath, filePath);
    this.blockSensitive(filePath);

    if (!existsSync(absPath)) throw new NotFoundError(`File not found: ${filePath}`);

    const stat = statSync(absPath);
    if (stat.isDirectory()) throw new ValidationError("Cannot read a directory");

    // Binary detection: check for null bytes in first chunk
    const buffer = readFileSync(absPath);
    const checkSlice = buffer.subarray(0, BINARY_CHECK_BYTES);
    if (checkSlice.includes(0)) {
      return { content: buffer.toString("base64"), encoding: "base64" };
    }

    return { content: buffer.toString("utf-8"), encoding: "utf-8" };
  }

  /** Write content to a file */
  writeFile(projectPath: string, filePath: string, content: string): void {
    const absPath = this.resolveSafe(projectPath, filePath);
    this.blockSensitive(filePath);

    const dir = dirname(absPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    writeFileSync(absPath, content, "utf-8");
  }

  /** Create a file or directory */
  createFile(projectPath: string, filePath: string, type: "file" | "directory"): void {
    const absPath = this.resolveSafe(projectPath, filePath);
    this.blockSensitive(filePath);

    if (existsSync(absPath)) throw new ValidationError(`Already exists: ${filePath}`);

    if (type === "directory") {
      mkdirSync(absPath, { recursive: true });
    } else {
      const dir = dirname(absPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(absPath, "", "utf-8");
    }
  }

  /** Delete a file or directory */
  deleteFile(projectPath: string, filePath: string): void {
    const absPath = this.resolveSafe(projectPath, filePath);
    this.blockSensitive(filePath);

    if (!existsSync(absPath)) throw new NotFoundError(`Not found: ${filePath}`);

    const stat = statSync(absPath);
    if (stat.isDirectory()) {
      rmSync(absPath, { recursive: true, force: true });
    } else {
      unlinkSync(absPath);
    }
  }

  /** Rename a file or directory */
  renameFile(projectPath: string, oldPath: string, newPath: string): void {
    const absOld = this.resolveSafe(projectPath, oldPath);
    const absNew = this.resolveSafe(projectPath, newPath);
    this.blockSensitive(oldPath);
    this.blockSensitive(newPath);

    if (!existsSync(absOld)) throw new NotFoundError(`Not found: ${oldPath}`);
    if (existsSync(absNew)) throw new ValidationError(`Already exists: ${newPath}`);

    const dir = dirname(absNew);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    renameSync(absOld, absNew);
  }

  /** Move a file or directory to a new location */
  moveFile(projectPath: string, source: string, destination: string): void {
    this.renameFile(projectPath, source, destination);
  }

  copyFile(projectPath: string, source: string, destination: string): void {
    const absSrc = this.resolveSafe(projectPath, source);
    const absDest = this.resolveSafe(projectPath, destination);
    this.blockSensitive(source);
    this.blockSensitive(destination);

    if (!existsSync(absSrc)) throw new NotFoundError(`Not found: ${source}`);
    if (existsSync(absDest)) throw new ValidationError(`Already exists: ${destination}`);

    const dir = dirname(absDest);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    cpSync(absSrc, absDest, { recursive: true });
  }

  /**
   * List one directory level for lazy-load file tree (delegates to file-list-index.service).
   * Applies filesExclude patterns; returns gitignore flag per entry.
   */
  listDir(projectPath: string, relPath: string): FileDirEntry[] {
    return listDirImpl(projectPath, relPath);
  }

  /**
   * Build flat file index for palette/search (delegates to file-list-index.service).
   * Cached per project; invalidated on file change via invalidateIndexCache().
   */
  buildIndex(projectPath: string): FileEntry[] {
    return buildIndexImpl(projectPath);
  }

  /** Block access to sensitive paths (.git/) */
  private blockSensitive(filePath: string): void {
    const normalized = normalize(filePath);
    const parts = normalized.split("/");
    for (const part of parts) {
      if (part === ".git" || part === "node_modules") {
        throw new SecurityError(`Access denied: ${filePath}`);
      }
    }
  }
}

/** Custom error classes for proper HTTP status mapping */
export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecurityError";
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export const fileService = new FileService();

// Wire file watcher → index cache invalidation
// Dynamic import avoids circular dependency (file-watcher → chat.ts → file.service)
import("./file-watcher.service.ts").then(({ onFileChange }) => {
  onFileChange((projectName) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { configService } = require("./config.service.ts");
      const projects = configService.get("projects") as Array<{ name: string; path: string }>;
      const project = projects.find((p: { name: string }) => p.name === projectName);
      if (project) invalidateIndexCache(project.path);
    } catch {
      // Config not yet loaded or project not found — skip invalidation
    }
  });
}).catch(() => { /* file-watcher unavailable in test/CLI context */ });
