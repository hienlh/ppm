import { useState, useCallback } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { sql, SQLite } from "@codemirror/lang-sql";
import { Play, Loader2 } from "lucide-react";
import type { QueryResult } from "./use-sqlite";

interface Props {
  onExecute: (sql: string) => void;
  result: QueryResult | null;
  error: string | null;
  loading: boolean;
}

export function SqliteQueryEditor({ onExecute, result, error, loading }: Props) {
  const [query, setQuery] = useState("SELECT * FROM ");

  const handleExecute = useCallback(() => {
    const trimmed = query.trim();
    if (!trimmed) return;
    onExecute(trimmed);
  }, [query, onExecute]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      handleExecute();
    }
  }, [handleExecute]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Editor area */}
      <div className="flex items-start gap-1 border-b border-border bg-background" onKeyDown={handleKeyDown}>
        <div className="flex-1 max-h-[120px] overflow-auto">
          <CodeMirror
            value={query}
            onChange={setQuery}
            extensions={[sql({ dialect: SQLite })]}
            basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false }}
            className="text-xs [&_.cm-editor]:!outline-none [&_.cm-scroller]:!overflow-auto"
          />
        </div>
        <button
          type="button"
          onClick={handleExecute}
          disabled={loading}
          className="shrink-0 m-1 p-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
          title="Execute (Cmd+Enter)"
        >
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
        </button>
      </div>

      {/* Results area */}
      <div className="flex-1 overflow-auto text-xs">
        {error && (
          <div className="px-3 py-2 text-destructive bg-destructive/5">{error}</div>
        )}

        {result && result.changeType === "modify" && (
          <div className="px-3 py-2 text-green-500">
            Query executed. {result.rowsAffected} row(s) affected.
          </div>
        )}

        {result && result.changeType === "select" && result.rows.length > 0 && (
          <table className="w-full border-collapse">
            <thead className="sticky top-0 bg-muted">
              <tr>
                {result.columns.map((col) => (
                  <th key={col} className="px-2 py-1 text-left font-medium text-muted-foreground border-b border-border whitespace-nowrap">
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, i) => (
                <tr key={i} className="hover:bg-muted/30 border-b border-border/50">
                  {result.columns.map((col) => (
                    <td key={col} className="px-2 py-1 max-w-[300px] truncate" title={row[col] == null ? "NULL" : String(row[col])}>
                      {row[col] == null ? <span className="text-muted-foreground/40 italic">NULL</span> : String(row[col])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {result && result.changeType === "select" && result.rows.length === 0 && (
          <div className="px-3 py-2 text-muted-foreground">No results</div>
        )}
      </div>
    </div>
  );
}
