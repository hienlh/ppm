import type * as MonacoType from "monaco-editor";
import { getStatementAtCursor } from "../../../shared/split-sql-statements";
import type { DialectName } from "../../../shared/db-types";
import { quoteIdentifier } from "../../../shared/sql-identifiers";

export interface SchemaInfo {
  tables: { name: string; schema: string }[];
  getColumns: (table: string, schema?: string) => Promise<{ name: string; type: string }[]>;
}

/** Keywords every engine PPM opens has. */
export const SQL_KEYWORDS = [
  "SELECT", "FROM", "WHERE", "INSERT", "INTO", "VALUES",
  "UPDATE", "SET", "DELETE", "CREATE", "TABLE", "ALTER",
  "DROP", "INDEX", "JOIN", "LEFT", "RIGHT", "INNER",
  "OUTER", "ON", "AND", "OR", "NOT", "NULL", "IS",
  "IN", "LIKE", "BETWEEN", "HAVING", "LIMIT", "OFFSET",
  "AS", "DISTINCT", "COUNT", "SUM", "AVG", "MIN", "MAX",
  "CASE", "WHEN", "THEN", "ELSE", "END", "EXISTS",
  "UNION", "ALL", "ASC", "DESC", "ORDER BY", "GROUP BY",
  "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "CROSS JOIN",
  "IS NULL", "IS NOT NULL",
];

/**
 * What one engine has and another does not, offered only in a tab on that engine: MySQL has no
 * FULL OUTER JOIN, RETURNING or ILIKE; Postgres and SQLite have no ON DUPLICATE KEY UPDATE.
 */
export const DIALECT_KEYWORDS: Record<DialectName, readonly string[]> = {
  postgres: [
    "FULL OUTER JOIN", "ILIKE", "SIMILAR TO", "IS DISTINCT FROM", "RETURNING", "ON CONFLICT", "DO NOTHING", "DO UPDATE SET",
    "DISTINCT ON", "LATERAL", "WITH RECURSIVE", "FILTER", "OVER", "PARTITION BY", "NULLS FIRST", "NULLS LAST",
    "FETCH FIRST", "ROWS ONLY", "TRUNCATE", "EXPLAIN ANALYZE", "VACUUM", "ANALYZE", "COPY", "SCHEMA", "SEQUENCE",
    "MATERIALIZED VIEW", "REFRESH MATERIALIZED VIEW", "SERIAL", "BIGSERIAL", "JSONB", "TIMESTAMPTZ",
    "GENERATED ALWAYS AS IDENTITY",
  ],
  mysql: [
    "AUTO_INCREMENT", "ON DUPLICATE KEY UPDATE", "INSERT IGNORE", "REPLACE INTO", "STRAIGHT_JOIN", "REGEXP", "RLIKE",
    "SHOW TABLES", "SHOW DATABASES", "SHOW COLUMNS FROM", "SHOW CREATE TABLE", "SHOW INDEX FROM", "SHOW PROCESSLIST",
    "SHOW VARIABLES", "DESCRIBE", "USE", "ENGINE", "CHARSET", "COLLATE", "UNSIGNED", "DELIMITER", "TRUNCATE",
    "LOCK TABLES", "UNLOCK TABLES",
  ],
  sqlite: [
    "FULL OUTER JOIN", "PRAGMA", "AUTOINCREMENT", "GLOB", "WITHOUT ROWID", "STRICT", "INSERT OR REPLACE", "INSERT OR IGNORE",
    "ON CONFLICT", "DO NOTHING", "DO UPDATE SET", "RETURNING", "WITH RECURSIVE", "ATTACH DATABASE", "DETACH DATABASE",
    "VACUUM", "REINDEX", "ANALYZE", "ROWID",
  ],
};

/** The keywords a tab on `dialect` is offered. */
export function sqlKeywords(dialect: DialectName): string[] {
  return [...SQL_KEYWORDS, ...DIALECT_KEYWORDS[dialect]];
}

