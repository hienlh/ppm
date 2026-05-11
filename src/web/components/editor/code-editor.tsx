import { useEffect, useState, useCallback, useRef, useMemo, memo, lazy, Suspense } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type * as MonacoType from "monaco-editor";
import { api, projectUrl } from "@/lib/api-client";
import { useShallow } from "zustand/react/shallow";
import { useTabStore } from "@/stores/tab-store";
import { usePanelStore } from "@/stores/panel-store";
import { useSettingsStore } from "@/stores/settings-store";
import { basename } from "@/lib/utils";
import { useMonacoTheme } from "@/lib/use-monaco-theme";
import { Loader2, FileWarning, Play, Database, ExternalLink, X, GripHorizontal, ShieldCheck, ShieldOff } from "lucide-react";
import { EditorBreadcrumb } from "./editor-breadcrumb";
import { EditorToolbar } from "./editor-toolbar";
import { SaveAsDialog } from "./save-as-dialog";
import { EditorMobileToolbar } from "./editor-mobile-toolbar";
import { createSqlCompletionProvider, clearCompletionCache, type SchemaInfo } from "../database/sql-completion-provider";
import { useConnections, type Connection } from "../database/use-connections";
import { GlideDataGrid } from "../database/glide-data-grid";
import type { GridColumnSchema } from "../database/glide-grid-types";
import type { DbQueryResult } from "../database/use-database";

const MarkdownRenderer = lazy(() =>
  import("@/components/shared/markdown-renderer").then((m) => ({ default: m.MarkdownRenderer }))
);
const CsvPreview = lazy(() => import("./csv-preview").then((m) => ({ default: m.CsvPreview })));
const ImagePreview = lazy(() => import("./image-preview").then((m) => ({ default: m.ImagePreview })));
const PdfPreview = lazy(() => import("./pdf-preview").then((m) => ({ default: m.PdfPreview })));
const VideoPreview = lazy(() => import("./video-preview").then((m) => ({ default: m.VideoPreview })));
const AudioPreview = lazy(() => import("./audio-preview").then((m) => ({ default: m.AudioPreview })));
const DocxPreview = lazy(() => import("./docx-preview").then((m) => ({ default: m.DocxPreview })));

/** Image extensions renderable inline */
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"]);
/** Video extensions playable inline */
const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "ogg", "avi", "mkv"]);
/** Audio extensions playable inline */
const AUDIO_EXTS = new Set(["mp3", "wav", "flac", "aac", "m4a", "wma"]);
/** SQLite extensions — redirect to sqlite viewer */
const SQLITE_EXTS = new Set(["db", "sqlite", "sqlite3"]);

