import { useState, useCallback, useRef, useEffect } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type * as MonacoType from "monaco-editor";
import { useMonacoTheme } from "@/lib/use-monaco-theme";
import { createSqlCompletionProvider, clearCompletionCache, getStatementAtCursor, type SchemaInfo } from "./sql-completion-provider";

interface SqlQueryEditorProps {
  onExecute: (sql: string) => void;
  loading: boolean;
  defaultValue?: string;
  schemaInfo?: SchemaInfo;
  /** Called when the user edits the SQL text (for external persistence) */
  onSqlChange?: (sql: string) => void;
  /** Persisted SQL to restore on mount (takes priority over defaultValue if user hasn't edited) */
  persistedSql?: string;
}

/** Shared Monaco-based SQL query editor (editor only, no results) */
export function SqlQueryEditor({ onExecute, loading, defaultValue = "SELECT * FROM ", schemaInfo, onSqlChange, persistedSql }: SqlQueryEditorProps) {
  const [query, setQuery] = useState(() => persistedSql ?? defaultValue);
  const userEditedRef = useRef(!!persistedSql);
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
        onChange={(v) => { const val = v ?? ""; setQuery(val); userEditedRef.current = true; onSqlChange?.(val); }}
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
