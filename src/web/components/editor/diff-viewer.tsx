import { useEffect, useState, useMemo, useRef } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { api, projectUrl } from "@/lib/api-client";
import { useShallow } from "zustand/react/shallow";
import { useSettingsStore } from "@/stores/settings-store";
import { useMonacoTheme } from "@/lib/use-monaco-theme";
import { EDITOR_FONT_FAMILY } from "@/lib/editor-font";
import { onHostResize } from "@/components/floating-window/pip/pip-resize-signal";
import { Loader2, FileCode, WrapText, UserRound } from "lucide-react";
import { useInlineBlame } from "@/hooks/use-inline-blame";

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
  const [fullFileDiff, setFullFileDiff] = useState<{ original: string; modified: string } | null>(null);
  const [loading, setLoading] = useState(!isInline);
  const [error, setError] = useState<string | null>(null);
  const { wordWrap, toggleWordWrap, mobileWordWrap, toggleMobileWordWrap } = useSettingsStore(
    useShallow((s) => ({
      wordWrap: s.wordWrap, toggleWordWrap: s.toggleWordWrap,
      mobileWordWrap: s.mobileWordWrap, toggleMobileWordWrap: s.toggleMobileWordWrap,
    })),
  );
  const monacoTheme = useMonacoTheme();

  // Measure container height — Monaco needs explicit pixel height on mobile
  const containerRef = useRef<HTMLDivElement>(null);
  const diffEditorRef = useRef<import("monaco-editor").editor.IStandaloneDiffEditor | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  // The two panes, as state rather than refs: the blame hooks have to re-run
  // once the editor exists. `focused` is which pane gets annotated — only one,
  // because both panes carry a cursor position and annotating both would leave a
  // stray line-1 annotation in the idle pane.
  //
  // It starts on the modified side rather than nothing: that is the side the
  // normal editor annotates, so turning blame on shows something immediately
  // instead of waiting for a click nobody knows to make.
  const [panes, setPanes] = useState<{
    monaco: typeof import("monaco-editor");
    original: import("monaco-editor").editor.ICodeEditor;
    modified: import("monaco-editor").editor.ICodeEditor;
  } | null>(null);
  const [focused, setFocused] = useState<"original" | "modified">("modified");
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

  // Host-driven resize (picture-in-picture): `automaticLayout` never fires for a
  // size driven by another document, and the editor keeps the PiP size after the
  // return. Re-runs on loading/error because the container renders only then.
  useEffect(
    () => onHostResize(containerRef.current, () => diffEditorRef.current?.layout()),
    [loading, error],
  );

  useEffect(() => {
    if (isInline) return;
    if (!projectName) return;
    setLoading(true);
    setError(null);
    setFullFileDiff(null);
    setFileContents(null);
    setDiffText(null);

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

    // Single-file diff → fetch FULL file contents on both sides (VSCode-style).
    // Monaco DiffEditor computes the diff itself, giving full-file view instead
    // of just the changed hunks + 3 lines of context that `git diff` returns.
    if (filePath) {
      const params = new URLSearchParams({ file: filePath });
      if (ref1) params.set("ref", ref1);
      if (ref2) params.set("ref2", ref2);
      api
        .get<{ original: string; modified: string }>(
          `${projectUrl(projectName)}/git/file-full-diff?${params}`,
        )
        .then((data) => { setFullFileDiff(data); setLoading(false); })
        .catch((err) => { setError(err instanceof Error ? err.message : "Failed to load diff"); setLoading(false); });
      return;
    }

    let url: string;
    if (ref1 || ref2) {
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
    if (fullFileDiff) return fullFileDiff;
    if (!diffText) return { original: "", modified: "" };
    return parseDiff(diffText);
  }, [diffText, isInline, inlineOriginal, inlineModified, isFileCompare, fileContents, fullFileDiff]);

  const language = useMemo(() => {
    const langFile = filePath ?? file2 ?? file1;
    return langFile ? getMonacoLanguage(langFile) : "plaintext";
  }, [filePath, file1, file2]);

  const inlineBlame = useSettingsStore((s) => s.inlineBlame);
  const toggleInlineBlame = useSettingsStore((s) => s.toggleInlineBlame);

  const isMobile = typeof window !== "undefined" && window.innerWidth < 768;
  // A phone wraps by default and keeps its own answer: the desktop pref is
  // shared across devices, and a 27-inch monitor's "no wrap" is not a 6-inch
  // screen's.
  const wrapOn = isMobile ? mobileWordWrap : wordWrap;
  const toggleWrap = isMobile ? toggleMobileWordWrap : toggleWordWrap;

  /**
   * Blame is only honest on the full-file path.
   *
   * `file-full-diff` hands back both sides as complete files at real revisions,
   * so a line number here is the line number git blamed. The other three paths
   * cannot be blamed: inline content and a two-file compare are not a tracked
   * path at a revision, and `parseDiff` rebuilds the file from hunks alone, so
   * its line 40 is not the file's line 40 — annotating it would confidently
   * name the wrong commit.
   */
  // Not on a phone: an annotation on every focused line is a `git blame` per
  // file and a `git show` per hover, on the device least able to pay for either.
  const canBlame = Boolean(projectName && filePath && fullFileDiff) && !isMobile;

  // The left pane is the file at `ref1` (the route defaults to HEAD); the right
  // is `ref2`, or the working tree when there is none.
  useInlineBlame({
    editor: panes?.original ?? null,
    monaco: panes?.monaco ?? null,
    projectName,
    filePath: canBlame ? filePath : undefined,
    rev: ref1 || "HEAD",
    enabled: inlineBlame && canBlame && focused === "original",
    readOnly: true,
  });
  useInlineBlame({
    editor: panes?.modified ?? null,
    monaco: panes?.monaco ?? null,
    projectName,
    filePath: canBlame ? filePath : undefined,
    rev: ref2,
    enabled: inlineBlame && canBlame && focused === "modified",
    readOnly: true,
  });

  // Force inline on mobile (<768px) since side-by-side is too narrow
  const renderSideBySide = !isMobile;

  // Sync word wrap on both sub-editors.
  // Monaco DiffEditor has a bug: during init when container width is 0,
  // useInlineViewWhenSpaceIsLimited briefly triggers inline mode which sets
  // wordWrapOverride2='off' on the original editor. When side-by-side resumes,
  // wordWrapOverride2 is never cleared, permanently blocking word wrap on the
  // left side. We disable that option and also force wordWrapOverride2 to clear it.
  useEffect(() => {
    const editor = diffEditorRef.current;
    if (!editor) return;
    const val: "on" | "off" = wrapOn ? "on" : "off";
    editor.updateOptions({ diffWordWrap: val });
    editor.getOriginalEditor().updateOptions({ wordWrapOverride2: val } as any);
    editor.getModifiedEditor().updateOptions({ wordWrapOverride2: val } as any);
  }, [wrapOn, editorReady]);

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
  if (!isInline && !isFileCompare && !fullFileDiff && !original && !modified) {
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
      <div className="flex items-center justify-end gap-0.5 px-2 py-0.5 border-b border-border shrink-0">
        {canBlame && (
          <button type="button" onClick={toggleInlineBlame}
            title="Inline blame (Alt+B) — who last touched the cursor's line. Click a pane to annotate that side."
            className={`flex items-center justify-center rounded hover:bg-muted active:scale-95 transition-colors p-1 ${
              inlineBlame ? "bg-muted text-foreground" : ""
            }`}
          >
            <UserRound className="size-3.5" />
          </button>
        )}
        <button type="button" onClick={toggleWrap}
          title={wrapOn ? "Wrapping long lines — tap to scroll sideways instead" : "Toggle word wrap"}
          className={`flex items-center justify-center rounded hover:bg-muted active:scale-95 transition-colors ${
            isMobile ? "size-11" : "p-1"
          } ${wrapOn ? "bg-muted text-foreground" : ""}`}
        >
          <WrapText className="size-3.5" />
        </button>
      </div>
      {/* Monaco DiffEditor */}
      <div ref={containerRef} className="flex-1 overflow-hidden">
        {containerHeight && containerHeight > 0 ? (
          <DiffEditor
            height={containerHeight}
            language={language}
            original={original}
            modified={modified}
            theme={monacoTheme}
            onMount={(editor, monaco) => {
              diffEditorRef.current = editor;
              setEditorReady(true);
              const originalPane = editor.getOriginalEditor();
              const modifiedPane = editor.getModifiedEditor();
              setPanes({ monaco, original: originalPane, modified: modifiedPane });
              originalPane.onDidFocusEditorText(() => setFocused("original"));
              modifiedPane.onDidFocusEditorText(() => setFocused("modified"));
              // Same shortcut as the normal editor. It goes on the diff editor,
              // not the panes: only IStandaloneDiffEditor has addCommand.
              editor.addCommand(
                monaco.KeyMod.Alt | monaco.KeyCode.KeyB,
                () => useSettingsStore.getState().toggleInlineBlame(),
              );
            }}
            options={{
              fontSize: isMobile ? 11 : 13,
              fontFamily: EDITOR_FONT_FAMILY,
              diffWordWrap: wrapOn ? "on" : "off",
              renderSideBySide,
              useInlineViewWhenSpaceIsLimited: false,
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
