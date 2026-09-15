import { Database } from "bun:sqlite";
import { readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

const MAX_MEMORIES = 24;
const MAX_CHARS = 24_000;

function latestDatabase(home: string, name: string): string | undefined {
  try {
    const candidates = readdirSync(home).filter((file) => new RegExp(`^${name}_\\d+\\.sqlite$`).test(file));
    candidates.sort((a, b) => Number(b.match(/_(\d+)/)?.[1]) - Number(a.match(/_(\d+)/)?.[1]));
    return candidates[0] ? join(home, candidates[0]) : undefined;
  } catch { return undefined; }
}

/** Read native distilled memories only for threads belonging to this exact project. */
export function readCodexNativeMemory(projectPath: string, codexHomes: string[]): Array<{ path: string; content: string }> {
  const result: Array<{ path: string; content: string }> = [];
  const windows = process.platform === "win32";
  let canonicalProject = resolve(projectPath);
  try { canonicalProject = realpathSync(canonicalProject); } catch { /* A deleted project can still have native memory. */ }
  const project = canonicalProject.replaceAll("\\", "/").replace(/\/+$/, "");
  let remaining = MAX_CHARS;
  const seen = new Set<string>();
  for (const home of new Set(codexHomes)) {
    if (!remaining || result.length >= MAX_MEMORIES) break;
    const statePath = latestDatabase(home, "state");
    if (!statePath) continue;
    // Older native releases stored stage1_outputs in the state database itself.
    const memoryPath = latestDatabase(home, "memories") ?? statePath;
    let state: Database | undefined;
    let memories: Database | undefined;
    try {
      state = new Database(statePath, { readonly: true });
      const columns = state.query("PRAGMA table_info(threads)").all() as Array<{ name: string }>;
      const cwd = "rtrim(replace(cwd, char(92), '/'), '/')";
      const enabled = columns.some((column) => column.name === "memory_mode") ? " AND memory_mode != 'disabled'" : "";
      const recent = columns.some((column) => column.name === "updated_at") ? " ORDER BY updated_at DESC" : "";
      const threads = state.query(`SELECT id FROM threads WHERE ${windows ? `lower(${cwd})` : cwd} = ?${enabled}${recent} LIMIT 256`)
        .all(windows ? project.toLowerCase() : project) as Array<{ id: string }>;
      if (!threads.length) continue;
      memories = new Database(memoryPath, { readonly: true });
      const placeholders = threads.map(() => "?").join(",");
      const rows = memories.query(`SELECT thread_id, substr(raw_memory, 1, 12000) AS raw_memory, length(raw_memory) AS full_length FROM stage1_outputs WHERE thread_id IN (${placeholders}) ORDER BY generated_at DESC LIMIT ?`)
        .all(...threads.map((thread) => thread.id), MAX_MEMORIES) as Array<{ thread_id: string; raw_memory: string; full_length: number }>;
      for (const row of rows) {
        const raw = row.raw_memory?.trim();
        if (!raw || raw.includes("\0") || seen.has(raw) || remaining < 200) continue;
        const path = `${memoryPath}#stage1_outputs/${row.thread_id}`;
        const excerpt = raw.slice(0, Math.max(0, remaining - 180));
        const truncated = row.full_length > excerpt.length;
        const content = excerpt + (truncated ? "\n[Excerpt truncated. Read the raw_memory column of this source database row for the remaining native memory.]" : "");
        seen.add(raw);
        result.push({ path, content });
        remaining -= content.length;
        if (result.length >= MAX_MEMORIES) break;
      }
    } catch {
      // Missing, locked, or newer incompatible native schemas must not block chat.
    } finally {
      memories?.close();
      state?.close();
    }
  }
  return result;
}
