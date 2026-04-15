import { useEffect, useState, useMemo, useRef } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { api, projectUrl } from "@/lib/api-client";
import { useShallow } from "zustand/react/shallow";
import { useSettingsStore } from "@/stores/settings-store";
import { useMonacoTheme } from "@/lib/use-monaco-theme";
import { Loader2, FileCode, PanelLeftOpen, PanelRightOpen, Columns2, WrapText } from "lucide-react";

function getMonacoLanguage(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
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

interface DiffViewerProps {
  metadata?: Record<string, unknown>;
}

export function DiffViewer({ metadata }: DiffViewerProps) {
  const filePath = metadata?.filePath as string | undefined;
  const projectName = metadata?.projectName as string | undefined;
  const ref1 = metadata?.ref1 as string | undefined;
  const ref2 = metadata?.ref2 as string | undefined;
  const file1 = metadata?.file1 as string | undefined;
  const file2 = metadata?.file2 as string | undefined;
  const inlineOriginal = metadata?.original as string | undefined;
  const inlineModified = metadata?.modified as string | undefined;
  const isInline = inlineOriginal != null || inlineModified != null;
  const isFileCompare = Boolean(file1 && file2);

  const [diffText, setDiffText] = useState<string | null>(null);
  const [fileContents, setFileContents] = useState<{ original: string; modified: string } | null>(null);
  const [loading, setLoading] = useState(!isInline);
  const [error, setError] = useState<string | null>(null);
  const [expandMode, setExpandMode] = useState<"both" | "left" | "right">("both");
  const { wordWrap, toggleWordWrap } = useSettingsStore(useShallow((s) => ({ wordWrap: s.wordWrap, toggleWordWrap: s.toggleWordWrap })));
  const monacoTheme = useMonacoTheme();

  // Measure container height — Monaco needs explicit pixel height on mobile
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerHeight, setContainerHeight] = useState<number | undefined>();

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setContainerHeight(Math.floor(entry.contentRect.height));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [loading, error]);

  useEffect(() => {
    if (isInline) return;
    if (!projectName) return;
    setLoading(true);
    setError(null);

    if (file1 && file2) {
      const params = new URLSearchParams({ file1, file2 });
      api
        .get<{ original: string; modified: string }>(
          `${projectUrl(projectName)}/files/compare?${params}`,
        )
        .then((data) => { setFileContents(data); setLoading(false); })
        .catch((err) => { setError(err instanceof Error ? err.message : "Failed to compare files"); setLoading(false); });
      return;
    }

    let url: string;
    if (filePath) {
      const params = new URLSearchParams({ file: filePath });
      if (ref1) params.set("ref", ref1);
      url = `${projectUrl(projectName)}/git/file-diff?${params}`;
    } else if (ref1 || ref2) {
      const params = new URLSearchParams();
      if (ref1) params.set("ref1", ref1);
      if (ref2) params.set("ref2", ref2);
      url = `${projectUrl(projectName)}/git/diff?${params}`;
    } else {
      url = `${projectUrl(projectName)}/git/diff`;
    }

    api
      .get<{ diff: string }>(url)
      .then((data) => { setDiffText(data.diff); setLoading(false); })
      .catch((err) => { setError(err instanceof Error ? err.message : "Failed to load diff"); setLoading(false); });
  }, [filePath, projectName, ref1, ref2, file1, file2, isInline]);

  const { original, modified } = useMemo(() => {
    if (isInline) return { original: inlineOriginal ?? "", modified: inlineModified ?? "" };
    if (isFileCompare && fileContents) return fileContents;
    if (!diffText) return { original: "", modified: "" };
    return parseDiff(diffText);
  }, [diffText, isInline, inlineOriginal, inlineModified, isFileCompare, fileContents]);

  const language = useMemo(() => {
    const langFile = filePath ?? file2 ?? file1;
    return langFile ? getMonacoLanguage(langFile) : "plaintext";
  }, [filePath, file1, file2]);

  // Force inline on mobile (<768px) since side-by-side is too narrow
  const isMobile = typeof window !== "undefined" && window.innerWidth < 768;
  const renderSideBySide = !isMobile && expandMode === "both";

  if (!projectName && !isInline) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        No project selected.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full gap-2 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
        <span className="text-sm">Loading diff...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-destructive text-sm">{error}</div>
    );
  }

  // Catch diffs with metadata-only changes (mode, rename) where parseDiff returns empty
  if (!isInline && !isFileCompare && !original && !modified) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
        <FileCode className="size-8" />
        <p className="text-sm">No content changes</p>
        {filePath && <p className="text-xs font-mono">{filePath}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      {!isMobile && (
        <div className="flex items-center justify-end gap-0.5 px-2 py-0.5 border-b border-border shrink-0">
          <button type="button"
            onClick={() => setExpandMode(expandMode === "left" ? "both" : "left")}
            className={`p-1 rounded hover:bg-muted transition-colors ${expandMode === "left" ? "bg-muted text-foreground" : ""}`}
            title="Expand original"
          >
            <PanelLeftOpen className="size-3.5" />
          </button>
          <button type="button"
            onClick={() => setExpandMode("both")}
            className={`p-1 rounded hover:bg-muted transition-colors ${expandMode === "both" ? "bg-muted text-foreground" : ""}`}
            title="Side by side"
          >
            <Columns2 className="size-3.5" />
          </button>
          <button type="button"
            onClick={() => setExpandMode(expandMode === "right" ? "both" : "right")}
            className={`p-1 rounded hover:bg-muted transition-colors ${expandMode === "right" ? "bg-muted text-foreground" : ""}`}
            title="Expand modified"
          >
            <PanelRightOpen className="size-3.5" />
          </button>
          <div className="w-px h-3.5 bg-border mx-0.5 shrink-0" />
          <button type="button" onClick={toggleWordWrap} title="Toggle word wrap"
            className={`p-1 rounded hover:bg-muted transition-colors ${wordWrap ? "bg-muted text-foreground" : ""}`}
          >
            <WrapText className="size-3.5" />
          </button>
        </div>
      )}
      {/* Monaco DiffEditor */}
      <div ref={containerRef} className="flex-1 overflow-hidden">
        {containerHeight && containerHeight > 0 ? (
          <DiffEditor
            height={containerHeight}
            language={language}
            original={original}
            modified={modified}
            theme={monacoTheme}
            options={{
              fontSize: isMobile ? 11 : 13,
              fontFamily: "Menlo, Monaco, Consolas, monospace",
              wordWrap: isMobile ? "on" : wordWrap ? "on" : "off",
              renderSideBySide,
              readOnly: true,
              automaticLayout: true,
              scrollBeyondLastLine: false,
            }}
            loading={<Loader2 className="size-5 animate-spin text-muted-foreground" />}
          />
        ) : (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}
      </div>
    </div>
  );
}

function parseDiff(diff: string): { original: string; modified: string } {
  const lines = diff.split("\n");
  const originalLines: string[] = [];
  const modifiedLines: string[] = [];
  let inHunk = false;

  for (const line of lines) {
    if (
      line.startsWith("diff --git") || line.startsWith("diff --no-index") ||
      line.startsWith("index ") || line.startsWith("new file") ||
      line.startsWith("deleted file") || line.startsWith("old mode") ||
      line.startsWith("new mode") || line.startsWith("---") ||
      line.startsWith("+++") || line.startsWith("Binary files") ||
      line.startsWith("\\ No newline")
    ) continue;

    if (line.startsWith("@@")) { inHunk = true; continue; }
    if (!inHunk) continue;

    if (line.startsWith("-")) {
      originalLines.push(line.slice(1));
    } else if (line.startsWith("+")) {
      modifiedLines.push(line.slice(1));
    } else {
      const content = line.startsWith(" ") ? line.slice(1) : line;
      originalLines.push(content);
      modifiedLines.push(content);
    }
  }

  return { original: originalLines.join("\n"), modified: modifiedLines.join("\n") };
}
