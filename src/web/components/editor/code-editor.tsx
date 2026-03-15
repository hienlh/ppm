import { useEffect, useState, useCallback, useRef } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { oneDark } from "@codemirror/theme-one-dark";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import type { Extension } from "@codemirror/state";
import { api, projectUrl, getAuthToken } from "@/lib/api-client";
import { useTabStore } from "@/stores/tab-store";
import { Loader2, FileWarning, ExternalLink } from "lucide-react";

/** Image extensions renderable inline */
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"]);

/** PDF extension */
const PDF_EXT = "pdf";

function getFileExt(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

function getLanguageExtension(filename: string): Extension | null {
  const ext = getFileExt(filename);
  switch (ext) {
    case "js":
    case "jsx":
      return javascript({ jsx: true });
    case "ts":
    case "tsx":
      return javascript({ jsx: true, typescript: true });
    case "py":
      return python();
    case "html":
      return html();
    case "css":
    case "scss":
      return css();
    case "json":
      return json();
    case "md":
    case "mdx":
      return markdown();
    default:
      return null;
  }
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
  const { tabs, updateTab } = useTabStore();

  const ownTab = tabs.find((t) => t.id === tabId);
  const ext = filePath ? getFileExt(filePath) : "";
  const isImage = IMAGE_EXTS.has(ext);
  const isPdf = ext === PDF_EXT;

  // Load file content
  useEffect(() => {
    if (!filePath || !projectName) return;
    // Skip loading for images and PDFs — they use raw endpoint
    if (isImage || isPdf) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    api
      .get<{ content: string; encoding: string }>(
        `${projectUrl(projectName)}/files/read?path=${encodeURIComponent(filePath)}`,
      )
      .then((data) => {
        setContent(data.content);
        setEncoding(data.encoding);
        latestContentRef.current = data.content;
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load file");
        setLoading(false);
      });

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [filePath, projectName, isImage, isPdf]);

  // Update tab title unsaved indicator
  useEffect(() => {
    if (!ownTab) return;
    const baseName = filePath?.split("/").pop() ?? "Untitled";
    const newTitle = unsaved ? `${baseName} \u25CF` : baseName;
    if (ownTab.title !== newTitle) {
      updateTab(ownTab.id, { title: newTitle });
    }
  }, [unsaved]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveFile = useCallback(
    async (text: string) => {
      if (!filePath || !projectName) return;
      try {
        await api.put(`${projectUrl(projectName)}/files/write`, {
          path: filePath,
          content: text,
        });
        setUnsaved(false);
      } catch {
        // Silent save failure — user sees unsaved indicator persists
      }
    },
    [filePath, projectName],
  );

  function handleChange(value: string) {
    setContent(value);
    latestContentRef.current = value;
    setUnsaved(true);

    // Debounced auto-save (1s)
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveFile(latestContentRef.current);
    }, 1000);
  }

  if (!filePath || !projectName) {
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
      <div className="flex items-center justify-center h-full text-error text-sm">
        {error}
      </div>
    );
  }

  // --- Image preview ---
  if (isImage) {
    return <ImagePreview filePath={filePath} projectName={projectName} />;
  }

  // --- PDF viewer ---
  if (isPdf) {
    return <PdfPreview filePath={filePath} projectName={projectName} />;
  }

  // --- Binary file (base64 encoding) — cannot edit ---
  if (encoding === "base64") {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-text-secondary">
        <FileWarning className="size-10 text-text-subtle" />
        <p className="text-sm">This file is a binary format and cannot be displayed.</p>
        <p className="text-xs text-text-subtle">{filePath}</p>
      </div>
    );
  }

  // --- Text editor ---
  const extensions: Extension[] = [];
  const langExt = getLanguageExtension(filePath);
  if (langExt) extensions.push(langExt);

  return (
    <div className="h-full w-full overflow-hidden">
      <CodeMirror
        value={content ?? ""}
        onChange={handleChange}
        extensions={extensions}
        theme={oneDark}
        height="100%"
        style={{ height: "100%", fontSize: "13px", fontFamily: "var(--font-mono)" }}
        basicSetup={{
          lineNumbers: true,
          foldGutter: true,
          autocompletion: true,
          bracketMatching: true,
          closeBrackets: true,
          highlightActiveLine: true,
          indentOnInput: true,
        }}
      />
    </div>
  );
}

/** Inline image preview with auth */
function ImagePreview({ filePath, projectName }: { filePath: string; projectName: string }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let revoke: string | undefined;
    const url = `${projectUrl(projectName)}/files/raw?path=${encodeURIComponent(filePath)}`;
    const token = getAuthToken();
    fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => {
        if (!r.ok) throw new Error("Failed");
        return r.blob();
      })
      .then((blob) => {
        const objUrl = URL.createObjectURL(blob);
        revoke = objUrl;
        setBlobUrl(objUrl);
      })
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
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="size-5 animate-spin text-text-subtle" />
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center h-full p-4 bg-surface overflow-auto">
      <img src={blobUrl} alt={filePath} className="max-w-full max-h-full object-contain" />
    </div>
  );
}

/** PDF preview — fetches with auth, opens blob in iframe or new tab */
function PdfPreview({ filePath, projectName }: { filePath: string; projectName: string }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let revoke: string | undefined;
    const url = `${projectUrl(projectName)}/files/raw?path=${encodeURIComponent(filePath)}`;
    const token = getAuthToken();
    fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => {
        if (!r.ok) throw new Error("Failed");
        return r.blob();
      })
      .then((blob) => {
        const objUrl = URL.createObjectURL(new Blob([blob], { type: "application/pdf" }));
        revoke = objUrl;
        setBlobUrl(objUrl);
      })
      .catch(() => setError(true));
    return () => { if (revoke) URL.revokeObjectURL(revoke); };
  }, [filePath, projectName]);

  const openInNewTab = useCallback(() => {
    if (blobUrl) window.open(blobUrl, "_blank");
  }, [blobUrl]);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-text-secondary">
        <FileWarning className="size-10 text-text-subtle" />
        <p className="text-sm">Failed to load PDF.</p>
      </div>
    );
  }

  if (!blobUrl) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="size-5 animate-spin text-text-subtle" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-background shrink-0">
        <span className="text-xs text-text-secondary truncate">{filePath}</span>
        <button
          onClick={openInNewTab}
          className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors"
        >
          <ExternalLink className="size-3" />
          Open in new tab
        </button>
      </div>
      {/* Embedded PDF viewer */}
      <iframe
        src={blobUrl}
        title={filePath}
        className="flex-1 w-full border-none"
      />
    </div>
  );
}
