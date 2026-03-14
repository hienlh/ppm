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
} from "node:fs";
import { resolve, relative, basename, dirname, join, normalize } from "node:path";
import type { FileNode } from "../types/project.ts";

/** Directories/files excluded from tree listing */
const EXCLUDED_NAMES = new Set([".git", "node_modules", ".env"]);

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
      !normalizedTarget.startsWith(normalizedProject + "/") &&
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
    return this.buildTree(projectPath, projectPath, 0, depth);
  }

  private buildTree(
    rootPath: string,
    dirPath: string,
    currentDepth: number,
    maxDepth: number,
  ): FileNode[] {
    if (currentDepth > maxDepth) return [];
    if (!existsSync(dirPath)) return [];

    const entries = readdirSync(dirPath, { withFileTypes: true });
    const nodes: FileNode[] = [];

    for (const entry of entries) {
      if (this.isExcluded(entry.name)) continue;
      // Skip hidden files at root level (like .env.local etc.)
      if (entry.name.startsWith(".env")) continue;

      const fullPath = join(dirPath, entry.name);
      const relPath = relative(rootPath, fullPath);

      try {
        const stat = statSync(fullPath);
        const node: FileNode = {
          name: entry.name,
          path: relPath,
          type: entry.isDirectory() ? "directory" : "file",
          size: entry.isFile() ? stat.size : undefined,
          modified: stat.mtime.toISOString(),
        };

        if (entry.isDirectory()) {
          node.children = this.buildTree(
            rootPath,
            fullPath,
            currentDepth + 1,
            maxDepth,
          );
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

  /** Read file content with encoding detection */
  readFile(
    projectPath: string,
    filePath: string,
  ): { content: string; encoding: string } {
    const absPath = this.resolveSafe(projectPath, filePath);
    this.blockSensitive(filePath);

    if (!existsSync(absPath)) {
      throw new NotFoundError(`File not found: ${filePath}`);
    }

    const stat = statSync(absPath);
    if (stat.isDirectory()) {
      throw new ValidationError("Cannot read a directory");
    }

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

    // Ensure parent directory exists
    const dir = dirname(absPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(absPath, content, "utf-8");
  }

  /** Create a file or directory */
  createFile(
    projectPath: string,
    filePath: string,
    type: "file" | "directory",
  ): void {
    const absPath = this.resolveSafe(projectPath, filePath);
    this.blockSensitive(filePath);

    if (existsSync(absPath)) {
      throw new ValidationError(`Already exists: ${filePath}`);
    }

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

    if (!existsSync(absPath)) {
      throw new NotFoundError(`Not found: ${filePath}`);
    }

    const stat = statSync(absPath);
    if (stat.isDirectory()) {
      rmSync(absPath, { recursive: true, force: true });
    } else {
      unlinkSync(absPath);
    }
  }

  /** Rename a file or directory */
  renameFile(
    projectPath: string,
    oldPath: string,
    newPath: string,
  ): void {
    const absOld = this.resolveSafe(projectPath, oldPath);
    const absNew = this.resolveSafe(projectPath, newPath);
    this.blockSensitive(oldPath);
    this.blockSensitive(newPath);

    if (!existsSync(absOld)) {
      throw new NotFoundError(`Not found: ${oldPath}`);
    }
    if (existsSync(absNew)) {
      throw new ValidationError(`Already exists: ${newPath}`);
    }

    // Ensure parent dir of new path exists
    const dir = dirname(absNew);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    renameSync(absOld, absNew);
  }

  /** Move a file or directory to a new location */
  moveFile(
    projectPath: string,
    source: string,
    destination: string,
  ): void {
    // Move is functionally the same as rename
    this.renameFile(projectPath, source, destination);
  }

  /** Block access to sensitive paths (.git/, .env*) */
  private blockSensitive(filePath: string): void {
    const normalized = normalize(filePath);
    const parts = normalized.split("/");
    for (const part of parts) {
      if (part === ".git" || part === "node_modules") {
        throw new SecurityError(`Access denied: ${filePath}`);
      }
    }
    // Block .env files
    const file = basename(normalized);
    if (file.startsWith(".env")) {
      throw new SecurityError(`Access denied: ${filePath}`);
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
