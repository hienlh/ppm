/**
 * ATTACH is a file-open primitive dressed as SQL: `ATTACH DATABASE '<path>' AS
 * p` binds any file on disk to the open connection (and creates it when
 * missing), and because connections are cached the attached schema survives
 * into later requests. Every path guard on the viewer routes is meaningless
 * while a statement can open a second database, so the arbitrary-SQL door
 * rejects ATTACH and DETACH outright.
 */

const ATTACH_KEYWORDS = /\b(?:ATTACH|DETACH)\b/i;

/**
 * Strip comments and string/identifier literals so the keyword scan cannot be
 * fooled by `SELECT 'attach'` and cannot miss `/*x* / ATTACH`. Literals are
 * replaced with a space to keep neighbouring tokens apart.
 */
export function stripSqlNoise(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
    } else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += " ";
    } else if (c === "'" || c === '"' || c === "`" || c === "[") {
      const closer = c === "[" ? "]" : c;
      i++;
      while (i < sql.length) {
        if (sql[i] === closer) {
          // A doubled quote is an escaped quote, not the end of the literal.
          if (sql[i + 1] === closer && closer !== "]") i += 2;
          else break;
        } else i++;
      }
      i++;
      out += " ";
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** True when the statement text contains an ATTACH/DETACH keyword. */
export function hasAttachStatement(sql: string): boolean {
  return ATTACH_KEYWORDS.test(stripSqlNoise(sql));
}

/** Reject ATTACH/DETACH before the statement reaches the database. */
export function assertNoAttachStatement(sql: string): void {
  if (hasAttachStatement(sql)) {
    throw Object.assign(new Error("ATTACH and DETACH are not allowed"), {
      status: 400,
      code: "EINVAL",
    });
  }
}
