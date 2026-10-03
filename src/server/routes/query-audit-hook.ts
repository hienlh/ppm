import type { Context } from "hono";
import {
  insertQueryLog,
  type QueryLogInput,
} from "../../services/query-audit/query-audit.service.ts";
import type { SqlDialect } from "../../services/database/dialect.ts";
import { postgresDialect } from "../../services/database/dialect-postgres.ts";

/** Everything the route knows; identity is filled in from the request. */
export type AuditFields = Omit<QueryLogInput, "actor" | "callerIp" | "callerUa">;

/** Who made a request, as an audit entry names them. */
export type AuditCaller = Pick<QueryLogInput, "actor" | "callerIp" | "callerUa">;

export function auditCaller(c: Context): AuditCaller {
  return {
    actor: c.req.header("x-ppm-client") === "web" ? "human" : "agent",
    callerIp: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    callerUa: c.req.header("user-agent") ?? null,
  };
}

/**
 * Record one audited statement for a caller read off its request earlier — an export is logged
 * once its download ends, long after the request that started it was answered. Never throws.
 */
export function logQueryAs(caller: AuditCaller, fields: AuditFields): string | null {
  try {
    insertQueryLog({ ...fields, ...caller });
    return null;
  } catch (e) {
    const message = (e as Error).message;
    console.error("[query-audit] failed to log query:", message);
    return message;
  }
}

/**
 * Record one audited statement. Never throws: a broken audit log must not break
 * the user's query. Failures are reported back through a response header so the
 * client can warn instead of the audit dying silently.
 */
export function logQuery(c: Context, fields: AuditFields): void {
  const failed = logQueryAs(auditCaller(c), fields);
  if (failed !== null) c.header("x-ppm-audit-error", failed.slice(0, 200).replace(/[\r\n]+/g, " "));
}

/**
 * Wrap a SQL identifier the way the connection's dialect does, so logged SQL
 * matches what ran. Postgres and SQLite share `"…"`; MySQL passes its own.
 */
export function quoteIdent(name: string, dialect: SqlDialect = postgresDialect): string {
  return dialect.quoteIdent(name);
}

/**
 * Render a value for display in logged SQL. Never used to execute anything —
 * the real statement is parameterized, so this is a readable approximation.
 * Objects are JSON-rendered because String() would flatten them to
 * "[object Object]" and hide what was actually written.
 */
export function literal(value: unknown, dialect: SqlDialect = postgresDialect): string {
  return dialect.literal(value);
}
