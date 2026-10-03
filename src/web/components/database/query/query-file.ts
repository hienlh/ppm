/**
 * A Query tab saved to a `.sql` file, DBGate's Save: the first save asks where, the tab then keeps
 * the file, and every later Ctrl+S writes the tab's SQL there with no question. The tab is named
 * after the file, as DBGate names it. What is pure about that lives here.
 */
import { fileDisplayName } from "@/lib/db-tabs";

/** The file a tab was saved to, when it was. */
export function savedFileOf(metadata: Record<string, unknown> | undefined): string | null {
  const path = metadata?.savedPath;
  return typeof path === "string" && path !== "" ? path : null;
}

/** What Save asks to name a tab's first file: its title as a file name. */
export function defaultQueryFileName(title: string): string {
  const stem = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  return `${stem || "query"}.sql`;
}

/** `path`, with `.sql` added when its name has no extension of its own — a dot in a folder's name is not one. */
export function withSqlExtension(path: string): string {
  return /\.[^./\\]+$/.test(path) ? path : `${path}.sql`;
}

/** The tab's title once saved: the file's name, without `.sql`. */
export function queryFileTitle(path: string): string {
  const name = fileDisplayName(path);
  return name.replace(/\.sql$/i, "") || name;
}

/**
 * A tab once its SQL is written to `path`: named after the file, and clean while its SQL is what
 * was written — SQL typed while the file was being written leaves it dirty.
 */
export function savedQueryTab(
  metadata: Record<string, unknown> | undefined, path: string, sql: string,
): { title: string; metadata: Record<string, unknown> } {
  return { title: queryFileTitle(path), metadata: { ...metadata, savedPath: path, openedSql: sql } };
}

/** The folder a path is in, and the file's name there. */
export function splitFilePath(path: string): { dir: string; name: string } {
  const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (at < 0) return { dir: "", name: path };
  // A file at a root keeps the root's separator: `/a.sql` is in `/`, `C:\a.sql` in `C:\`.
  return { dir: at === 0 || path[at - 1] === ":" ? path.slice(0, at + 1) : path.slice(0, at), name: path.slice(at + 1) };
}

/**
 * A file named `name` is among `entries` — compared without case, since on Windows and macOS
 * `Report.sql` and `report.sql` are one file, and asking once too often costs a click.
 */
export function hasFileNamed(entries: readonly { name: string; type: string }[], name: string): boolean {
  const wanted = name.toLowerCase();
  return entries.some((e) => e.type !== "directory" && e.name.toLowerCase() === wanted);
}
