import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseMemoryFile } from "./memory-file.ts";
import type { NativeMemory } from "./memory-types.ts";

export interface CodexImportResult {
  items: NativeMemory[];
  skipped: string[];
  /** Set when a database could not be read (absent table, locked, not a database); the items are then incomplete. */
  error?: string;
}

/** Thread ids per query, well under SQLite's bound-parameter limit. */
const THREAD_CHUNK = 500;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * `~/.codex` and `CODEX_HOME`. The accounts' homes come from the database, which the memory host
 * never opens: the sync passes every home the server sent it.
 */
function defaultCodexHomes(): string[] {
  const homes = [join(homedir(), ".codex")];
  if (process.env.CODEX_HOME) homes.push(process.env.CODEX_HOME);
  return homes;
}

/** Newest `<prefix><N>.sqlite` in the home, N compared as a number. */
function latest(files: string[], prefix: string): string | undefined {
  const re = new RegExp(`^${prefix}(\\d+)\\.sqlite$`);
  let best: { file: string; n: number } | undefined;
  for (const file of files) {
    const m = re.exec(file);
    if (m && (!best || Number(m[1]) > best.n)) best = { file, n: Number(m[1]) };
  }
  return best?.file;
}

const columnsOf = (db: Database, table: string) =>
  new Set((db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));

/** Ids of this project's threads whose memory is not disabled, from `threads` of the state database. */
function projectThreads(statePath: string, project: string): string[] {
  const windows = process.platform === "win32";
  const state = new Database(statePath, { readonly: true });
  try {
    const columns = columnsOf(state, "threads");
    if (!columns.has("id") || !columns.has("cwd")) throw new Error("no threads table with id and cwd");
    const cwd = "rtrim(replace(cwd, char(92), '/'), '/')";
    const enabled = columns.has("memory_mode") ? " AND (memory_mode IS NULL OR memory_mode != 'disabled')" : "";
    const rows = state.query(`SELECT id FROM threads WHERE ${windows ? `lower(${cwd})` : cwd} = ?${enabled}`)
      .all(windows ? project.toLowerCase() : project) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  } finally {
    state.close();
  }
}

interface Stage1Row { thread_id: string; raw_memory: string | null; rollout_summary: string | null; rollout_slug: string | null; source_updated_at: number | null }

function stage1Rows(memoryPath: string, threadIds: string[]): Stage1Row[] {
  const db = new Database(memoryPath, { readonly: true });
  try {
    const columns = columnsOf(db, "stage1_outputs");
    if (!columns.size) throw new Error("no stage1_outputs table");
    for (const required of ["thread_id", "raw_memory"]) {
      if (!columns.has(required)) throw new Error(`stage1_outputs has no ${required} column`);
    }
    const optional = (name: string) => (columns.has(name) ? name : `NULL AS ${name}`);
    const order = columns.has("generated_at") ? " ORDER BY generated_at DESC" : "";
    const rows: Stage1Row[] = [];
    for (let i = 0; i < threadIds.length; i += THREAD_CHUNK) {
      const chunk = threadIds.slice(i, i + THREAD_CHUNK);
      rows.push(...(db.query(
        `SELECT thread_id, raw_memory, ${optional("rollout_summary")}, ${optional("rollout_slug")}, ${optional("source_updated_at")} FROM stage1_outputs WHERE thread_id IN (${chunk.map(() => "?").join(",")})${order}`,
      ).all(...chunk) as Stage1Row[]));
    }
    return rows;
  } finally {
    db.close();
  }
}

const heading = (text: string) => /^#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(text)?.[1]?.trim() ?? "";

