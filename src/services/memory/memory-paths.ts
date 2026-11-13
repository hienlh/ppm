import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getPpmDir } from "../ppm-dir.ts";
import { projectKey } from "../project-key.ts";

/** `<ppm dir>/memory`: every memory file, the index and the sync status. */
export function memoryRoot(): string {
  return join(getPpmDir(), "memory");
}

/** A project's folder name: the first 16 hex of the sha256 of its `projectKey` (resolved, case-folded on Windows). */
export function projectMemoryKey(projectPath: string): string {
  return createHash("sha256").update(projectKey(projectPath)).digest("hex").slice(0, 16);
}

/** `<memory>/projects/<key>`. Names the folder only; `ensureProjectMemoryDir` creates it. */
export function projectMemoryDir(projectPath: string): string {
  return join(memoryRoot(), "projects", projectMemoryKey(projectPath));
}

/**
 * Creates a project's memory folder with a `project.json` naming the project path, since the
 * folder name is a hash nobody can read back. Returns the folder.
 */
export async function ensureProjectMemoryDir(projectPath: string): Promise<string> {
  const dir = projectMemoryDir(projectPath);
  await mkdir(dir, { recursive: true });
  const marker = join(dir, "project.json");
  if (!existsSync(marker)) await writeFile(marker, `${JSON.stringify({ path: resolve(projectPath) }, null, 2)}\n`);
  return dir;
}

/** `<memory>/global`: memories true in every project. */
export function globalMemoryDir(): string {
  return join(memoryRoot(), "global");
}

/** `<memory>/index.db`: the search index, rebuilt from the Markdown files when missing. */
export function memoryIndexPath(): string {
  return join(memoryRoot(), "index.db");
}

/** `<ppm dir>/memory-embed`: the local embedding model's own install. */
export function embedInstallDir(): string {
  return join(getPpmDir(), "memory-embed");
}
