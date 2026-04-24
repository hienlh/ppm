/**
 * Split a SQL script into individual statements, respecting:
 * - Single-quoted strings ('hello; world')
 * - Double-quoted identifiers ("my;table")
 * - Dollar-quoted strings ($$...$$, $tag$...$tag$)
 * - Single-line comments (-- ...)
 * - Multi-line comments (/* ... *​/)
 *
 * Returns non-empty trimmed statements without trailing semicolons.
 */
export function splitSqlStatements(script: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;
  const len = script.length;

  while (i < len) {
    const ch = script[i]!;

    // Single-line comment
    if (ch === "-" && script[i + 1] === "-") {
      const end = script.indexOf("\n", i);
      const lineEnd = end === -1 ? len : end + 1;
      current += script.slice(i, lineEnd);
      i = lineEnd;
      continue;
    }

    // Multi-line comment
    if (ch === "/" && script[i + 1] === "*") {
      const end = script.indexOf("*/", i + 2);
      const blockEnd = end === -1 ? len : end + 2;
      current += script.slice(i, blockEnd);
      i = blockEnd;
      continue;
    }

    // Single-quoted string
    if (ch === "'") {
      let j = i + 1;
      while (j < len) {
        if (script[j] === "'" && script[j + 1] === "'") { j += 2; continue; }
        if (script[j] === "'") { j++; break; }
        j++;
      }
      current += script.slice(i, j);
      i = j;
      continue;
    }

    // Double-quoted identifier
    if (ch === '"') {
      let j = i + 1;
      while (j < len) {
        if (script[j] === '"' && script[j + 1] === '"') { j += 2; continue; }
        if (script[j] === '"') { j++; break; }
        j++;
      }
      current += script.slice(i, j);
      i = j;
      continue;
    }

    // Dollar-quoted string (PostgreSQL): $$...$$ or $tag$...$tag$
    if (ch === "$") {
      const tagMatch = script.slice(i).match(/^(\$[A-Za-z0-9_]*\$)/);
      if (tagMatch) {
        const tag = tagMatch[1]!;
        const endIdx = script.indexOf(tag, i + tag.length);
        const blockEnd = endIdx === -1 ? len : endIdx + tag.length;
        current += script.slice(i, blockEnd);
        i = blockEnd;
        continue;
      }
    }

    // Statement separator
    if (ch === ";") {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = "";
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  // Last statement (no trailing semicolon)
  const trimmed = current.trim();
  if (trimmed) statements.push(trimmed);

  return statements;
}
