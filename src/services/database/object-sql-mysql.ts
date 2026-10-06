/**
 * The CREATE statement of one MySQL or MariaDB object, for the SQL tab. The server prints every
 * one of them itself (`SHOW CREATE …`), so nothing is rebuilt here: the only additions are the
 * statement's terminator and, for a routine or trigger whose body holds `;`, the `DELIMITER` lines
 * the script needs to be run again as one statement.
 */
import type { DbObjectRef } from "../../shared/db-structure.ts";
import type { MysqlRead } from "./analyser-mysql.ts";
import { mysqlDialect } from "./dialect-mysql.ts";

/** The `SHOW CREATE` statement for a kind, and the column of its answer holding the text. */
const SHOW: Record<DbObjectRef["kind"], { what: string; column: string } | null> = {
  table: { what: "TABLE", column: "Create Table" },
  view: { what: "VIEW", column: "Create View" },
  function: { what: "FUNCTION", column: "Create Function" },
  procedure: { what: "PROCEDURE", column: "Create Procedure" },
  trigger: { what: "TRIGGER", column: "SQL Original Statement" },
  // A MariaDB sequence is a table, and prints as one.
  sequence: { what: "SEQUENCE", column: "Create Table" },
  matview: null,
};

/** The server's "no such object" errors: a table or view, a routine, a trigger. */
const NOT_FOUND = new Set([1146, 1305, 1360, 1049]);

/**
 * `read` must send the statement as a plain query: `SHOW CREATE TRIGGER` and its kin are not in
 * every server's list of statements that can be prepared.
 */
export async function mysqlObjectSql(read: MysqlRead, database: string | null, obj: DbObjectRef): Promise<string | null> {
  const show = SHOW[obj.kind];
  if (!show) return null;
  const schema = obj.schema ?? database;
  const target = schema ? mysqlDialect.qualify(obj.name, schema) : mysqlDialect.quoteIdent(obj.name);
  let rows: Record<string, unknown>[];
  try {
    rows = await read(`SHOW CREATE ${show.what} ${target}`);
  } catch (e) {
    if (NOT_FOUND.has(Number((e as { errno?: number }).errno))) return null;
    throw e;
  }
  const row = rows[0];
  if (!row) return null;
  // SHOW CREATE TABLE answers a view with a view's columns.
  const text = row[show.column] ?? row["Create View"];
  if (text == null) {
    throw new Error(`The server did not return the definition of ${obj.name}; the login may lack the privilege to read it`);
  }
  // MySQL keeps a routine's body as it was sent, so it can end in the `;` that closed it.
  const statement = String(text instanceof Uint8Array ? Buffer.from(text).toString("utf8") : text).replace(/[\s;]+$/, "");
  const routine = obj.kind === "function" || obj.kind === "procedure" || obj.kind === "trigger";
  return routine && statement.includes(";") ? `DELIMITER ;;\n${statement};;\nDELIMITER ;` : `${statement};`;
}
