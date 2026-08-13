import type { Context } from "hono";
import {
  insertQueryLog,
  type QueryLogInput,
} from "../../services/query-audit/query-audit.service.ts";

/** Everything the route knows; identity is filled in from the request. */
export type AuditFields = Omit<QueryLogInput, "actor" | "callerIp" | "callerUa">;

/**
 * Record one audited statement. Never throws: a broken audit log must not break
 * the user's query. Failures are reported back through a response header so the
 * client can warn instead of the audit dying silently.
 */
export function logQuery(c: Context, fields: AuditFields): void {
  try {
    insertQueryLog({
      ...fields,
      actor: c.req.header("x-ppm-client") === "web" ? "human" : "agent",
      callerIp: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      callerUa: c.req.header("user-agent") ?? null,
    });
  } catch (e) {
    const message = (e as Error).message;
    console.error("[query-audit] failed to log query:", message);
    c.header("x-ppm-audit-error", message.slice(0, 200).replace(/[\r\n]+/g, " "));
  }
}

/** Wrap a SQL identifier the same way the db services do, so logged SQL matches what ran. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Render a value for display in logged SQL. Never used to execute anything —
 * the real statement is parameterized, so this is a readable approximation.
 * Objects are JSON-rendered because String() would flatten them to
 * "[object Object]" and hide what was actually written.
 */
export function literal(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    try { return `'${JSON.stringify(value)?.replace(/'/g, "''")}'`; } catch { /* fall through */ }
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Keep a reconstructed IN(...) list readable when a bulk action covers thousands of rows. */
export function literalList(values: unknown[], maxShown = 20): string {
  if (values.length <= maxShown) return values.map(literal).join(", ");
  return `${values.slice(0, maxShown).map(literal).join(", ")} /* +${values.length - maxShown} more */`;
}

export function qualifiedTable(table: string, schema?: string | null): string {
  return schema ? `${quoteIdent(schema)}.${quoteIdent(table)}` : quoteIdent(table);
}