export const AGGREGATE_FNS = ["COUNT", "SUM", "AVG", "MIN", "MAX"];
/** Comparisons every engine has. */
export const OPERATORS = ["=", "!=", "<>", ">", "<", ">=", "<=", "LIKE", "IN", "NOT IN", "BETWEEN", "IS NULL", "IS NOT NULL"];
const DIALECT_OPERATORS: Record<DialectName, readonly string[]> = {
  postgres: ["ILIKE", "NOT ILIKE", "SIMILAR TO", "IS DISTINCT FROM"],
  mysql: ["REGEXP", "NOT REGEXP", "<=>"],
  sqlite: ["GLOB", "IS", "IS NOT"],
};

/** The comparisons offered after `WHERE col` in a tab on `dialect`. */
export function sqlOperators(dialect: DialectName): string[] {
  return [...OPERATORS, ...DIALECT_OPERATORS[dialect]];
}
export const SORT_DIRS = ["ASC", "DESC"];

/**
 * Columns already fetched, per schema: two open tabs can each have a `users` table, and a cache
 * keyed by the name alone handed one connection's columns to the other.
 */
const columnCaches = new WeakMap<SchemaInfo, Map<string, { name: string; type: string }[]>>();

/** Words that follow a table and are not its alias. */
const NOT_ALIAS = [
  "FROM", "JOIN", "UPDATE", "INTO", "WHERE", "SET", "ON", "USING", "ORDER", "GROUP", "HAVING", "LIMIT", "OFFSET",
  "LEFT", "RIGHT", "INNER", "OUTER", "CROSS", "FULL", "NATURAL", "STRAIGHT_JOIN", "AND", "OR", "VALUES", "SELECT",
  "DELETE", "INSERT", "CREATE", "ALTER", "DROP", "UNION", "EXCEPT", "INTERSECT", "RETURNING", "WINDOW", "FETCH", "FOR",
  "DEFAULT", "LATERAL",
  // MySQL's index hints: FROM t FORCE INDEX (...).
  "FORCE", "IGNORE", "USE",
];
const NOT_ALIAS_SET = new Set(NOT_ALIAS);
/** A name as written: plain, "double-quoted" (Postgres, SQLite) or `backticked` (MySQL). */
const NAME = String.raw`(?:"[^"]+"|\x60[^\x60]+\x60|\w+)`;
/** One table after FROM, JOIN, UPDATE or INTO — `schema.table` too — and its alias, with or without AS. */
const TABLE_ITEM = new RegExp(
  String.raw`\s*(${NAME}(?:\s*\.\s*${NAME})?)(?:\s+AS\s+(${NAME})|\s+(?!(?:${NOT_ALIAS.join("|")})\b)(\w+))?`, "iy",
);
const LIST_COMMA = /\s*,/y;
const unquote = (name: string) => (/^["\x60]/.test(name) ? name.slice(1, -1) : name);

/**
 * The tables a statement reads or writes, by the name they go by, with each alias — `FROM users u`,
 * `JOIN orders AS o`, `FROM users u, orders o`, MySQL's `UPDATE users u, orders o` — and the schema
 * of each one written with it.
 */
export function extractTableRefs(text: string) {
  const tableRefs = new Set<string>();
  const aliasMap = new Map<string, string>(); // alias → realTableName
  const schemaOf = new Map<string, string>(); // table, lower case → its schema, when written
  for (const keyword of text.matchAll(/\b(FROM|JOIN|UPDATE|INTO)\b/gi)) {
    TABLE_ITEM.lastIndex = keyword.index + keyword[0].length;
    // FROM takes a list — and MySQL's UPDATE: every table in `FROM a x, b y` has its alias.
    const list = /^(FROM|UPDATE)$/i.test(keyword[1]!);
    for (let m = TABLE_ITEM.exec(text); m; m = TABLE_ITEM.exec(text)) {
      const parts = [...m[1]!.matchAll(new RegExp(NAME, "g"))].map((p) => unquote(p[0]));
      const table = parts.at(-1)!;
      tableRefs.add(table);
      if (parts.length === 2) schemaOf.set(table.toLowerCase(), parts[0]!);
      const alias = m[2] ? unquote(m[2]) : m[3];
      if (alias && !NOT_ALIAS_SET.has(alias.toUpperCase())) aliasMap.set(alias.toLowerCase(), table);
      if (!list) break;
      LIST_COMMA.lastIndex = TABLE_ITEM.lastIndex;
      if (!LIST_COMMA.test(text)) break;
      TABLE_ITEM.lastIndex = LIST_COMMA.lastIndex;
    }
  }
  return { tableRefs, aliasMap, schemaOf };
}

/** Resolve alias or table name to real table name */
export function resolveTable(name: string, aliasMap: Map<string, string>): string {
  return aliasMap.get(name.toLowerCase()) ?? name;
}

/**
 * The schema to read a table's columns from: the one written before it, else the only schema that
 * has a table by that name — Postgres reads an unnamed schema as `public`, where a table of
 * another schema is not — else the connection's own.
 */
export function schemaForTable(table: string, written: Map<string, string>, schemaInfo: SchemaInfo): string | undefined {
  const named = written.get(table.toLowerCase());
  if (named) return named;
  const found = schemaInfo.tables.filter((t) => t.name.toLowerCase() === table.toLowerCase());
  return found.length === 1 && found[0]!.schema ? found[0]!.schema : undefined;
}

/** Fetch columns for a table (cached) */
async function getColumns(tableName: string, schemaInfo: SchemaInfo, schema?: string): Promise<{ name: string; type: string }[]> {
  let columnCache = columnCaches.get(schemaInfo);
  if (!columnCache) columnCaches.set(schemaInfo, columnCache = new Map());
  const key = `${schema ?? ""}.${tableName.toLowerCase()}`;
  let cols = columnCache.get(key);
  if (!cols) {
    try {
      cols = await schemaInfo.getColumns(tableName, schema);
      columnCache.set(key, cols);
    } catch { cols = []; }
  }
  return cols;
}

/**
 * A column as it has to be typed. Postgres folds an unquoted name to lower case, so a name
 * with capitals needs quotes; MySQL matches column names case-insensitively and quotes with
 * backticks — a double-quoted word there is a string.
 */
export function columnInsertText(name: string, dialect: DialectName): string {
  if (dialect === "mysql") return /^[A-Za-z_][\w$]*$/.test(name) ? name : quoteIdentifier(name, dialect);
  return /[A-Z]/.test(name) ? quoteIdentifier(name, dialect) : name;
}

/** Build column suggestions from all referenced tables */
async function columnSuggestions(
  { tableRefs, schemaOf }: ReturnType<typeof extractTableRefs>,
  schemaInfo: SchemaInfo,
  monaco: typeof MonacoType,
  range: MonacoType.IRange,
  dialect: DialectName,
): Promise<MonacoType.languages.CompletionItem[]> {
  const items: MonacoType.languages.CompletionItem[] = [];
  const seen = new Set<string>();
  for (const tbl of tableRefs) {
    const cols = await getColumns(tbl, schemaInfo, schemaForTable(tbl, schemaOf, schemaInfo));
    for (const col of cols) {
      if (seen.has(col.name)) continue;
      seen.add(col.name);
      items.push({
        label: col.name,
        kind: monaco.languages.CompletionItemKind.Field,
        detail: `${tbl} · ${col.type}`,
        insertText: columnInsertText(col.name, dialect),
        range,
        sortText: "0" + col.name,
      });
    }
  }
  return items;
}

/**
 * Determine the SQL completion context from text before cursor.
 * Returns a context tag used to decide which suggestions to show.
 * Exported for testing.
 */
export function getCompletionContext(textUntilPosition: string): string {
  // 1. After "alias." or "table." → dot completion
  if (/(\w+)\.\s*$/.test(textUntilPosition)) return "dot";

  // 2. After ORDER BY col or GROUP BY col → direction (ASC/DESC)
  // Pattern: ORDER BY <col> <partial_word>  — but NOT if partial is already ASC/DESC
  const orderByColMatch = textUntilPosition.match(/\b(?:ORDER|GROUP)\s+BY\s+(?:[\w"`]+\s+(?:ASC|DESC)\s*,\s*)*[\w"`]+\s+(\w*)$/i);
  if (orderByColMatch) {
    const partial = orderByColMatch[1]!.toUpperCase();
    if (partial === "ASC" || partial === "DESC") return "after-direction";
    return "sort-direction";
  }

  // 3. After ORDER BY col ASC/DESC, → more columns after comma
  if (/\b(?:ORDER|GROUP)\s+BY\s+.*(?:ASC|DESC)\s*,\s*\w*$/i.test(textUntilPosition)) return "order-by-next-col";

  // 4. After WHERE/AND/OR <col> → operators
  if (/\b(?:WHERE|AND|OR)\s+[\w"`]+\s+\S*$/i.test(textUntilPosition)) return "operator";

  // 5. After FROM/JOIN/INTO/UPDATE/TABLE → table names
  if (/\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+\w*$/i.test(textUntilPosition)) return "table";

  // 6. After INSERT INTO table ( → columns for insert
  if (/\bINSERT\s+INTO\s+[\w"`]+\s*\(\s*(?:[\w"`]+\s*,\s*)*\w*$/i.test(textUntilPosition)) return "insert-cols";

  // 7. After SELECT/WHERE/ORDER BY/GROUP BY/HAVING/SET/ON/AND/OR → columns
  if (/\b(?:SELECT|WHERE|ORDER\s+BY|GROUP\s+BY|HAVING|SET|ON|AND|OR)\s+(?:[\w"`]+\s*,\s*)*\w*$/i.test(textUntilPosition)) return "columns";

  // 8. After comma with table refs → more columns
  if (/,\s*\w*$/.test(textUntilPosition)) return "comma-cols";

  // 9. Default
  return "default";
}

/**
 * `dialect` is read per request: the editor learns its connection's engine after it mounts.
 * Monaco keeps completion providers per language, not per editor, so this one is asked about
 * every SQL model on the page — each mounted Query tab, each .sql file — and answers only for
 * `editor`'s, or every tab would offer every other connection's tables.
 */
export function createSqlCompletionProvider(
  monaco: typeof MonacoType,
  schemaInfo: SchemaInfo,
  dialect: () => DialectName,
  editor: Pick<MonacoType.editor.ICodeEditor, "getModel">,
): MonacoType.languages.CompletionItemProvider {
  return {
    triggerCharacters: [".", ","],
    provideCompletionItems: async (model, position) => {
      if (model !== editor.getModel()) return { suggestions: [] };
      try {
        const textUntilPosition = model.getValueInRange({
          startLineNumber: 1, startColumn: 1,
          endLineNumber: position.lineNumber, endColumn: position.column,
        });
        const word = model.getWordUntilPosition(position);
        const range: MonacoType.IRange = {
          startLineNumber: position.lineNumber, endLineNumber: position.lineNumber,
          startColumn: word.startColumn, endColumn: word.endColumn,
        };
        const fullText = model.getValue();
        const d = dialect();
        const currentStmt = getStatementAtCursor(fullText, position.lineNumber, d);
        const refs = extractTableRefs(currentStmt);
        const { tableRefs, aliasMap } = refs;
        const suggestions: MonacoType.languages.CompletionItem[] = [];
        const ctx = getCompletionContext(textUntilPosition);

        // ─── 1. After "alias." or "table." → columns of that table ───
        if (ctx === "dot") {
          const dotMatch = textUntilPosition.match(/(\w+)\.\s*$/);
          if (dotMatch) {
            const ref = dotMatch[1]!;
            const realTable = resolveTable(ref, aliasMap);
            const cols = await getColumns(realTable, schemaInfo, schemaForTable(realTable, refs.schemaOf, schemaInfo));
            for (const col of cols) {
              suggestions.push({
                label: col.name,
                kind: monaco.languages.CompletionItemKind.Field,
                detail: col.type,
                insertText: columnInsertText(col.name, d),
                range,
              });
            }
          }
          return { suggestions };
        }

        // ─── 2. After ORDER BY col → ASC, DESC ───
        if (ctx === "sort-direction") {
          for (const dir of SORT_DIRS) {
            suggestions.push({
              label: dir,
              kind: monaco.languages.CompletionItemKind.Keyword,
              insertText: dir,
              range,
              sortText: "0" + dir,
            });
          }
          return { suggestions };
        }

        // ─── 3. After ASC/DESC → nothing special ───
        if (ctx === "after-direction") return { suggestions: [] };

        // ─── 4. After ORDER BY col ASC/DESC, → more columns ───
        if (ctx === "order-by-next-col") {
          suggestions.push(...await columnSuggestions(refs, schemaInfo, monaco, range, d));
          return { suggestions };
        }

        // ─── 5. After WHERE/AND/OR col → operators ───
        if (ctx === "operator") {
          for (const op of sqlOperators(d)) {
            suggestions.push({
              label: op,
              kind: monaco.languages.CompletionItemKind.Operator,
              insertText: op,
              range,
              sortText: "0" + op,
            });
          }
          return { suggestions };
        }

        // ─── 6. After FROM/JOIN/INTO/UPDATE/TABLE → table names ───
        if (ctx === "table") {
          for (const t of schemaInfo.tables) {
            suggestions.push({
              label: t.name,
              kind: monaco.languages.CompletionItemKind.Struct,
              detail: t.schema,
              insertText: t.name,
              range,
              sortText: "0" + t.name,
            });
          }
          return { suggestions };
        }

        // ─── 7. After INSERT INTO table ( → columns ───
        if (ctx === "insert-cols") {
          suggestions.push(...await columnSuggestions(refs, schemaInfo, monaco, range, d));
          return { suggestions };
        }

        // ─── 8. After SELECT/WHERE/ORDER BY/... → columns + keywords ───
        if (ctx === "columns") {
          suggestions.push(...await columnSuggestions(refs, schemaInfo, monaco, range, d));
          if (/\bSELECT\s+/i.test(textUntilPosition)) {
            suggestions.push({
              label: "*",
              kind: monaco.languages.CompletionItemKind.Value,
              insertText: "*",
              range,
              sortText: "00*",
            });
            for (const fn of AGGREGATE_FNS) {
              suggestions.push({
                label: `${fn}()`,
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: `${fn}($0)`,
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                range,
                sortText: "1" + fn,
              });
            }
          }
          for (const kw of sqlKeywords(d)) {
            suggestions.push({
              label: kw, kind: monaco.languages.CompletionItemKind.Keyword,
              insertText: kw, range, sortText: "3" + kw,
            });
          }
          return { suggestions };
        }

        // ─── 9. After comma → more columns ───
        if (ctx === "comma-cols" && tableRefs.size > 0) {
          suggestions.push(...await columnSuggestions(refs, schemaInfo, monaco, range, d));
          return { suggestions };
        }

        // ─── 10. Default: keywords + table names ───
        for (const kw of sqlKeywords(d)) {
          suggestions.push({
            label: kw, kind: monaco.languages.CompletionItemKind.Keyword,
            insertText: kw, range, sortText: "2" + kw,
          });
        }
        for (const t of schemaInfo.tables) {
          suggestions.push({
            label: t.name, kind: monaco.languages.CompletionItemKind.Struct,
            detail: t.schema, insertText: t.name, range, sortText: "1" + t.name,
          });
        }
        return { suggestions };
      } catch {
        // Never let the provider throw — Monaco silently falls back to word-based suggestions
        return { suggestions: [] };
      }
    },
  };
}
