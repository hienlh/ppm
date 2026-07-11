import { getDb } from "../db.service.ts";
import type { PpmTheme } from "../../web/theme/types.ts";

/** SQLite persistence for imported themes (stored as PpmTheme JSON). */

interface ThemeRow {
  id: string;
  name: string;
  mode: string;
  source: string | null;
  data_json: string;
  created_at: number;
  updated_at: number;
}

function rowToTheme(row: ThemeRow): PpmTheme | null {
  try {
    return JSON.parse(row.data_json) as PpmTheme;
  } catch {
    return null;
  }
}

export function listThemes(): PpmTheme[] {
  const rows = getDb().query("SELECT * FROM themes ORDER BY created_at ASC").all() as ThemeRow[];
  return rows.map(rowToTheme).filter((t): t is PpmTheme => t !== null);
}

export function insertTheme(theme: PpmTheme, source: string): PpmTheme {
  const now = Date.now();
  getDb()
    .query(
      "INSERT INTO themes (id, name, mode, source, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(theme.id, theme.name, theme.mode, source, JSON.stringify(theme), now, now);
  return theme;
}

/** Delete an imported theme. Returns true if a row was removed. */
export function deleteTheme(id: string): boolean {
  const res = getDb().query("DELETE FROM themes WHERE id = ?").run(id);
  return res.changes > 0;
}

/** Rename an imported theme; returns the updated theme or null if not found. */
export function renameTheme(id: string, name: string): PpmTheme | null {
  const row = getDb().query("SELECT * FROM themes WHERE id = ?").get(id) as ThemeRow | null;
  if (!row) return null;
  const theme = rowToTheme(row);
  if (!theme) return null;
  theme.name = name;
  getDb()
    .query("UPDATE themes SET name = ?, data_json = ?, updated_at = ? WHERE id = ?")
    .run(name, JSON.stringify(theme), Date.now(), id);
  return theme;
}
