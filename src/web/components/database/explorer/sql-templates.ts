/**
 * The SQL the Database sidebar puts in a new query tab: a table's first SELECT, a routine called
 * once, and the + menu's CREATE templates. The tab opens with the text in its editor and runs
 * nothing — a template is there to be edited first.
 *
 * Written for each engine's own syntax; none of it is DBGate's text.
 */
import { dialectNameOf, type DbType } from "../../../../shared/db-types";
import { quoteIdentifier } from "../../../../shared/sql-identifiers";
import type { DbObject } from "../../../../shared/db-structure";

/**
 * The name to write in a query. A Postgres object carries its schema, which the query names so
 * it reads the same whatever the search path; a MySQL object's schema is the database the tab
 * already runs in, and SQLite has none.
 */
export function qualifiedName(o: Pick<DbObject, "schema" | "name">, type: DbType): string {
  const dialect = dialectNameOf(type);
  const name = quoteIdentifier(o.name, dialect);
  return dialect === "postgres" && o.schema ? `${quoteIdentifier(o.schema, dialect)}.${name}` : name;
}

export function selectTemplate(o: Pick<DbObject, "schema" | "name">, type: DbType): string {
  return `SELECT * FROM ${qualifiedName(o, type)} LIMIT 100`;
}

/** A routine called once, its arguments left for the user to fill in; null for a kind that cannot be called. */
export function callTemplate(o: Pick<DbObject, "schema" | "name" | "kind" | "args">, type: DbType): string | null {
  const args = o.args?.trim() ? `/* ${o.args.trim()} */` : "";
  if (o.kind === "function") return `SELECT ${qualifiedName(o, type)}(${args})`;
  if (o.kind === "procedure") return `CALL ${qualifiedName(o, type)}(${args})`;
  return null;
}

/** The kind of routine the + menu offers a template for: Postgres writes functions, MySQL procedures, SQLite neither. */
export function routineTemplateKind(type: DbType): "function" | "procedure" | null {
  const dialect = dialectNameOf(type);
  return dialect === "postgres" ? "function" : dialect === "mysql" ? "procedure" : null;
}

export function createViewTemplate(type: DbType): string {
  const q = (n: string) => quoteIdentifier(n, dialectNameOf(type));
  return `CREATE VIEW ${q("view_name")} AS\nSELECT\n  *\nFROM\n  ${q("table_name")};\n`;
}

export function createRoutineTemplate(type: DbType): string | null {
  const kind = routineTemplateKind(type);
  if (kind === "function") {
    return [
      "CREATE OR REPLACE FUNCTION function_name(arg integer)",
      "RETURNS integer",
      "LANGUAGE sql",
      "AS $$",
      "  SELECT arg + 1;",
      "$$;",
      "",
    ].join("\n");
  }
  if (kind === "procedure") {
    // DELIMITER lets the body's own semicolons through; the statement splitter understands it.
    return [
      "DELIMITER //",
      "CREATE PROCEDURE procedure_name(IN arg INT)",
      "BEGIN",
      "  SELECT arg + 1;",
      "END //",
      "DELIMITER ;",
      "",
    ].join("\n");
  }
  return null;
}

export function createTriggerTemplate(type: DbType): string {
  const dialect = dialectNameOf(type);
  if (dialect === "postgres") {
    return [
      "CREATE OR REPLACE FUNCTION trigger_function_name()",
      "RETURNS trigger",
      "LANGUAGE plpgsql",
      "AS $$",
      "BEGIN",
      "  RETURN NEW;",
      "END;",
      "$$;",
      "",
      "CREATE TRIGGER trigger_name",
      "BEFORE INSERT ON table_name",
      "FOR EACH ROW EXECUTE FUNCTION trigger_function_name();",
      "",
    ].join("\n");
  }
  if (dialect === "mysql") {
    return [
      "CREATE TRIGGER trigger_name",
      "BEFORE INSERT ON table_name",
      "FOR EACH ROW",
      "SET NEW.column_name = NEW.column_name;",
      "",
    ].join("\n");
  }
  return [
    "CREATE TRIGGER trigger_name",
    "AFTER INSERT ON table_name",
    "BEGIN",
    "  SELECT NEW.rowid;",
    "END;",
    "",
  ].join("\n");
}