function getFileExt(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

function getMonacoLanguage(filename: string): string {
  const ext = getFileExt(filename);
  const map: Record<string, string> = {
    js: "javascript", jsx: "javascript",
    ts: "typescript", tsx: "typescript",
    py: "python", html: "html",
    css: "css", scss: "scss",
    json: "json", md: "markdown", mdx: "markdown",
    yaml: "yaml", yml: "yaml",
    sh: "shell", bash: "shell",
    sql: "sql",
  };
  return map[ext] ?? "plaintext";
}

interface CodeEditorProps {
  metadata?: Record<string, unknown>;
  tabId?: string;
}

export const CodeEditor = memo(function CodeEditor({ metadata, tabId }: CodeEditorProps) {
  const filePath = metadata?.filePath as string | undefined;
  const projectName = metadata?.projectName as string | undefined;
  // Inline content mode: read-only Monaco with pre-loaded content (e.g. cell viewer)
  const inlineContent = metadata?.inlineContent as string | undefined;
  const inlineLanguage = metadata?.inlineLanguage as string | undefined;
  const [content, setContent] = useState<string | null>(inlineContent ?? null);
  const [encoding, setEncoding] = useState<string>("utf-8");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unsaved, setUnsaved] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestContentRef = useRef<string>("");
  const editorRef = useRef<MonacoType.editor.IStandaloneCodeEditor | null>(null);
  const { tabs, updateTab } = useTabStore(useShallow((s) => ({ tabs: s.tabs, updateTab: s.updateTab })));
  const { wordWrap, toggleWordWrap } = useSettingsStore(useShallow((s) => ({ wordWrap: s.wordWrap, toggleWordWrap: s.toggleWordWrap })));
  const monacoTheme = useMonacoTheme();

  const isUntitled = metadata?.isUntitled === true;
  const savedContent = metadata?.unsavedContent as string | undefined;
  const [showSaveAs, setShowSaveAs] = useState(false);

  const ownTab = tabs.find((t) => t.id === tabId);
  const ext = filePath ? getFileExt(filePath) : "";
  const isImage = IMAGE_EXTS.has(ext);
  const isPdf = ext === "pdf";
  const isDocx = ext === "docx";
  const isVideo = VIDEO_EXTS.has(ext);
  const isAudio = AUDIO_EXTS.has(ext);
  const isSqlite = SQLITE_EXTS.has(ext);
  const isMarkdown = ext === "md" || ext === "mdx";
  const isCsv = ext === "csv";
  const isSql = ext === "sql";
  const [mdMode, setMdMode] = useState<"edit" | "preview">("preview");
  const [csvMode, setCsvMode] = useState<"table" | "raw">("table");

  // SQL file: connection picker + autocomplete + run in DB viewer
  const { connections, cachedTables, refreshTables, updateConnection } = useConnections();
  const [sqlConnId, setSqlConnId] = useState<number | null>(() => {
    if (!isSql || !filePath) return null;
    const stored = localStorage.getItem(`ppm:sql-conn:${filePath}`);
    return stored ? Number(stored) : null;
  });
  const monacoInstanceRef = useRef<typeof MonacoType | null>(null);
  const completionDisposable = useRef<MonacoType.IDisposable | null>(null);

  const selectedSqlConn = useMemo(() => connections.find((c) => c.id === sqlConnId) ?? null, [connections, sqlConnId]);

  // Beautify for inline content (must be before early returns to maintain hook order)
  const canBeautifyInline = inlineContent != null && (inlineLanguage === "json" || inlineLanguage === "xml");
  const [isBeautified, setIsBeautified] = useState(false);
  const handleBeautifyInline = useCallback(() => {
    if (!inlineContent) return;
    if (isBeautified) {
      setContent(inlineContent);
      setIsBeautified(false);
    } else {
      const trimmed = inlineContent.trimStart();
      if (inlineLanguage === "json") {
        try { setContent(JSON.stringify(JSON.parse(trimmed), null, 2)); setIsBeautified(true); } catch { /* not valid */ }
      } else if (inlineLanguage === "xml") {
        let indent = 0;
        const formatted = trimmed.replace(/(>)(<)(\/*)/g, "$1\n$2$3")
          .split("\n")
          .map((line) => {
            const l = line.trim();
            if (l.startsWith("</")) indent = Math.max(0, indent - 1);
            const padded = "  ".repeat(indent) + l;
            if (l.startsWith("<") && !l.startsWith("</") && !l.endsWith("/>") && !l.includes("</")) indent++;
            return padded;
          })
          .join("\n");
        setContent(formatted);
        setIsBeautified(true);
      }
    }
  }, [inlineContent, inlineLanguage, isBeautified]);

  // Persist selected connection per file
  const handleSqlConnChange = useCallback((connId: number) => {
    setSqlConnId(connId);
    if (filePath) localStorage.setItem(`ppm:sql-conn:${filePath}`, String(connId));
    // Refresh tables for autocomplete
    refreshTables(connId).catch(() => {});
  }, [filePath, refreshTables]);

  // Build SchemaInfo for .sql file autocomplete
  const sqlSchemaInfo = useMemo<SchemaInfo | undefined>(() => {
    if (!isSql || !sqlConnId) return undefined;
    const tables = (cachedTables.get(sqlConnId) ?? []).map((t) => ({ name: t.tableName, schema: t.schemaName }));
    if (tables.length === 0) return undefined;
    return {
      tables,
      getColumns: async (table: string, schema?: string) => {
        return api.get<{ name: string; type: string }[]>(
          `/api/db/connections/${sqlConnId}/schema?table=${encodeURIComponent(table)}${schema ? `&schema=${encodeURIComponent(schema)}` : ""}`,
        );
      },
    };
  }, [isSql, sqlConnId, cachedTables]);

  // Register/dispose completion provider when connection changes
  useEffect(() => {
    if (!monacoInstanceRef.current || !sqlSchemaInfo) return;
    completionDisposable.current?.dispose();
    clearCompletionCache();
    completionDisposable.current = monacoInstanceRef.current.languages.registerCompletionItemProvider(
      "sql",
      createSqlCompletionProvider(monacoInstanceRef.current, sqlSchemaInfo),
    );
    return () => { completionDisposable.current?.dispose(); };
  }, [sqlSchemaInfo]);

  // Run SQL inline — execute query and show results in bottom panel
  const openTab = useTabStore((s) => s.openTab);
  const [sqlResult, setSqlResult] = useState<DbQueryResult | null>(null);
  const [sqlError, setSqlError] = useState<string | null>(null);
  const [sqlLoading, setSqlLoading] = useState(false);
  const [sqlResultSql, setSqlResultSql] = useState<string>("");
  const runSqlInViewer = useCallback(async (sqlText: string) => {
    if (!selectedSqlConn) return;
    setSqlLoading(true);
    setSqlError(null);
    setSqlResultSql(sqlText);
    try {
      const result = await api.post<DbQueryResult>(`/api/db/connections/${selectedSqlConn.id}/query`, { sql: sqlText });
      setSqlResult(result);
    } catch (e) {
      setSqlError((e as Error).message);
      setSqlResult(null);
    } finally {
      setSqlLoading(false);
    }
  }, [selectedSqlConn]);
  const openSqlResultInTab = useCallback(() => {
    if (!selectedSqlConn || !sqlResultSql) return;
    openTab({
      type: "database",
      title: `${selectedSqlConn.name} · Query`,
      projectId: null,
      closable: true,
      metadata: { connectionId: selectedSqlConn.id, connectionName: selectedSqlConn.name, dbType: selectedSqlConn.type, initialSql: sqlResultSql },
    });
  }, [selectedSqlConn, openTab, sqlResultSql]);

  const handleRunInDbViewer = useCallback(() => {
    if (!editorRef.current || !selectedSqlConn) return;
    const editor = editorRef.current;
    const selection = editor.getSelection();
    const sqlText = selection && !selection.isEmpty()
      ? editor.getModel()?.getValueInRange(selection) ?? editor.getValue()
      : editor.getValue();
    runSqlInViewer(sqlText);
  }, [selectedSqlConn, runSqlInViewer]);

  // Touch device detection for mobile toolbar
  const isMobile = typeof window !== "undefined" && "ontouchstart" in window;

  // Track visual viewport so toolbar stays above mobile keyboard
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [mobileHeight, setMobileHeight] = useState<number | null>(null);
  useEffect(() => {
    if (!isMobile) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const handle = () => {
      const el = containerRef.current;
      if (!el) return;
      // Calculate available height = viewport height - element's top offset from viewport
      const top = el.getBoundingClientRect().top;
      setMobileHeight(vv.height - Math.max(0, top));
    };
    vv.addEventListener("resize", handle);
    vv.addEventListener("scroll", handle);
    return () => {
      vv.removeEventListener("resize", handle);
      vv.removeEventListener("scroll", handle);
    };
  }, [isMobile]);

  // CodeLens: inline Run buttons between SQL statements
  const codeLensDisposable = useRef<MonacoType.IDisposable[]>([]);
  const runSqlRef = useRef(runSqlInViewer);
  runSqlRef.current = runSqlInViewer;

  // Cleanup CodeLens providers on unmount to prevent duplicate "Run" buttons
  useEffect(() => {
    return () => {
      codeLensDisposable.current.forEach((d) => d.dispose());
      codeLensDisposable.current = [];
    };
  }, []);

  // Redirect .db files to sqlite viewer by changing tab type
  useEffect(() => {
    if (isSqlite && tabId) updateTab(tabId, { type: "sqlite" });
  }, [isSqlite, tabId, updateTab]);

  // Detect external (absolute) file path — not relative to project
  const isExternalFile = filePath ? /^(\/|[A-Za-z]:[/\\])/.test(filePath) : false;

  // Load file content
  useEffect(() => {
    if (inlineContent != null) { setLoading(false); return; }
    if (isUntitled) {
      setContent(savedContent ?? "");
      latestContentRef.current = savedContent ?? "";
      setLoading(false);
      if (savedContent) setUnsaved(true);
      return;
    }
    if (!filePath) return;
    if (!isExternalFile && !projectName) return;
    if (isImage || isPdf || isDocx || isVideo || isAudio) { setLoading(false); return; }

    setLoading(true);
    setError(null);

    const readUrl = isExternalFile
      ? `/api/fs/read?path=${encodeURIComponent(filePath)}`
      : `${projectUrl(projectName!)}/files/read?path=${encodeURIComponent(filePath)}`;

    api
      .get<{ content: string; encoding?: string }>(readUrl)
      .then((data) => {
        setContent(data.content);
        if (data.encoding) setEncoding(data.encoding);
        latestContentRef.current = data.content;
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load file");
        setLoading(false);
      });

    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, [filePath, projectName, isImage, isPdf, isDocx, isExternalFile, isUntitled]);

  // Real-time reload: listen for file:changed WS events, re-fetch if editor is clean
  const unsavedRef = useRef(unsaved);
  unsavedRef.current = unsaved;
  useEffect(() => {
    if (!filePath || !projectName || inlineContent != null || isUntitled) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.projectName !== projectName || detail.path !== filePath) return;
      if (unsavedRef.current) return; // don't overwrite unsaved changes
      const readUrl = isExternalFile
        ? `/api/fs/read?path=${encodeURIComponent(filePath)}`
        : `${projectUrl(projectName)}/files/read?path=${encodeURIComponent(filePath)}`;
      api.get<{ content: string; encoding?: string }>(readUrl).then((data) => {
        if (data.content === latestContentRef.current) return; // skip if unchanged (e.g. self-save)
        setContent(data.content);
        latestContentRef.current = data.content;
        if (data.encoding) setEncoding(data.encoding);
      }).catch(() => {});
    };
    window.addEventListener("file:changed", handler);
    return () => window.removeEventListener("file:changed", handler);
  }, [filePath, projectName, isExternalFile, inlineContent, isUntitled]);

  // Update tab title unsaved indicator (skip for inline content — title set by caller)
  useEffect(() => {
    if (!ownTab || inlineContent != null) return;
    const baseName = isUntitled
      ? `Untitled-${metadata?.untitledNumber ?? 1}`
      : (filePath ? basename(filePath) : "Untitled");
    const newTitle = unsaved ? `${baseName} \u25CF` : baseName;
    if (ownTab.title !== newTitle) updateTab(ownTab.id, { title: newTitle });
  }, [unsaved]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveFile = useCallback(
    async (text: string) => {
      if (!filePath) return;
      if (!isExternalFile && !projectName) return;
      try {
        if (isExternalFile) {
          await api.put("/api/fs/write", { path: filePath, content: text });
        } else {
          await api.put(`${projectUrl(projectName!)}/files/write`, { path: filePath, content: text });
        }
        setUnsaved(false);
      } catch { /* Silent — unsaved indicator persists */ }
    },
    [filePath, projectName, isExternalFile],
  );

  function handleChange(value: string | undefined) {
    const val = value ?? "";
    setContent(val);
    latestContentRef.current = val;
    setUnsaved(true);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    if (isUntitled) {
      // Persist to metadata for localStorage survival
      saveTimerRef.current = setTimeout(() => {
        if (tabId) updateTab(tabId, { metadata: { ...metadata, unsavedContent: latestContentRef.current } });
      }, 2000);
    } else {
      saveTimerRef.current = setTimeout(() => saveFile(latestContentRef.current), 1000);
    }
  }

  // Save As completion — transitions untitled → saved file
  const handleSaveAs = useCallback(async (targetPath: string, savedText: string) => {
    try {
      // Clear any pending metadata persistence timer to prevent race condition
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      await api.put("/api/fs/write", { path: targetPath, content: savedText });
      if (tabId) {
        // Close old untitled tab and open as proper file tab
        const { closeTab, openTab } = usePanelStore.getState();
        closeTab(tabId);
        openTab({
          type: "editor",
          title: basename(targetPath),
          projectId: null,
          metadata: { filePath: targetPath },
          closable: true,
        });
      }
      setUnsaved(false);
      setShowSaveAs(false);
    } catch { /* silent — user can retry */ }
  }, [tabId]);

  // Jump to line when metadata.lineNumber is set (e.g. from search panel)
  const lineNumber = metadata?.lineNumber as number | undefined;
  const handleEditorMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor;
    monacoInstanceRef.current = monaco;
    if (lineNumber && lineNumber > 0) {
      setTimeout(() => {
        editor.revealLineInCenter(lineNumber);
        editor.setPosition({ lineNumber, column: 1 });
        editor.focus();
      }, 100);
    }
    // Ctrl+S → Save As for untitled tabs
    if (isUntitled) {
      editor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
        () => setShowSaveAs(true),
      );
    }
    editor.addCommand(
      monaco.KeyMod.Alt | monaco.KeyCode.KeyZ,
      () => useSettingsStore.getState().toggleWordWrap(),
    );
    monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true, noSyntaxValidation: true, noSuggestionDiagnostics: true,
    });
    monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true, noSyntaxValidation: true, noSuggestionDiagnostics: true,
    });
    // Register SQL completion if schema available
    if (sqlSchemaInfo) {
      completionDisposable.current?.dispose();
      completionDisposable.current = monaco.languages.registerCompletionItemProvider(
        "sql", createSqlCompletionProvider(monaco, sqlSchemaInfo),
      );
    }

    // Register CodeLens for inline Run buttons on .sql files (scoped to this editor's model)
    if (isSql) {
      codeLensDisposable.current.forEach((d) => d.dispose());
      codeLensDisposable.current = [];

      const thisModel = editor.getModel();
      const cmdId = editor.addCommand(0, (_accessor: unknown, sql: string) => {
        if (sql) runSqlRef.current(sql);
      });

      if (cmdId && thisModel) {
        const provider = monaco.languages.registerCodeLensProvider("sql", {
          provideCodeLenses: (model: MonacoType.editor.ITextModel) => {
            // Only provide lenses for THIS editor's model, not all SQL models
            if (model !== thisModel) return { lenses: [], dispose: () => {} };

            const lenses: MonacoType.languages.CodeLens[] = [];
            const text = model.getValue();
            const lines = text.split("\n");
            let stmtStartLine = -1;
            let stmtLines: string[] = [];
            let dollarBlock = false; // Track DO $$ ... $$ blocks

            const addLens = (line: number, stmt: string) => {
              const trimmed = stmt.trim();
              if (!trimmed || trimmed.startsWith("--")) return;
              lenses.push({
                range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
                command: { id: cmdId, title: "\u25B7 Run", arguments: [trimmed] },
              });
            };

            for (let i = 0; i < lines.length; i++) {
              const trimmed = lines[i]!.trim();
              if (stmtStartLine === -1) {
                if (!trimmed || trimmed.startsWith("--")) continue;
                stmtStartLine = i + 1;
                stmtLines = [];
              }
              stmtLines.push(lines[i]!);

              // Detect $$ dollar-quoted block start/end
              const dollarMatches = (trimmed.match(/\$\$/g) || []).length;
              if (dollarMatches % 2 === 1) dollarBlock = !dollarBlock;

              // Only split on ; when NOT inside a $$ block
              if (!dollarBlock && trimmed.endsWith(";")) {
                addLens(stmtStartLine, stmtLines.join("\n"));
                stmtStartLine = -1;
                stmtLines = [];
              }
            }
            if (stmtStartLine > 0 && stmtLines.join("").trim()) {
              addLens(stmtStartLine, stmtLines.join("\n"));
            }
            return { lenses, dispose: () => {} };
          },
        });
        codeLensDisposable.current.push(provider);
      }
    }
  }, [sqlSchemaInfo]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!inlineContent && !isUntitled && (!filePath || (!isExternalFile && !projectName))) {
    return (
      <div className="flex items-center justify-center h-full text-text-secondary text-sm">
        No file selected.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full gap-2 text-text-secondary">
        <Loader2 className="size-5 animate-spin" />
        <span className="text-sm">Loading file...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-error text-sm">{error}</div>
    );
  }

  if (isImage) return <Suspense fallback={<LoadingSpinner />}><ImagePreview filePath={filePath!} projectName={projectName!} /></Suspense>;
  if (isPdf) return <Suspense fallback={<LoadingSpinner />}><PdfPreview filePath={filePath!} projectName={projectName!} /></Suspense>;
  if (isDocx) return <Suspense fallback={<LoadingSpinner />}><DocxPreview filePath={filePath!} projectName={projectName} /></Suspense>;
  if (isVideo) return <Suspense fallback={<LoadingSpinner />}><VideoPreview filePath={filePath!} projectName={projectName!} /></Suspense>;
  if (isAudio) return <Suspense fallback={<LoadingSpinner />}><AudioPreview filePath={filePath!} projectName={projectName!} /></Suspense>;

  if (encoding === "base64") {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-text-secondary">
        <FileWarning className="size-10 text-text-subtle" />
        <p className="text-sm">This file is a binary format and cannot be displayed.</p>
        <p className="text-xs text-text-subtle">{filePath}</p>
      </div>
    );
  }

  /** SQL connection picker bar (shared between breadcrumb and standalone) */
  const sqlPickerBar = isSql ? (
    <div className="shrink-0 flex items-center gap-1 px-2 border-l border-border">
      <Database className="size-3 text-muted-foreground" />
      <select
        value={sqlConnId ?? ""}
        onChange={(e) => { const v = Number(e.target.value); if (v) handleSqlConnChange(v); }}
        className="h-5 text-[10px] bg-transparent border border-border rounded px-1 text-foreground outline-none max-w-[140px]"
        title="Select connection for autocomplete"
      >
        <option value="">Connection…</option>
        {connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <button
        type="button"
        onClick={handleRunInDbViewer}
        disabled={!selectedSqlConn}
        className="p-0.5 rounded text-muted-foreground hover:text-primary disabled:opacity-30 transition-colors"
        title="Run SQL"
      >
        <Play className="size-3.5" />
      </button>
      {selectedSqlConn && (
        <button
          type="button"
          onClick={() => updateConnection(selectedSqlConn.id, { readonly: selectedSqlConn.readonly ? 0 : 1 })}
          className={`flex items-center gap-0.5 px-1 py-0.5 rounded text-[10px] transition-colors ${
            selectedSqlConn.readonly
              ? "text-muted-foreground hover:text-foreground"
              : "bg-destructive/15 text-destructive"
          }`}
          title={selectedSqlConn.readonly ? "Readonly — click to allow writes" : "WRITE mode — click to enable readonly"}
        >
          {selectedSqlConn.readonly ? <ShieldCheck className="size-3" /> : <><ShieldOff className="size-3" /><span className="font-medium">WRITE</span></>}
        </button>
      )}
    </div>
  ) : null;

  return (
    <div
      ref={containerRef}
      className="flex flex-col h-full w-full overflow-hidden"
      style={mobileHeight ? { height: `${mobileHeight}px`, maxHeight: `${mobileHeight}px` } : undefined}
    >
      {/* Inline content toolbar (cell viewer mode) */}
      {inlineContent != null && canBeautifyInline && (
        <div className="flex items-center h-7 border-b border-border bg-background shrink-0 px-2 gap-2">
          <button type="button" onClick={handleBeautifyInline}
            className="text-[10px] px-2 py-0.5 rounded border border-border hover:bg-muted transition-colors text-foreground">
            {isBeautified ? "Raw" : "Beautify"}
          </button>
        </div>
      )}
      {/* Breadcrumb + Toolbar bar — desktop only */}
      {filePath && projectName && tabId && (
        <div className="hidden md:flex items-center h-7 border-b border-border bg-background shrink-0">
          <EditorBreadcrumb
            filePath={filePath}
            projectName={projectName}
            tabId={tabId}
            className="flex items-center flex-1 min-w-0 overflow-x-auto scrollbar-none px-2 gap-0.5"
          />
          {sqlPickerBar}
          <EditorToolbar
            ext={ext}
            mdMode={mdMode}
            onMdModeChange={setMdMode}
            csvMode={csvMode}
            onCsvModeChange={setCsvMode}
            wordWrap={wordWrap}
            onToggleWordWrap={toggleWordWrap}
            filePath={filePath}
            projectName={projectName}
            className="shrink-0 flex items-center gap-1 px-2"
          />
        </div>
      )}

      {/* Standalone SQL toolbar for external files (no breadcrumb available) */}
      {isSql && (!projectName || !tabId) && (
        <div className="hidden md:flex items-center h-7 border-b border-border bg-background shrink-0 px-2">
          <span className="text-xs text-muted-foreground truncate flex-1">{filePath ? basename(filePath) : "SQL"}</span>
          {sqlPickerBar}
        </div>
      )}

      {/* Content area */}
      {isCsv && csvMode === "table" ? (
        <Suspense fallback={<div className="flex items-center justify-center h-full"><Loader2 className="size-5 animate-spin text-text-subtle" /></div>}>
          <CsvPreview content={content ?? ""} onContentChange={handleChange} wordWrap={wordWrap} />
        </Suspense>
      ) : isMarkdown && mdMode === "preview" ? (
        <MarkdownPreview content={content ?? ""} />
      ) : (
        <div className="flex-1 overflow-hidden min-h-0">
          <Editor
            height="100%"
            language={inlineLanguage ?? getMonacoLanguage(filePath ?? "")}
            value={content ?? ""}
            onChange={inlineContent != null ? undefined : handleChange}
            onMount={handleEditorMount}
            theme={monacoTheme}
            options={{
              fontSize: 13,
              fontFamily: "Menlo, Monaco, Consolas, monospace",
              wordWrap: wordWrap ? "on" : "off",
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              lineNumbers: "on",
              folding: true,
              bracketPairColorization: { enabled: true },
              readOnly: inlineContent != null,
            }}
            loading={<Loader2 className="size-5 animate-spin text-text-subtle" />}
          />
        </div>
      )}

      {/* Inline SQL result panel */}
      {isSql && (sqlResult || sqlError || sqlLoading) && (
        <SqlResultPanel
          result={sqlResult} error={sqlError} loading={sqlLoading}
          connName={selectedSqlConn?.name}
          onClose={() => { setSqlResult(null); setSqlError(null); setSqlLoading(false); }}
          onOpenInTab={openSqlResultInTab}
        />
      )}

      {/* Mobile toolbar — bottom, like terminal */}
      {isMobile && <EditorMobileToolbar editorRef={editorRef} readOnly={inlineContent != null} />}

      {/* Save As dialog for untitled tabs */}
      {showSaveAs && (
        <SaveAsDialog
          open={showSaveAs}
          defaultName={`Untitled-${metadata?.untitledNumber ?? 1}`}
          content={latestContentRef.current}
          onSave={handleSaveAs}
          onCancel={() => setShowSaveAs(false)}
        />
      )}
    </div>
  );
});

