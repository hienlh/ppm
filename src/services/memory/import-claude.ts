import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseMemoryFile } from "./memory-file.ts";
import type { NativeMemory } from "./memory-types.ts";

export interface ClaudeImportResult {
  items: NativeMemory[];
  skipped: string[];
  error?: string;
}

/** Claude's own memory folder for a project: the real path with every non-alphanumeric turned into "-". */
export async function claudeMemoryDir(projectPath: string, claudeHome?: string): Promise<string> {
  const project = resolve(projectPath);
  const canonical = (await realpath(project).catch(() => project)).normalize("NFC");
  const home = claudeHome ?? (process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"));
  return join(home, "projects", canonical.replace(/[^a-zA-Z0-9]/g, "-"), "memory");
}

/**
 * Reads Claude's topic memories of one project (never its `MEMORY.md` index). Read-only:
 * every file is opened for reading only. A missing folder is zero items, not an error.
 */
export async function importClaudeMemories(
  projectPath: string,
  homes: { claudeHome?: string } = {},
): Promise<ClaudeImportResult> {
  const dir = await claudeMemoryDir(projectPath, homes.claudeHome);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { items: [], skipped: [] };
    return { items: [], skipped: [], error: `cannot read ${dir}: ${(err as Error).message}` };
  }

  const items: NativeMemory[] = [];
  const skipped: string[] = [];
  const files = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md") && e.name.toLowerCase() !== "memory.md")
    .map((e) => e.name)
    .sort();
  for (const file of files) {
    const path = join(dir, file);
    let text: string;
    let mtime: Date;
    try {
      text = await readFile(path, "utf8");
      mtime = (await stat(path)).mtime;
    } catch (err) {
      skipped.push(`${file}: ${(err as Error).message}`);
      continue;
    }
    const stem = file.slice(0, -".md".length);
    // Parsed under the bare stem, so a file without a name in its frontmatter is named after the file.
    const record = parseMemoryFile(text, stem, "project");
    items.push({
      id: `claude-${stem}`,
      scope: "project",
      name: record.name,
      description: record.description,
      type: record.type,
      body: record.body,
      origin: path,
      originHash: createHash("sha256").update(text).digest("hex").slice(0, 16),
      sourceUpdated: mtime.toISOString(),
    });
  }
  return { items, skipped };
}
