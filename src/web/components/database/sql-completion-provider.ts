import type * as MonacoType from "monaco-editor";

export interface SchemaInfo {
  tables: { name: string; schema: string }[];
  getColumns: (table: string, schema?: string) => Promise<{ name: string; type: string }[]>;
}

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
  "FULL OUTER JOIN", "IS NULL", "IS NOT NULL",
];

export const AGGREGATE_FNS = ["COUNT", "SUM", "AVG", "MIN", "MAX"];
export const OPERATORS = ["=", "!=", "<>", ">", "<", ">=", "<=", "LIKE", "ILIKE", "IN", "NOT IN", "BETWEEN", "IS NULL", "IS NOT NULL"];
export const SORT_DIRS = ["ASC", "DESC"];

/** Client-side column cache to avoid redundant fetches */
const columnCache = new Map<string, { name: string; type: string }[]>();

const TABLE_KW_SET = new Set([
  "WHERE", "SET", "ON", "ORDER", "GROUP", "HAVING", "LIMIT", "LEFT", "RIGHT",
  "INNER", "OUTER", "CROSS", "FULL", "JOIN", "AND", "OR", "VALUES", "SELECT",
  "FROM", "INTO", "UPDATE", "DELETE", "INSERT", "CREATE", "ALTER", "DROP",
]);

/** Extract tables referenced in FROM/JOIN/UPDATE/INTO clauses */
export function extractTableRefs(text: string) {
  const tableRefs = new Set<string>();
  const aliasMap = new Map<string, string>(); // alias → realTableName
  // Match: FROM/JOIN/UPDATE/INTO "tablename" [AS] alias
  // Use non-greedy alias capture to avoid consuming the next keyword
  const matches = text.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO)\s+"?(\w+)"?(?:\s+AS\s+(\w+)|\s+(?!(?:FROM|JOIN|UPDATE|INTO|WHERE|SET|ON|ORDER|GROUP|HAVING|LIMIT|LEFT|RIGHT|INNER|OUTER|CROSS|FULL|AND|OR|VALUES|SELECT)\b)(\w+))?/gi);
  for (const m of matches) {
    const tbl = m[1]!;
    tableRefs.add(tbl);
    const alias = m[2] ?? m[3]; // m[2] = explicit AS alias, m[3] = implicit alias
    if (alias && !TABLE_KW_SET.has(alias.toUpperCase())) {
      aliasMap.set(alias.toLowerCase(), tbl);
    }
  }
  return { tableRefs, aliasMap };
}

/** Resolve alias or table name to real table name */
export function resolveTable(name: string, aliasMap: Map<string, string>): string {
  return aliasMap.get(name.toLowerCase()) ?? name;
}

/** Fetch columns for a table (cached) */
async function getColumns(tableName: string, schemaInfo: SchemaInfo): Promise<{ name: string; type: string }[]> {
  const key = tableName.toLowerCase();
  let cols = columnCache.get(key);
  if (!cols) {
    try {
      cols = await schemaInfo.getColumns(tableName);
      columnCache.set(key, cols);
    } catch { cols = []; }
  }
  return cols;
}

