import { useEffect, useState, useCallback, useRef } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type * as MonacoType from "monaco-editor";
import { MarkdownRenderer } from "@/components/shared/markdown-renderer";
import { api, projectUrl, getAuthToken } from "@/lib/api-client";
import { useTabStore } from "@/stores/tab-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useMonacoTheme } from "@/lib/use-monaco-theme";
import { Loader2, FileWarning, ExternalLink, Code, Eye, WrapText } from "lucide-react";

/** Image extensions renderable inline */
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"]);

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
  const isMarkdown = ext === "md" || ext === "mdx";
  const [mdMode, setMdMode] = useState<"edit" | "preview">("preview");

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
    const baseName = filePath?.split("/").pop() ?? "Untitled";
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

  const handleEditorMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor;
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

  const mdModeButtons = isMarkdown ? (
    <>
      <button type="button" onClick={() => setMdMode("edit")}
        className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors ${mdMode === "edit" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
      >
        <Code className="size-3" /> Edit
      </button>
      <button type="button" onClick={() => setMdMode("preview")}
        className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors ${mdMode === "preview" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
      >
        <Eye className="size-3" /> Preview
      </button>
    </>
  ) : null;

  const wrapBtn = (
    <button type="button" onClick={toggleWordWrap} title="Toggle word wrap (Alt+Z)"
      className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors ${wordWrap ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
    >
      <WrapText className="size-3" />
      <span className="hidden sm:inline">Wrap</span>
    </button>
  );

  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      {isMarkdown && mdMode === "preview" ? (
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
