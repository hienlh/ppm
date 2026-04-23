import { useState, useCallback, useRef, useEffect } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type * as MonacoType from "monaco-editor";
import { useMonacoTheme } from "@/lib/use-monaco-theme";
import { createSqlCompletionProvider, clearCompletionCache, type SchemaInfo } from "./sql-completion-provider";

interface SqlQueryEditorProps {
  onExecute: (sql: string) => void;
  loading: boolean;
  defaultValue?: string;
  schemaInfo?: SchemaInfo;
  /** Unique key for caching query text in sessionStorage (e.g. connectionId) */
  cacheKey?: string;
}

/** Find the SQL statement surrounding the cursor line (split by ;) */
export function getStatementAtCursor(text: string, cursorLine: number): string {
  const lines = text.split("\n");
  // Find statement boundaries (lines where a statement ends with ;)
  let stmtStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (i < cursorLine - 1 && trimmed.endsWith(";")) {
      stmtStart = i + 1;
    }
  }
  // Find statement end
  let stmtEnd = lines.length - 1;
  for (let i = cursorLine - 1; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed.endsWith(";")) {
      stmtEnd = i;
      break;
    }
  }
  // Skip leading empty/comment lines
  while (stmtStart <= stmtEnd) {
    const t = lines[stmtStart]!.trim();
    if (t && !t.startsWith("--")) break;
    stmtStart++;
  }
  return lines.slice(stmtStart, stmtEnd + 1).join("\n").trim();
}

/** Shared Monaco-based SQL query editor (editor only, no results) */
export function SqlQueryEditor({ onExecute, loading, defaultValue = "SELECT * FROM ", schemaInfo, cacheKey }: SqlQueryEditorProps) {
  const storageKey = cacheKey ? `ppm:sql-query:${cacheKey}` : null;
  const [query, setQuery] = useState(() => {
    if (storageKey) { try { return sessionStorage.getItem(storageKey) ?? defaultValue; } catch { /* */ } }
    return defaultValue;
  });
  const userEditedRef = useRef(false);
  const editorRef = useRef<MonacoType.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof MonacoType | null>(null);
  const disposableRef = useRef<MonacoType.IDisposable | null>(null);
  const onExecuteRef = useRef(onExecute);
  onExecuteRef.current = onExecute;
  const monacoTheme = useMonacoTheme();

  useEffect(() => {
    if (!monacoRef.current || !schemaInfo) return;
    disposableRef.current?.dispose();
    clearCompletionCache();
    disposableRef.current = monacoRef.current.languages.registerCompletionItemProvider(
      "sql",
      createSqlCompletionProvider(monacoRef.current, schemaInfo),
    );
    return () => { disposableRef.current?.dispose(); };
  }, [schemaInfo]);

  const handleMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    // Cmd/Ctrl+Enter: run statement at cursor
    editor.addAction({
      id: "run-query-at-cursor",
      label: "Run Statement at Cursor",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: (ed) => {
        const pos = ed.getPosition();
        if (!pos) return;
        const text = ed.getValue();
        const stmt = getStatementAtCursor(text, pos.lineNumber);
        if (stmt) onExecuteRef.current(stmt);
      },
    });

    if (schemaInfo) {
      disposableRef.current?.dispose();
      disposableRef.current = monaco.languages.registerCompletionItemProvider(
        "sql",
        createSqlCompletionProvider(monaco, schemaInfo),
      );
    }
  }, [schemaInfo]);

  // Sync from defaultValue only if user hasn't manually edited
  useEffect(() => {
    if (!userEditedRef.current) setQuery(defaultValue);
  }, [defaultValue]);

  return (
    <div className="h-full overflow-hidden">
      <Editor
        height="100%"
        language="sql"
        theme={monacoTheme}
        value={query}
        onChange={(v) => { const val = v ?? ""; setQuery(val); userEditedRef.current = true; if (storageKey) try { sessionStorage.setItem(storageKey, val); } catch {} }}
        onMount={handleMount}
        options={{
          minimap: { enabled: false },
          lineNumbers: "off",
          scrollBeyondLastLine: false,
          wordWrap: "on",
          fontSize: 12,
          tabSize: 2,
          renderLineHighlight: "none",
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
          scrollbar: { vertical: "auto", horizontal: "auto", verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
          padding: { top: 4, bottom: 4 },
          lineDecorationsWidth: 4,
          lineNumbersMinChars: 0,
          glyphMargin: false,
          folding: false,
          fixedOverflowWidgets: true,
        }}
      />
    </div>
  );
}