/** Build column suggestions from all referenced tables */
async function columnSuggestions(
  tableRefs: Set<string>,
  schemaInfo: SchemaInfo,
  monaco: typeof MonacoType,
  range: MonacoType.IRange,
): Promise<MonacoType.languages.CompletionItem[]> {
  const items: MonacoType.languages.CompletionItem[] = [];
  const seen = new Set<string>();
  for (const tbl of tableRefs) {
    const cols = await getColumns(tbl, schemaInfo);
    for (const col of cols) {
      if (seen.has(col.name)) continue;
      seen.add(col.name);
      const needsQuote = /[A-Z]/.test(col.name);
      items.push({
        label: col.name,
        kind: monaco.languages.CompletionItemKind.Field,
        detail: `${tbl} · ${col.type}`,
        insertText: needsQuote ? `"${col.name}"` : col.name,
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
  const orderByColMatch = textUntilPosition.match(/\b(?:ORDER|GROUP)\s+BY\s+(?:[\w"]+\s+(?:ASC|DESC)\s*,\s*)*[\w"]+\s+(\w*)$/i);
  if (orderByColMatch) {
    const partial = orderByColMatch[1]!.toUpperCase();
    if (partial === "ASC" || partial === "DESC") return "after-direction";
    return "sort-direction";
  }

  // 3. After ORDER BY col ASC/DESC, → more columns after comma
  if (/\b(?:ORDER|GROUP)\s+BY\s+.*(?:ASC|DESC)\s*,\s*\w*$/i.test(textUntilPosition)) return "order-by-next-col";

  // 4. After WHERE/AND/OR <col> → operators
  if (/\b(?:WHERE|AND|OR)\s+[\w"]+\s+\S*$/i.test(textUntilPosition)) return "operator";

  // 5. After FROM/JOIN/INTO/UPDATE/TABLE → table names
  if (/\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+\w*$/i.test(textUntilPosition)) return "table";

  // 6. After INSERT INTO table ( → columns for insert
  if (/\bINSERT\s+INTO\s+[\w"]+\s*\(\s*(?:[\w"]+\s*,\s*)*\w*$/i.test(textUntilPosition)) return "insert-cols";

  // 7. After SELECT/WHERE/ORDER BY/GROUP BY/HAVING/SET/ON/AND/OR → columns
  if (/\b(?:SELECT|WHERE|ORDER\s+BY|GROUP\s+BY|HAVING|SET|ON|AND|OR)\s+(?:[\w"]+\s*,\s*)*\w*$/i.test(textUntilPosition)) return "columns";

  // 8. After comma with table refs → more columns
  if (/,\s*\w*$/.test(textUntilPosition)) return "comma-cols";

  // 9. Default
  return "default";
}

export function createSqlCompletionProvider(
  monaco: typeof MonacoType,
  schemaInfo: SchemaInfo,
): MonacoType.languages.CompletionItemProvider {
  return {
    triggerCharacters: [".", ","],
    provideCompletionItems: async (model, position) => {
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
        const { tableRefs, aliasMap } = extractTableRefs(fullText);
        const suggestions: MonacoType.languages.CompletionItem[] = [];
        const ctx = getCompletionContext(textUntilPosition);

        // ─── 1. After "alias." or "table." → columns of that table ───
        if (ctx === "dot") {
          const dotMatch = textUntilPosition.match(/(\w+)\.\s*$/);
          if (dotMatch) {
            const ref = dotMatch[1]!;
            const realTable = resolveTable(ref, aliasMap);
            const cols = await getColumns(realTable, schemaInfo);
            for (const col of cols) {
              const needsQuote = /[A-Z]/.test(col.name);
              suggestions.push({
                label: col.name,
                kind: monaco.languages.CompletionItemKind.Field,
                detail: col.type,
                insertText: needsQuote ? `"${col.name}"` : col.name,
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
          suggestions.push(...await columnSuggestions(tableRefs, schemaInfo, monaco, range));
          return { suggestions };
        }

        // ─── 5. After WHERE/AND/OR col → operators ───
        if (ctx === "operator") {
          for (const op of OPERATORS) {
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
          suggestions.push(...await columnSuggestions(tableRefs, schemaInfo, monaco, range));
          return { suggestions };
        }

        // ─── 8. After SELECT/WHERE/ORDER BY/... → columns + keywords ───
        if (ctx === "columns") {
          suggestions.push(...await columnSuggestions(tableRefs, schemaInfo, monaco, range));
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
          for (const kw of SQL_KEYWORDS) {
            suggestions.push({
              label: kw, kind: monaco.languages.CompletionItemKind.Keyword,
              insertText: kw, range, sortText: "3" + kw,
            });
          }
          return { suggestions };
        }

        // ─── 9. After comma → more columns ───
        if (ctx === "comma-cols" && tableRefs.size > 0) {
          suggestions.push(...await columnSuggestions(tableRefs, schemaInfo, monaco, range));
          return { suggestions };
        }

        // ─── 10. Default: keywords + table names ───
        for (const kw of SQL_KEYWORDS) {
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

/** Clear the internal column cache (call on connection change) */
export function clearCompletionCache() {
  columnCache.clear();
}
