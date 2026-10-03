import { useState, useCallback, useRef, useEffect, type RefObject } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type * as MonacoType from "monaco-editor";
import { useMonacoTheme } from "@/lib/use-monaco-theme";
import { EDITOR_FONT_FAMILY } from "@/lib/editor-font";
import { prepareMonacoTheme } from "@/theme/adapters/monaco-adapter";
import { createSqlCompletionProvider, type SchemaInfo } from "./sql-completion-provider";
import { scriptRun, selectionOrStatementRun, statementRun, type EditorSelection, type SqlRun } from "./sql-run";
import { cursorAfterReformat } from "./reformat-cursor";
import { splitSqlStatementsWithLines, statementAt, type SqlStatement } from "../../../shared/split-sql-statements";
import type { DialectName } from "../../../shared/db-types";

interface SqlQueryEditorProps {
  /** Ctrl+Enter's statement — and, in a Query tab, F5's selection or whole script — with where it begins. */
  onExecute: (run: SqlRun) => void;
  loading: boolean;
  defaultValue?: string;
  schemaInfo?: SchemaInfo;
  /** Called when the user edits the SQL text (for external persistence) */
  onSqlChange?: (sql: string) => void;
  /** Persisted SQL to restore on mount (takes priority over defaultValue if user hasn't edited) */
  persistedSql?: string;
  /** The engine's SQL, for where a statement ends (MySQL backticks, # comments, DELIMITER). */
  dialect?: DialectName;
  /** Set once the editor is ready, for a Run button outside it. */
  handleRef?: RefObject<SqlEditorHandle | null>;
  /**
   * DBGate's query editor: line numbers, F5 for the selection or else the whole script, and — when
   * the script holds several statements — the one Ctrl+Enter runs marked in the gutter.
   */
  queryTab?: boolean;
  /** Lines an error of the last run points at, marked until the text is edited. */
  errorLines?: readonly number[];
  /** Shift+Alt+F in a Query tab, DBGate's Format code: the tab formats through `reformat`. */
  onFormat?: () => void;
}

export interface SqlEditorHandle {
  /** Runs the statement at the cursor, as Ctrl+Enter does. */
  runAtCursor(): void;
  /** Runs the selection, or else the whole script, as F5 does. */
  runScript(): void;
  /** What Explain sends: the selection, else the statement at the cursor. */
  selectionOrStatement(): SqlRun | null;
  /** Puts the cursor at the start of `line`, in view, and the keys back in the editor. */
  revealLine(line: number): void;
  /**
   * Puts `text` where the selection is, or at the cursor, as one undo step — selected, so F5 runs
   * it and typing replaces it — with the keys in the editor.
   */
  insertText(text: string): void;
  /**
   * Replaces the whole text with `format`'s answer as one undo step, the cursor kept by the same
   * character. What `format` throws comes out before anything is changed.
   */
  reformat(format: (sql: string) => string): void;
}

/** How long typing goes on before the statement at the cursor is worked out again: a long script is split whole. */
const CURRENT_STATEMENT_DELAY_MS = 120;

function selectionOf(editor: MonacoType.editor.ICodeEditor): EditorSelection | null {
  const selection = editor.getSelection();
  const model = editor.getModel();
  if (!selection || !model || selection.isEmpty()) return null;
  return { text: model.getValueInRange(selection), startLine: selection.startLineNumber };
}

