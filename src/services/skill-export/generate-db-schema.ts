// Runtime: read the user's PPM SQLite config DB (readonly) and render a markdown schema doc.
// Never opens the DB read-write. Gracefully handles missing DB.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import { getPpmDir } from "../ppm-dir.ts";

interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface TableRow {
  name: string;
}

export function generateDbSchemaMarkdown(dbPath?: string): string {
  const path = dbPath ?? resolve(getPpmDir(), "ppm.db");
  const header = "# PPM Database Schema\n\n_Auto-generated at install time from your local config DB._\n";

  if (!existsSync(path)) {
    return `${header}\n_Database not found at \`${path}\`. Run \`ppm init\` to create it._\n`;
  }

  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    const tables = db
      .query<TableRow, []>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all();

    if (tables.length === 0) {
      return `${header}\n_No tables found in \`${path}\`._\n`;
    }

    const parts: string[] = [header, ""];
    parts.push(`Source: \`${path}\``);
    parts.push("");

    for (const t of tables) {
      parts.push(`## ${t.name}`);
      parts.push("");
      const cols = db.query<ColumnInfo, []>(`PRAGMA table_info("${t.name}")`).all();
      parts.push("| Column | Type | Nullable | PK | Default |");
      parts.push("|---|---|---|---|---|");
      for (const c of cols) {
        const nullable = c.notnull === 0 ? "yes" : "no";
        const pk = c.pk > 0 ? "yes" : "";
        const def = c.dflt_value !== null ? `\`${c.dflt_value}\`` : "";
        parts.push(`| \`${c.name}\` | \`${c.type || "—"}\` | ${nullable} | ${pk} | ${def} |`);
      }
      parts.push("");
    }

    return parts.join("\n") + "\n";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `${header}\n_Failed to read database at \`${path}\`: ${msg}_\n`;
  } finally {
    db?.close();
  }
}
