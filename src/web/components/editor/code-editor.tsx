import { useEffect, useState, useCallback, useRef } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type * as MonacoType from "monaco-editor";
import { MarkdownRenderer } from "@/components/shared/markdown-renderer";
import { api, projectUrl, getAuthToken } from "@/lib/api-client";
import { useTabStore } from "@/stores/tab-store";
import { useSettingsStore } from "@/stores/settings-store";
import { basename } from "@/lib/utils";
import { useMonacoTheme } from "@/lib/use-monaco-theme";
import { Loader2, FileWarning, ExternalLink } from "lucide-react";
import { EditorBreadcrumb } from "./editor-breadcrumb";
import { EditorToolbar } from "./editor-toolbar";
import { lazy, Suspense } from "react";

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
  const [content, setContent] = useState<string | null>(null);
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
  const [mdMode, setMdMode] = useState<"edit" | "preview">("preview");
  const [csvMode, setCsvMode] = useState<"table" | "raw">("table");

  // Redirect .db files to sqlite viewer by changing tab type
  useEffect(() => {
    if (isSqlite && tabId) updateTab(tabId, { type: "sqlite" });
  }, [isSqlite, tabId, updateTab]);

  // Detect external (absolute) file path — not relative to project
  const isExternalFile = filePath ? /^(\/|[A-Za-z]:[/\\])/.test(filePath) : false;

  // Load file content
  useEffect(() => {
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
    if (lineNumber && lineNumber > 0) {
      // Defer until content is rendered
      setTimeout(() => {
        editor.revealLineInCenter(lineNumber);
        editor.setPosition({ lineNumber, column: 1 });
        editor.focus();
      }, 100);
    }
    // Alt+Z → toggle word wrap
    editor.addCommand(
      monaco.KeyMod.Alt | monaco.KeyCode.KeyZ,
      () => useSettingsStore.getState().toggleWordWrap(),
    );
    // Disable all diagnostics — PPM is a lightweight editor, not a full IDE
    monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: true,
      noSuggestionDiagnostics: true,
    });
    monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: true,
      noSuggestionDiagnostics: true,
    });
  }, []);

  if (!filePath || (!isExternalFile && !projectName)) {
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

  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      {/* Breadcrumb + Toolbar bar — desktop only */}
      {filePath && projectName && tabId && (
        <div className="hidden md:flex items-center h-7 border-b border-border bg-background shrink-0">
          <EditorBreadcrumb
            filePath={filePath}
            projectName={projectName}
            tabId={tabId}
            className="flex items-center flex-1 min-w-0 overflow-x-auto scrollbar-none px-2 gap-0.5"
          />
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
            language={getMonacoLanguage(filePath)}
            value={content ?? ""}
            onChange={handleChange}
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
