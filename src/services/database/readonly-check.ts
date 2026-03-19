/**
 * Returns true if sql is a read-only statement.
 * Handles: SELECT, EXPLAIN, SHOW, PRAGMA, DESCRIBE, WITH...SELECT.
 * Guards against CTEs with write keywords (e.g. WITH x AS (DELETE...) SELECT).
 */
export function isReadOnlyQuery(sql: string): boolean {
  const trimmed = sql.trim();

  // Reject if the SQL contains write keywords anywhere (catches CTE attacks like
  // "WITH x AS (DELETE ...) SELECT ...").
  if (/\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|REPLACE|MERGE)\b/i.test(trimmed)) {
    return false;
  }

  // Confirm it starts with a known read-only keyword.
  return /^\s*(SELECT|EXPLAIN|SHOW|PRAGMA|DESCRIBE|WITH\b)/i.test(trimmed);
}
