import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type * as MonacoType from "monaco-editor";
import { MarkdownRenderer } from "@/components/shared/markdown-renderer";
import { api, projectUrl, getAuthToken } from "@/lib/api-client";
import { useTabStore } from "@/stores/tab-store";
import { useSettingsStore } from "@/stores/settings-store";
import { basename } from "@/lib/utils";
import { useMonacoTheme } from "@/lib/use-monaco-theme";
import { Loader2, FileWarning, ExternalLink, Play, Database } from "lucide-react";
import { EditorBreadcrumb } from "./editor-breadcrumb";
import { EditorToolbar } from "./editor-toolbar";
import { lazy, Suspense } from "react";
import { createSqlCompletionProvider, clearCompletionCache, type SchemaInfo } from "../database/sql-completion-provider";
import { useConnections, type Connection } from "../database/use-connections";

const CsvPreview = lazy(() => import("./csv-preview").then((m) => ({ default: m.CsvPreview })));

/** Image extensions renderable inline */
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"]);
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

export function CodeEditor({ metadata, tabId }: CodeEditorProps) {
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
  const { tabs, updateTab } = useTabStore();
  const { wordWrap, toggleWordWrap } = useSettingsStore();
  const monacoTheme = useMonacoTheme();

  const ownTab = tabs.find((t) => t.id === tabId);
  const ext = filePath ? getFileExt(filePath) : "";
  const isImage = IMAGE_EXTS.has(ext);
  const isPdf = ext === "pdf";
  const isSqlite = SQLITE_EXTS.has(ext);
  const isMarkdown = ext === "md" || ext === "mdx";
  const isCsv = ext === "csv";
  const isSql = ext === "sql";
  const [mdMode, setMdMode] = useState<"edit" | "preview">("preview");
  const [csvMode, setCsvMode] = useState<"table" | "raw">("table");

  // SQL file: connection picker + autocomplete + run in DB viewer
  const { connections, cachedTables, refreshTables } = useConnections();
  const [sqlConnId, setSqlConnId] = useState<number | null>(() => {
    if (!isSql || !filePath) return null;
    const stored = localStorage.getItem(`ppm:sql-conn:${filePath}`);
    return stored ? Number(stored) : null;
  });
  const monacoInstanceRef = useRef<typeof MonacoType | null>(null);
  const completionDisposable = useRef<MonacoType.IDisposable | null>(null);

  const selectedSqlConn = useMemo(() => connections.find((c) => c.id === sqlConnId) ?? null, [connections, sqlConnId]);

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

  // Run in DB Viewer
  const openTab = useTabStore((s) => s.openTab);
  const runSqlInViewer = useCallback((sqlText: string) => {
    if (!selectedSqlConn) return;
    openTab({
      type: "database",
      title: `${selectedSqlConn.name} · Query`,
      projectId: null,
      closable: true,
      metadata: { connectionId: selectedSqlConn.id, connectionName: selectedSqlConn.name, dbType: selectedSqlConn.type, initialSql: sqlText },
    });
  }, [selectedSqlConn, openTab]);

  const handleRunInDbViewer = useCallback(() => {
    if (!editorRef.current || !selectedSqlConn) return;
    const editor = editorRef.current;
    const selection = editor.getSelection();
    const sqlText = selection && !selection.isEmpty()
      ? editor.getModel()?.getValueInRange(selection) ?? editor.getValue()
      : editor.getValue();
    runSqlInViewer(sqlText);
  }, [selectedSqlConn, runSqlInViewer]);

  // CodeLens: inline Run buttons between SQL statements
  const codeLensDisposable = useRef<MonacoType.IDisposable[]>([]);
  const runSqlRef = useRef(runSqlInViewer);
  runSqlRef.current = runSqlInViewer;

  // Redirect .db files to sqlite viewer by changing tab type
  useEffect(() => {
    if (isSqlite && tabId) updateTab(tabId, { type: "sqlite" });
  }, [isSqlite, tabId, updateTab]);

  // Detect external (absolute) file path — not relative to project
  const isExternalFile = filePath ? /^(\/|[A-Za-z]:[/\\])/.test(filePath) : false;

  // Load file content
  useEffect(() => {
    if (inlineContent != null) { setLoading(false); return; }
    if (!filePath) return;
    if (!isExternalFile && !projectName) return;
    if (isImage || isPdf) { setLoading(false); return; }

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
  }, [filePath, projectName, isImage, isPdf, isExternalFile]);

  // Update tab title unsaved indicator
  useEffect(() => {
    if (!ownTab) return;
    const baseName = filePath ? basename(filePath) : "Untitled";
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
    saveTimerRef.current = setTimeout(() => saveFile(latestContentRef.current), 1000);
  }

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

    // Register CodeLens for inline Run buttons on .sql files
    if (isSql) {
      codeLensDisposable.current.forEach((d) => d.dispose());
      codeLensDisposable.current = [];

      const cmdId = editor.addCommand(0, (_accessor: unknown, sql: string) => {
        if (sql) runSqlRef.current(sql);
      });

      if (cmdId) {
        const provider = monaco.languages.registerCodeLensProvider("sql", {
          provideCodeLenses: (model: MonacoType.editor.ITextModel) => {
            const lenses: MonacoType.languages.CodeLens[] = [];
            const lines = model.getValue().split("\n");
            let stmtStartLine = -1;
            let stmtLines: string[] = [];

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
              if (trimmed.endsWith(";")) {
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

  if (!inlineContent && (!filePath || (!isExternalFile && !projectName))) {
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

  if (isImage) return <ImagePreview filePath={filePath!} projectName={projectName!} />;
  if (isPdf) return <PdfPreview filePath={filePath!} projectName={projectName!} />;

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
        title="Run all in DB Viewer"
      >
        <Play className="size-3.5" />
      </button>
    </div>
  ) : null;

  // Beautify for inline content
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

  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
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
        <div className="flex-1 overflow-hidden">
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
    </div>
  );
}

function MarkdownPreview({ content }: { content: string }) {
  return <MarkdownRenderer content={content} className="flex-1 overflow-auto p-4" />;
}

function ImagePreview({ filePath, projectName }: { filePath: string; projectName: string }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let revoke: string | undefined;
    const url = `${projectUrl(projectName)}/files/raw?path=${encodeURIComponent(filePath)}`;
    const token = getAuthToken();
    fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => { if (!r.ok) throw new Error("Failed"); return r.blob(); })
      .then((blob) => { const u = URL.createObjectURL(blob); revoke = u; setBlobUrl(u); })
      .catch(() => setError(true));
    return () => { if (revoke) URL.revokeObjectURL(revoke); };
  }, [filePath, projectName]);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-text-secondary">
        <FileWarning className="size-10 text-text-subtle" />
        <p className="text-sm">Failed to load image.</p>
      </div>
    );
  }
  if (!blobUrl) {
    return <div className="flex items-center justify-center h-full"><Loader2 className="size-5 animate-spin text-text-subtle" /></div>;
  }
  return (
    <div className="flex items-center justify-center h-full p-4 bg-surface overflow-auto">
      <img src={blobUrl} alt={filePath} className="max-w-full max-h-full object-contain" />
    </div>
  );
}

function PdfPreview({ filePath, projectName }: { filePath: string; projectName: string }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let revoke: string | undefined;
    const url = `${projectUrl(projectName)}/files/raw?path=${encodeURIComponent(filePath)}`;
    const token = getAuthToken();
    fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => { if (!r.ok) throw new Error("Failed"); return r.blob(); })
      .then((blob) => {
        const u = URL.createObjectURL(new Blob([blob], { type: "application/pdf" }));
        revoke = u; setBlobUrl(u);
      })
      .catch(() => setError(true));
    return () => { if (revoke) URL.revokeObjectURL(revoke); };
  }, [filePath, projectName]);

  const openInNewTab = useCallback(() => { if (blobUrl) window.open(blobUrl, "_blank"); }, [blobUrl]);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-text-secondary">
        <FileWarning className="size-10 text-text-subtle" />
        <p className="text-sm">Failed to load PDF.</p>
      </div>
    );
  }
  if (!blobUrl) {
    return <div className="flex items-center justify-center h-full"><Loader2 className="size-5 animate-spin text-text-subtle" /></div>;
  }
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-background shrink-0">
        <span className="text-xs text-text-secondary truncate">{filePath}</span>
        <button onClick={openInNewTab} className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors">
          <ExternalLink className="size-3" /> Open in new tab
        </button>
      </div>
      <iframe src={blobUrl} title={filePath} className="flex-1 w-full border-none" />
    </div>
  );
}