const NOOP = () => {};

/** Inline SQL result panel — shows query results below the editor */
function SqlResultPanel({ result, error, loading, connName, onClose, onOpenInTab }: {
  result: DbQueryResult | null;
  error: string | null;
  loading: boolean;
  connName?: string;
  onClose: () => void;
  onOpenInTab: () => void;
}) {
  const tableData = useMemo(() => (
    result?.changeType === "select" && result.rows.length > 0
      ? { columns: result.columns, rows: result.rows, total: result.rows.length, limit: result.rows.length }
      : null
  ), [result]);

  const querySchema = useMemo<GridColumnSchema[]>(() => (
    (result?.columns ?? []).map((c) => ({ name: c, type: "text", nullable: true, pk: false, defaultValue: null }))
  ), [result?.columns]);

  const [panelHeight, setPanelHeight] = useState(250);
  const handleDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = panelHeight;
    const onMove = (ev: MouseEvent) => setPanelHeight(Math.max(80, startH + (startY - ev.clientY)));
    const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [panelHeight]);

  return (
    <div className="shrink-0 border-t border-border flex flex-col" style={{ height: panelHeight }}>
      {/* Resize handle */}
      <div onMouseDown={handleDrag}
        className="shrink-0 h-1.5 cursor-row-resize bg-border/50 hover:bg-primary/30 flex items-center justify-center transition-colors">
        <GripHorizontal className="size-3 text-muted-foreground/50" />
      </div>
      {/* Title bar */}
      <div className="flex items-center gap-2 px-2 py-1 bg-muted/50 border-b border-border shrink-0">
        <Database className="size-3 text-muted-foreground" />
        <span className="text-xs font-medium text-foreground truncate flex-1">
          {connName ? `${connName} · Results` : "Query Results"}
          {result?.executionTimeMs != null && <span className="text-muted-foreground ml-1.5 font-normal">{result.executionTimeMs}ms</span>}
        </span>
        <button type="button" onClick={onOpenInTab} title="Open in DB Viewer tab"
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
          <ExternalLink className="size-3" />
          <span className="hidden sm:inline">Open in Tab</span>
        </button>
        <button type="button" onClick={onClose} title="Close results"
          className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors">
          <X className="size-3" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden min-h-0">
        {loading && (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        )}
        {error && <div className="px-3 py-2 text-xs text-destructive bg-destructive/5">{error}</div>}
        {result?.changeType === "modify" && (
          <div className="px-3 py-2 text-xs text-green-500">
            {result.rowsAffected} row(s) affected
          </div>
        )}
        {tableData && (
          <GlideDataGrid
            columns={tableData.columns} rows={tableData.rows} total={tableData.total} limit={tableData.limit}
            schema={querySchema} loading={false}
            page={1} onPageChange={NOOP} onCellUpdate={NOOP}
            orderBy={null} orderDir="ASC" onToggleSort={NOOP}
            connectionName={connName}
          />
        )}
        {result?.changeType === "select" && result.rows.length === 0 && (
          <div className="px-3 py-2 text-xs text-muted-foreground">No results</div>
        )}
      </div>
    </div>
  );
}

function LoadingSpinner() {
  return <div className="flex items-center justify-center h-full"><Loader2 className="size-5 animate-spin text-text-subtle" /></div>;
}

function MarkdownPreview({ content }: { content: string }) {
  return (
    <Suspense fallback={<div className="animate-pulse h-4 bg-muted rounded m-4" />}>
      <MarkdownRenderer content={content} className="flex-1 overflow-auto p-4" />
    </Suspense>
  );
}

