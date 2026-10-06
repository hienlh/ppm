/**
 * Running a SQLite DDL plan: the statements before the transaction, the transaction, then the
 * ones after it — those whether or not it committed, since they undo what the first ones did to
 * the connection (`PRAGMA foreign_keys`). A failure rolls everything back, so nothing of the
 * script stays applied.
 *
 * The two checks a rebuild asks for fail it only over a problem it made. A database may already
 * hold a broken view or an orphaned row — SQLite enforces no foreign keys unless each connection
 * asks it to, so other programs leave them behind — and refusing to change a table over that would
 * make it uneditable here. Both are measured before the first statement and compared after.
 */
import type { Database } from "bun:sqlite";
import { sqliteDialect } from "../dialect-sqlite.ts";
import { DdlApplyError, type DdlPlan, type DdlStatement } from "./ddl-types.ts";

const q = sqliteDialect.quoteIdent;
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** `PRAGMA foreign_key_check`'s rows, counted per child table and parent. */
function orphanCounts(db: Database): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of db.query("PRAGMA foreign_key_check").all() as { table: string; parent: string }[]) {
    const key = JSON.stringify([row.table, row.parent]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

interface CompileProblem {
  label: string;
  error: string;
}

/**
 * What does not compile among the views and triggers, by the statement that compiles it.
 * Preparing a statement compiles the triggers it would fire without firing them, so each table
 * with triggers is prepared an INSERT, an UPDATE of every column and a DELETE.
 */
function compileProblems(db: Database): Map<string, CompileProblem> {
  const problems = new Map<string, CompileProblem>();
  const probe = (sql: string, label: string) => {
    try {
      db.prepare(sql).finalize();
    } catch (e) {
      problems.set(sql, { label, error: messageOf(e) });
    }
  };
  for (const { name } of db.query("SELECT name FROM sqlite_schema WHERE type = 'view'").all() as { name: string }[]) {
    probe(`SELECT * FROM ${q(name)} LIMIT 0`, `The view ${name}`);
  }
  for (const { name } of db.query("SELECT DISTINCT tbl_name AS name FROM sqlite_schema WHERE type = 'trigger'").all() as { name: string }[]) {
    const label = `A trigger on ${name}`;
    probe(`INSERT INTO ${q(name)} DEFAULT VALUES`, label);
    probe(`DELETE FROM ${q(name)}`, label);
    // Generated columns (hidden 2 and 3) cannot be assigned.
    const columns = (db.query("SELECT name FROM pragma_table_xinfo(?) WHERE hidden = 0").all(name) as { name: string }[]).map((c) => q(c.name));
    if (columns.length > 0) probe(`UPDATE ${q(name)} SET ${columns.map((c) => `${c} = ${c}`).join(", ")}`, label);
  }
  return problems;
}

interface Baseline {
  orphans: Map<string, number>;
  problems: Map<string, CompileProblem>;
}

function check(db: Database, s: DdlStatement, baseline: Baseline): void {
  if (s.check === "foreign-keys") {
    const found: string[] = [];
    for (const [key, count] of orphanCounts(db)) {
      const extra = count - (baseline.orphans.get(key) ?? 0);
      if (extra <= 0) continue;
      const [child, parent] = JSON.parse(key) as [string, string];
      found.push(`${extra} ${extra === 1 ? "row" : "rows"} of ${child} would point at no row of ${parent}`);
    }
    if (found.length > 0) throw new Error(`Rebuilding ${s.table ?? "the table"} breaks foreign keys: ${found.join("; ")}`);
  } else if (s.check === "schema") {
    for (const [sql, problem] of compileProblems(db)) {
      if (baseline.problems.get(sql)?.error === problem.error) continue;
      throw new Error(`${problem.label} would no longer work: ${problem.error}`);
    }
  }
}

export function applySqlitePlan(db: Database, plan: DdlPlan): void {
  const at = (s: DdlStatement) => plan.statements.indexOf(s);
  const run = (s: DdlStatement, body: () => void) => {
    try {
      body();
    } catch (e) {
      throw new DdlApplyError(messageOf(e), s.sql, at(s), 0, e);
    }
  };
  const legacy = (db.query("PRAGMA legacy_alter_table").get() as { legacy_alter_table: number }).legacy_alter_table;
  const main = plan.statements.filter((s) => !s.phase);
  try {
    for (const s of plan.statements) if (s.phase === "before") run(s, () => db.exec(s.sql));
    db.exec("BEGIN IMMEDIATE");
    try {
      const baseline: Baseline | null = main.some((s) => s.check) ? { orphans: orphanCounts(db), problems: compileProblems(db) } : null;
      for (const s of main) run(s, () => (s.check ? check(db, s, baseline!) : db.exec(s.sql)));
      run({ sql: "COMMIT" }, () => db.exec("COMMIT"));
    } catch (e) {
      if (db.inTransaction) db.exec("ROLLBACK");
      throw e;
    }
  } finally {
    // A rollback undoes the schema, not what the script set on the connection.
    db.exec(`PRAGMA legacy_alter_table = ${legacy ? "ON" : "OFF"}`);
    for (const s of plan.statements) if (s.phase === "after") db.exec(s.sql);
  }
}
