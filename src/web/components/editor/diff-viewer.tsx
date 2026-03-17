import { useEffect, useState, useMemo, useRef } from "react";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, lineNumbers } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { MergeView } from "@codemirror/merge";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import type { Extension } from "@codemirror/state";
import { api, projectUrl } from "@/lib/api-client";
import { useSettingsStore } from "@/stores/settings-store";
import { Loader2, FileCode, PanelLeftOpen, PanelRightOpen, Columns2, WrapText } from "lucide-react";

function getLanguageExtension(filename: string): Extension | null {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
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
  /** "both" | "left" | "right" — controls which diff panel is expanded */
  const [expandMode, setExpandMode] = useState<"both" | "left" | "right">("both");
  const { wordWrap, toggleWordWrap } = useSettingsStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const mergeViewRef = useRef<MergeView | null>(null);

  useEffect(() => {
    if (isInline) return; // No fetch needed for inline diffs
    if (!projectName) return;
    setLoading(true);
    setError(null);

    if (file1 && file2) {
      const params = new URLSearchParams();
      params.set("file1", file1);
      params.set("file2", file2);
      api
        .get<{ original: string; modified: string }>(
          `${projectUrl(projectName)}/files/compare?${params.toString()}`,
        )
        .then((data) => { setFileContents(data); setLoading(false); })
        .catch((err) => { setError(err instanceof Error ? err.message : "Failed to compare files"); setLoading(false); });
      return;
    }

    let url: string;
    if (filePath) {
      const params = new URLSearchParams();
      params.set("file", filePath);
      if (ref1) params.set("ref", ref1);
      url = `${projectUrl(projectName)}/git/file-diff?${params.toString()}`;
    } else if (ref1 || ref2) {
      const params = new URLSearchParams();
      if (ref1) params.set("ref1", ref1);
      if (ref2) params.set("ref2", ref2);
      url = `${projectUrl(projectName)}/git/diff?${params.toString()}`;
    } else {
      url = `${projectUrl(projectName)}/git/diff`;
    }

    api
      .get<{ diff: string }>(url)
      .then((data) => { setDiffText(data.diff); setLoading(false); })
      .catch((err) => { setError(err instanceof Error ? err.message : "Failed to load diff"); setLoading(false); });
  }, [filePath, projectName, ref1, ref2, file1, file2]);

  const { original, modified } = useMemo(() => {
    if (isInline) return { original: inlineOriginal ?? "", modified: inlineModified ?? "" };
    if (isFileCompare && fileContents) return fileContents;
    if (!diffText) return { original: "", modified: "" };
    return parseDiff(diffText);
  }, [diffText, isInline, inlineOriginal, inlineModified, isFileCompare, fileContents]);

  const langExts = useMemo(() => {
    const langFile = filePath ?? file2 ?? file1;
    if (!langFile) return [];
    const ext = getLanguageExtension(langFile);
    return ext ? [ext] : [];
  }, [filePath, file1, file2]);

  // Create MergeView when content is ready
  useEffect(() => {
    const container = containerRef.current;
    if (!container || loading || error) return;
    if (!original && !modified) return;

    // Clean up previous
    if (mergeViewRef.current) {
      mergeViewRef.current.destroy();
      mergeViewRef.current = null;
    }

    const isMobile = window.innerWidth < 768;
    const sharedExts: Extension[] = [
      ...langExts,
      oneDark,
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      lineNumbers(),
      ...(wordWrap ? [EditorView.lineWrapping] : []),
      EditorView.theme({
        "&": { fontSize: "13px", fontFamily: "var(--font-mono)" },
        // Character-level highlight: bold background, NO underline
        "& .cm-changedText": {
          textDecoration: "none !important",
          borderBottom: "none !important",
          textDecorationLine: "none !important",
          backgroundColor: "rgba(16, 185, 129, 0.4) !important",
          borderRadius: "2px",
        },
        "& .cm-deletedChunk .cm-changedText": {
          backgroundColor: "rgba(239, 68, 68, 0.4) !important",
        },
      }),
    ];

    const mv = new MergeView({
      parent: container,
      a: { doc: original, extensions: sharedExts },
      b: { doc: modified, extensions: sharedExts },
      orientation: "a-b",
      revertControls: undefined,
      highlightChanges: true, // Highlight changed characters within a line
      gutter: true,
    });

    mergeViewRef.current = mv;

    // Sync horizontal scroll between both editors
    const scrollerA = mv.a.dom.querySelector(".cm-scroller") as HTMLElement | null;
    const scrollerB = mv.b.dom.querySelector(".cm-scroller") as HTMLElement | null;
    let syncing = false;
    const syncScroll = (source: HTMLElement, target: HTMLElement) => {
      if (syncing) return;
      syncing = true;
      target.scrollLeft = source.scrollLeft;
      syncing = false;
    };
    const onScrollA = () => scrollerA && scrollerB && syncScroll(scrollerA, scrollerB);
    const onScrollB = () => scrollerA && scrollerB && syncScroll(scrollerB, scrollerA);
    scrollerA?.addEventListener("scroll", onScrollA);
    scrollerB?.addEventListener("scroll", onScrollB);

    return () => {
      scrollerA?.removeEventListener("scroll", onScrollA);
      scrollerB?.removeEventListener("scroll", onScrollB);
      mv.destroy();
      mergeViewRef.current = null;
    };
  }, [original, modified, langExts, loading, error, wordWrap]);

  // Apply expand mode by hiding left/right editor panels via CSS
  useEffect(() => {
    const mv = mergeViewRef.current;
    if (!mv) return;
    // MergeView exposes .a (left) and .b (right) EditorView instances
    const leftPanel = mv.a.dom.closest(".cm-mergeViewEditor") as HTMLElement | null ?? mv.a.dom.parentElement;
    const rightPanel = mv.b.dom.closest(".cm-mergeViewEditor") as HTMLElement | null ?? mv.b.dom.parentElement;
    const container = containerRef.current;
    const gutter = container?.querySelector<HTMLElement>(".cm-mergeViewGutter");

    if (leftPanel) {
      leftPanel.style.display = expandMode === "right" ? "none" : "";
      leftPanel.style.flex = expandMode === "left" ? "1" : "";
    }
    if (rightPanel) {
      rightPanel.style.display = expandMode === "left" ? "none" : "";
      rightPanel.style.flex = expandMode === "right" ? "1" : "";
    }
    if (gutter) gutter.style.display = expandMode !== "both" ? "none" : "";
  }, [expandMode, original, modified]);

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
      <div className="flex items-center justify-center h-full text-destructive text-sm">
        {error}
      </div>
    );
  }

  if (!isInline && !isFileCompare && (!diffText || diffText.trim() === "") && !original && !modified) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
        <FileCode className="size-8" />
        <p className="text-sm">No changes detected</p>
        {filePath && <p className="text-xs font-mono">{filePath}</p>}
      </div>
    );
  }

  const expandToggle = (
    <div className="flex items-center gap-0.5 shrink-0">
      <button
        type="button"
        onClick={() => setExpandMode(expandMode === "left" ? "both" : "left")}
        className={`p-1 rounded hover:bg-muted transition-colors ${expandMode === "left" ? "bg-muted text-foreground" : ""}`}
        title="Expand original"
      >
        <PanelLeftOpen className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={() => setExpandMode("both")}
        className={`p-1 rounded hover:bg-muted transition-colors ${expandMode === "both" ? "bg-muted text-foreground" : ""}`}
        title="Side by side"
      >
        <Columns2 className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={() => setExpandMode(expandMode === "right" ? "both" : "right")}
        className={`p-1 rounded hover:bg-muted transition-colors ${expandMode === "right" ? "bg-muted text-foreground" : ""}`}
        title="Expand modified"
      >
        <PanelRightOpen className="size-3.5" />
      </button>
      <div className="w-px h-3.5 bg-border mx-0.5 shrink-0" />
      <button
        type="button"
        onClick={toggleWordWrap}
        title="Toggle word wrap"
        className={`p-1 rounded hover:bg-muted transition-colors ${wordWrap ? "bg-muted text-foreground" : ""}`}
      >
        <WrapText className="size-3.5" />
      </button>
    </div>
  );

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b text-xs text-muted-foreground">
        <FileCode className="size-3.5" />
        {isFileCompare ? (
          <span className="font-mono truncate flex-1">{file1} vs {file2}</span>
        ) : (
          <span className="flex-1 truncate">
            <span className="font-mono">{filePath ?? "Working tree changes"}</span>
            {(ref1 || ref2) && (
              <span> ({ref1?.slice(0, 7) ?? "HEAD"} vs {ref2?.slice(0, 7) ?? "working tree"})</span>
            )}
          </span>
        )}
        {/* Desktop: expand toggle in header */}
        <div className="hidden md:block">{expandToggle}</div>
      </div>

      {/* MergeView container — side-by-side, pinch-zoom on mobile */}
      <div
        ref={containerRef}
        className="flex-1 overflow-auto touch-pinch-zoom [&_.cm-mergeView]:h-full"
        style={{ WebkitOverflowScrolling: "touch" }}
      />

      {/* Mobile: expand toggle at bottom */}
      <div className="md:hidden flex justify-center border-t py-1 bg-background shrink-0">
        {expandToggle}
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
      line.startsWith("diff --git") ||
      line.startsWith("diff --no-index") ||
      line.startsWith("index ") ||
      line.startsWith("new file") ||
      line.startsWith("deleted file") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode") ||
      line.startsWith("---") ||
      line.startsWith("+++") ||
      line.startsWith("Binary files") ||
      line.startsWith("\\ No newline")
    ) continue;

    if (line.startsWith("@@")) { inHunk = true; continue; }
    if (!inHunk) continue;

    if (line.startsWith("-")) {
      originalLines.push(line.slice(1));
    } else if (line.startsWith("+")) {
      modifiedLines.push(line.slice(1));
    } else if (line.startsWith(" ") || line === "") {
      const content = line.startsWith(" ") ? line.slice(1) : line;
      originalLines.push(content);
      modifiedLines.push(content);
    }
  }

  return { original: originalLines.join("\n"), modified: modifiedLines.join("\n") };
}
