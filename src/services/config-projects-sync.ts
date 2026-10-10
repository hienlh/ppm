import type { Database } from "bun:sqlite";
import type { ProjectConfig } from "../types/config.ts";

/**
 * The projects table is shared by every process that opens the database — the server, and any
 * `ppm projects …` run beside it (the PPM Assistant runs one from its shell). Each process holds
 * its own copy of the list, so writing that copy back as the whole table deletes whatever another
 * process added since it was read, and puts back what it removed. Rewriting the table also gave
 * every project a new row id, which cascaded away its `jira_config` and dropped its per-project
 * `settings` and `default_tag_id` on every config save.
 *
 * So a write applies only what *this* process changed — measured against `base`, the list as it
 * last read or wrote it — to the table as it stands, inside one write transaction, and the caller
 * adopts the result. Rows are matched by path; a project whose path changed is matched by name
 * to the row it moved from, so it keeps its id.
 */

export interface StoredProjectRow {
  path: string;
  name: string;
  color: string | null;
}

/** What one write left in the table, and the data version it corresponds to. */
export interface ProjectsWriteResult {
  rows: StoredProjectRow[];
  dataVersion: number;
}

export function readProjectRows(db: Database): StoredProjectRow[] {
  return db.query("SELECT path, name, color FROM projects ORDER BY sort_order, id").all() as StoredProjectRow[];
}

/**
 * SQLite's counter of commits made by *other* connections to this database file. A change means
 * another process (or another connection here) wrote; this connection's own writes leave it as is.
 */
export function readDataVersion(db: Database): number {
  return (db.query("PRAGMA data_version").get() as { data_version: number }).data_version;
}

/**
 * Turn stored rows into the in-memory shape. `image` is not stored in the table, so it is carried
 * over by path from the lists given: the first list that has the path decides, so a list that
 * dropped an avatar is not overruled by an older one that still had it.
 */
export function rowsToProjects(rows: StoredProjectRow[], carryFrom: ProjectConfig[][]): ProjectConfig[] {
  const images = new Map<string, string | undefined>();
  for (const list of carryFrom) {
    for (const p of list) if (!images.has(p.path)) images.set(p.path, p.image);
  }
  return rows.map((r) => {
    const image = images.get(r.path);
    return {
      path: r.path,
      name: r.name,
      ...(r.color ? { color: r.color } : {}),
      ...(image ? { image } : {}),
    };
  });
}

const sameStored = (a: ProjectConfig, b: ProjectConfig): boolean =>
  a.path === b.path && a.name === b.name && (a.color ?? null) === (b.color ?? null);

/**
 * Apply the difference between `base` and `mine` to the table. `base` null means this process
 * never read the table, so `mine` is taken as the whole intended list.
 */
export function writeProjectChanges(db: Database, base: ProjectConfig[] | null, mine: ProjectConfig[]): ProjectsWriteResult {
  // IMMEDIATE takes the write lock before the table is read, so no other process can commit
  // between reading what is there and writing on top of it.
  db.exec("BEGIN IMMEDIATE");
  try {
    // Read under the lock: nothing can commit before this transaction ends, so the version read
    // here is exactly the state the result describes.
    const dataVersion = readDataVersion(db);
    const before = base ?? rowsToProjects(readProjectRows(db), []);
    const minePaths = new Set(mine.map((p) => p.path));

    // Which row each entry of `mine` came from (by its path in `base`), if any.
    const origin = new Map<ProjectConfig, ProjectConfig>();
    const claimed = new Set<string>();
    const beforeByPath = new Map(before.map((p) => [p.path, p]));
    for (const m of mine) {
      const b = beforeByPath.get(m.path);
      if (b) { origin.set(m, b); claimed.add(b.path); }
    }
    for (const m of mine) {
      if (origin.has(m)) continue;
      // A path change keeps its name (renaming and moving at once is not offered anywhere).
      const moved = before.find((b) => b.name === m.name && !claimed.has(b.path) && !minePaths.has(b.path));
      if (moved) { origin.set(m, moved); claimed.add(moved.path); }
    }

    const remove = db.query("DELETE FROM projects WHERE path = ?");
    for (const b of before) if (!claimed.has(b.path)) remove.run(b.path);

    const nextOrder = () => (db.query("SELECT COALESCE(MAX(sort_order), -1) AS m FROM projects").get() as { m: number }).m + 1;
    const upsert = db.query(
      "INSERT INTO projects (path, name, color, sort_order) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(path) DO UPDATE SET name = excluded.name, color = excluded.color",
    );
    const move = db.query("UPDATE projects SET path = ?, name = ?, color = ? WHERE path = ?");
    for (const m of mine) {
      const b = origin.get(m);
      // Untouched here: whatever the table holds for it now stands, including an edit or a
      // removal another process made.
      if (b && sameStored(b, m)) continue;
      if (b && b.path !== m.path) {
        const moved = move.run(m.path, m.name, m.color ?? null, b.path) as { changes: number };
        if (moved.changes > 0) continue;
      }
      upsert.run(m.path, m.name, m.color ?? null, nextOrder());
    }

    // A reorder made here is applied in full; additions from elsewhere follow it. Without one,
    // the table's order stands and additions made here were appended above.
    const beforeOrder = before.filter((b) => claimed.has(b.path)).map((b) => b.path);
    const mineOrder = mine.filter((m) => origin.has(m)).map((m) => origin.get(m)!.path);
    if (beforeOrder.join("\0") !== mineOrder.join("\0")) {
      const current = readProjectRows(db).map((r) => r.path);
      const order = [...mine.map((m) => m.path), ...current.filter((p) => !minePaths.has(p))];
      const setOrder = db.query("UPDATE projects SET sort_order = ? WHERE path = ?");
      order.forEach((path, i) => setOrder.run(i, path));
    }

    const rows = readProjectRows(db);
    db.exec("COMMIT");
    return { rows, dataVersion };
  } catch (e) {
    // SQLite may already have rolled back (a full disk does); a second ROLLBACK would throw and
    // hide the error that matters.
    if (db.inTransaction) db.exec("ROLLBACK");
    throw e;
  }
}