function toMemory(row: Stage1Row): NativeMemory | string {
  const raw = (row.raw_memory ?? "").trim();
  const summary = (row.rollout_summary ?? "").trim();
  const body = raw || summary;
  if (!body) return `codex:${row.thread_id}: no raw_memory or rollout_summary`;
  if (body.includes("\0")) return `codex:${row.thread_id}: binary content`;
  const id = `codex-${row.thread_id.slice(0, 8)}`;
  const name = heading(summary) || (row.rollout_slug ?? "").trim() || `Codex thread ${row.thread_id.slice(0, 8)}`;
  const description = raw ? parseMemoryFile(raw, id, "project").description.trim() : "";
  return {
    id,
    scope: "project",
    name,
    description: description || name,
    type: "project",
    body,
    origin: `codex:${row.thread_id}`,
    originHash: sha256(JSON.stringify([row.raw_memory ?? "", row.rollout_summary ?? "", row.rollout_slug ?? ""])),
    // Unix seconds in Codex's schema.
    ...(typeof row.source_updated_at === "number" && row.source_updated_at > 0
      ? { sourceUpdated: new Date(row.source_updated_at * 1000).toISOString() } : {}),
  };
}

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Codex's own memories of one project, read from every Codex home: the `stage1_outputs` rows
 * (v1 `memories_N.sqlite` and v2 `memories_v2_N.sqlite`, opened read-only) of the threads whose
 * exact cwd is the project, and its global `memory_summary.md` files as `codex-summary`.
 * A database that cannot be read sets `error`; it never throws.
 */
export async function importCodexMemories(projectPath: string, codexHomes?: string[]): Promise<CodexImportResult> {
  const homes = [...new Set((codexHomes ?? defaultCodexHomes()).map((h) => resolve(h)))];
  const canonical = (await realpath(resolve(projectPath)).catch(() => resolve(projectPath))).normalize("NFC");
  const project = canonical.replaceAll("\\", "/").replace(/\/+$/, "");

  const items: NativeMemory[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];
  const ids = new Set<string>();
  const summaries: Array<{ path: string; text: string }> = [];

  for (const home of homes) {
    let files: string[];
    try { files = await readdir(home); } catch { continue; }

    for (const dir of ["memories", "memories_v2"]) {
      const path = join(home, dir, "memory_summary.md");
      const text = await readFile(path, "utf8").catch(() => null);
      if (text === null) continue;
      const body = text.replace(/^﻿?v\d+[ \t]*\r?\n/, "").trim();
      if (body && !summaries.some((s) => s.text === body)) summaries.push({ path, text: body });
    }

    // v2 first, so a thread present in both is taken from the newer store.
    let memoryFiles = [latest(files, "memories_v2_"), latest(files, "memories_")].filter((f): f is string => !!f);
    const stateFile = latest(files, "state_");
    if (!memoryFiles.length) {
      // Older releases kept stage1_outputs in the state database itself.
      if (!stateFile) continue;
      try {
        const db = new Database(join(home, stateFile), { readonly: true });
        try { if (columnsOf(db, "stage1_outputs").size) memoryFiles = [stateFile]; } finally { db.close(); }
      } catch (err) { errors.push(`${join(home, stateFile)}: ${reason(err)}`); continue; }
      if (!memoryFiles.length) continue;
    }
    if (!stateFile) { errors.push(`${home}: no state_*.sqlite to match threads to projects`); continue; }

    let threads: string[];
    try { threads = projectThreads(join(home, stateFile), project); } catch (err) {
      errors.push(`${join(home, stateFile)}: ${reason(err)}`);
      continue;
    }
    for (const file of memoryFiles) {
      const path = join(home, file);
      try {
        // Opened even with no thread of this project, so a broken database is reported every sync.
        for (const row of stage1Rows(path, threads)) {
          const memory = toMemory(row);
          if (typeof memory === "string") { skipped.push(memory); continue; }
          if (ids.has(memory.id)) continue;
          ids.add(memory.id);
          items.push(memory);
        }
      } catch (err) {
        errors.push(`${path}: ${reason(err)}`);
      }
    }
  }

  if (summaries.length) {
    const body = summaries.map((s) => s.text).join("\n\n");
    items.push({
      id: "codex-summary",
      scope: "global",
      name: "Codex memory summary",
      description: heading(body) || body.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || "Codex memory summary",
      type: "project",
      body,
      origin: summaries.map((s) => s.path).join(", "),
      originHash: sha256(body),
    });
  }

  return errors.length ? { items, skipped, error: errors.join("; ") } : { items, skipped };
}
