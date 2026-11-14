/**
 * Widen an `IN (...)` CHECK on one column of a table, by SQLite's own recipe for changing a
 * constraint: copy into a new table, drop the old one, rename the new one into its place.
 *
 * Foreign keys go off first, and *outside* the transaction because the pragma is a no-op inside
 * one: with them on, dropping the old table deletes every row that references it through an
 * `ON DELETE CASCADE` before the new table exists. The table's own recorded SQL is reused with
 * only the CHECK replaced, so a column added by a later migration — or by a build that ran
 * before this one — is carried over rather than dropped, and ids are copied as they are, so
 * every referencing row still points at its parent. The AUTOINCREMENT high-water mark is kept
 * too: an id a deleted row had is never handed out again, which matters to rows elsewhere that
 * still name it. The table's indexes and triggers are read before the drop and recreated after.
 */
import type { Database } from "bun:sqlite";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The values an `IN (...)` CHECK on `column` admits, or null when the SQL has no such CHECK. */
function checkedValues(sql: string, check: RegExp): string[] | null {
  const match = sql.match(check);
  if (!match) return null;
  return [...match[1]!.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]!.replace(/''/g, "'"));
}

export function widenCheckConstraint(database: Database, table: string, column: string, values: readonly string[]): void {
  const foreignKeysOn = () => (database.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys === 1;
  const foreignKeys = foreignKeysOn();
  database.exec("PRAGMA foreign_keys = OFF");
  try {
    // Still on means a caller holds a transaction, where the drop below would cascade.
    if (foreignKeysOn()) throw new Error(`Cannot rebuild the ${table} table inside a transaction`);
    // IMMEDIATE: a second process migrating at the same moment waits, then finds the work done.
    database.transaction(() => {
      const row = database.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string } | null;
      if (!row) return;
      const check = new RegExp(`CHECK\\s*\\(\\s*${escapeRegExp(column)}\\s+IN\\s*\\(([^)]*)\\)\\s*\\)`, "i");
      const current = checkedValues(row.sql, check);
      // No constraint on the column, or one that already admits every value.
      if (!current || values.every((v) => current.includes(v))) return;
      const wanted = `CHECK(${column} IN (${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ")}))`;
      const tableName = new RegExp(`^CREATE TABLE\\s+(["\`]?)${escapeRegExp(table)}\\1`, "i");
      const createNew = row.sql.replace(check, wanted).replace(tableName, `CREATE TABLE ${table}_new`);
      if (!createNew.startsWith(`CREATE TABLE ${table}_new`)) throw new Error(`Unexpected definition of the ${table} table`);

      const dependents = database.query(
        "SELECT sql FROM sqlite_master WHERE type IN ('index', 'trigger') AND tbl_name = ? AND sql IS NOT NULL",
      ).all(table) as { sql: string }[];
      const seq = database.query("SELECT seq FROM sqlite_sequence WHERE name = ?").get(table) as { seq: number } | null;
      const before = (database.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      database.exec(`DROP TABLE IF EXISTS ${table}_new`);
      database.exec(createNew);
      database.exec(`INSERT INTO ${table}_new SELECT * FROM ${table}`);
      const after = (database.query(`SELECT COUNT(*) AS n FROM ${table}_new`).get() as { n: number }).n;
      if (after !== before) throw new Error(`Copied ${after} of ${before} ${table}`);
      database.exec(`DROP TABLE ${table}`);
      database.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);
      for (const d of dependents) database.exec(d.sql);
      if (seq) {
        // The copy restarted the counter at the highest id it copied.
        const copied = (database.query("SELECT seq FROM sqlite_sequence WHERE name = ?").get(table) as { seq: number } | null)?.seq ?? 0;
        database.query("DELETE FROM sqlite_sequence WHERE name = ?").run(table);
        database.query("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(table, Math.max(copied, seq.seq));
      }
    }).immediate();
  } finally {
    if (foreignKeys) database.exec("PRAGMA foreign_keys = ON");
  }
}