/** Shared Monaco-based SQL query editor (editor only, no results) */
export function SqlQueryEditor({ onExecute, loading, defaultValue = "SELECT * FROM ", schemaInfo, onSqlChange, persistedSql, dialect = "postgres", handleRef, queryTab = false, errorLines, onFormat }: SqlQueryEditorProps) {
  const [query, setQuery] = useState(() => persistedSql ?? defaultValue);
  const userEditedRef = useRef(!!persistedSql);
  // Set by onMount, which @monaco-editor/react calls with the first render's props only: the schema
  // can arrive before the editor or after it, and completion has to be registered either way.
  const [mounted, setMounted] = useState<{ editor: MonacoType.editor.IStandaloneCodeEditor; monaco: typeof MonacoType } | null>(null);
  const onExecuteRef = useRef(onExecute);
  onExecuteRef.current = onExecute;
  const dialectRef = useRef(dialect);
  dialectRef.current = dialect;
  const onFormatRef = useRef(onFormat);
  onFormatRef.current = onFormat;
  const monacoTheme = useMonacoTheme();

  useEffect(() => {
    if (!mounted || !schemaInfo) return;
    const { editor, monaco } = mounted;
    const completion = monaco.languages.registerCompletionItemProvider(
      "sql",
      createSqlCompletionProvider(monaco, schemaInfo, () => dialectRef.current, editor),
    );
    return () => completion.dispose();
  }, [mounted, schemaInfo]);

  const handleMount: OnMount = useCallback((editor, monaco) => {
    const statement = () => {
      const pos = editor.getPosition();
      return pos ? statementRun(editor.getValue(), pos.lineNumber, dialectRef.current) : null;
    };
    // Cmd/Ctrl+Enter, and DBGate's Ctrl+Shift+Enter in a Query tab: the statement at the cursor.
    editor.addAction({
      id: "run-query-at-cursor",
      label: "Run Statement at Cursor",
      keybindings: [
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
        ...(queryTab ? [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter] : []),
      ],
      run: () => {
        const run = statement();
        if (run) onExecuteRef.current(run);
      },
    });
    // F5 is the browser's reload everywhere else: it is only taken while the keys are in the editor.
    if (queryTab) {
      editor.addAction({
        id: "run-query-script",
        label: "Run Script or Selection",
        keybindings: [monaco.KeyCode.F5],
        run: () => {
          const run = scriptRun(editor.getValue(), selectionOf(editor));
          if (run) onExecuteRef.current(run);
        },
      });
      // Monaco's own Format Document has this key too, but no SQL formatter behind it.
      editor.addAction({
        id: "format-query-script",
        label: "Format SQL",
        keybindings: [monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF],
        run: () => onFormatRef.current?.(),
      });
    }

    if (handleRef) {
      handleRef.current = {
        runAtCursor: () => { void editor.getAction("run-query-at-cursor")?.run(); },
        runScript: () => {
          const run = scriptRun(editor.getValue(), selectionOf(editor));
          if (run) onExecuteRef.current(run);
        },
        selectionOrStatement: () => {
          const pos = editor.getPosition();
          return selectionOrStatementRun(editor.getValue(), selectionOf(editor), pos?.lineNumber ?? 1, dialectRef.current);
        },
        revealLine: (line) => {
          editor.setPosition({ lineNumber: line, column: 1 });
          editor.revealLineInCenterIfOutsideViewport(line);
          editor.focus();
        },
        insertText: (text) => {
          const at = editor.getSelection();
          if (!at) return;
          editor.pushUndoStop();
          // The inverse edit covers the text as the model holds it, line endings included.
          editor.executeEdits("ppm-insert", [{ range: at, text, forceMoveMarkers: true }], (inverse) => {
            const r = inverse[0]?.range;
            return r ? [new monaco.Selection(r.startLineNumber, r.startColumn, r.endLineNumber, r.endColumn)] : null;
          });
          editor.pushUndoStop();
          const selection = editor.getSelection();
          if (selection) editor.revealRangeInCenterIfOutsideViewport(selection);
          editor.focus();
        },
        reformat: (format) => {
          const model = editor.getModel();
          if (!model) return;
          // "\n" whatever the model's own line ends, so the two texts count alike.
          const before = model.getValue(monaco.editor.EndOfLinePreference.LF);
          const after = format(before);
          if (after !== before) {
            const at = cursorAfterReformat(before, after, editor.getPosition() ?? { lineNumber: 1, column: 1 });
            editor.pushUndoStop();
            editor.executeEdits("ppm-format", [{ range: model.getFullModelRange(), text: after }], [
              new monaco.Selection(at.lineNumber, at.column, at.lineNumber, at.column),
            ]);
            editor.pushUndoStop();
            editor.revealPositionInCenterIfOutsideViewport(at);
          }
          editor.focus();
        },
      };
    }
    setMounted({ editor, monaco });
  }, [handleRef]); // eslint-disable-line react-hooks/exhaustive-deps -- queryTab is the editor's kind, fixed for its life

  // The statement Ctrl+Enter runs, DBGate's bold line numbers, once the script holds more than one.
  useEffect(() => {
    if (!mounted || !queryTab) return;
    const { editor, monaco } = mounted;
    const marks = editor.createDecorationsCollection();
    let split: { version: number; statements: SqlStatement[] } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const mark = () => {
      timer = null;
      const model = editor.getModel();
      const pos = editor.getPosition();
      if (!model || !pos) return marks.clear();
      const version = model.getVersionId();
      if (split?.version !== version) split = { version, statements: splitSqlStatementsWithLines(model.getValue(), dialectRef.current) };
      const current = split.statements.length > 1 ? statementAt(split.statements, pos.lineNumber) : null;
      marks.set(current ? [{
        range: new monaco.Range(current.startLine, 1, current.endLine, 1),
        options: { isWholeLine: true, lineNumberClassName: "ppm-sql-current-statement", linesDecorationsClassName: "ppm-sql-current-statement-bar" },
      }] : []);
    };
    const later = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(mark, CURRENT_STATEMENT_DELAY_MS);
    };
    mark();
    const moved = editor.onDidChangeCursorPosition(later);
    const edited = editor.onDidChangeModelContent(later);
    return () => {
      if (timer) clearTimeout(timer);
      moved.dispose();
      edited.dispose();
      marks.clear();
    };
  }, [mounted, queryTab]);

  // The lines the last run's errors point at, until the next edit.
  useEffect(() => {
    if (!mounted || !errorLines?.length) return;
    const { editor, monaco } = mounted;
    const lineCount = editor.getModel()?.getLineCount() ?? 0;
    const marks = editor.createDecorationsCollection(errorLines.filter((l) => l >= 1 && l <= lineCount).map((line) => ({
      range: new monaco.Range(line, 1, line, 1),
      options: { isWholeLine: true, className: "ppm-sql-error-line", linesDecorationsClassName: "ppm-sql-error-bar" },
    })));
    const edited = editor.onDidChangeModelContent(() => marks.clear());
    return () => {
      edited.dispose();
      marks.clear();
    };
  }, [mounted, errorLines]);

  // Sync from defaultValue only if user hasn't manually edited
  useEffect(() => {
    if (!userEditedRef.current) setQuery(defaultValue);
  }, [defaultValue]);

  return (
    <div className="h-full overflow-hidden">
      <Editor
        beforeMount={prepareMonacoTheme}
        height="100%"
        language="sql"
        theme={monacoTheme}
        value={query}
        onChange={(v) => { const val = v ?? ""; setQuery(val); userEditedRef.current = true; onSqlChange?.(val); }}
        onMount={handleMount}
        options={{
          minimap: { enabled: false },
          lineNumbers: queryTab ? "on" : "off",
          scrollBeyondLastLine: false,
          wordWrap: "on",
          fontFamily: EDITOR_FONT_FAMILY,
          fontSize: 12,
          tabSize: 2,
          renderLineHighlight: "none",
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
          scrollbar: { vertical: "auto", horizontal: "auto", verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
          padding: { top: 4, bottom: 4 },
          lineDecorationsWidth: queryTab ? 8 : 4,
          lineNumbersMinChars: queryTab ? 3 : 0,
          glyphMargin: false,
          folding: false,
          fixedOverflowWidgets: true,
        }}
      />
    </div>
  );
}
