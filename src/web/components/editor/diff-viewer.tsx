import { useEffect, useState, useMemo } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { unifiedMergeView } from "@codemirror/merge";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import type { Extension } from "@codemirror/state";
import { api } from "@/lib/api-client";
import { Loader2, FileCode } from "lucide-react";

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

/**
 * Git diff viewer using @codemirror/merge unifiedMergeView.
 * Parses unified diff to extract original/modified content and renders inline.
 */
export function DiffViewer({ metadata }: DiffViewerProps) {
  const filePath = metadata?.filePath as string | undefined;
  const projectName = metadata?.projectName as string | undefined;
  const ref1 = metadata?.ref1 as string | undefined;
  const ref2 = metadata?.ref2 as string | undefined;
  // File-to-file compare mode
  const file1 = metadata?.file1 as string | undefined;
  const file2 = metadata?.file2 as string | undefined;
  const isFileCompare = Boolean(file1 && file2);

  const [diffText, setDiffText] = useState<string | null>(null);
  const [fileContents, setFileContents] = useState<{ original: string; modified: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectName) return;
    setLoading(true);
    setError(null);

    // File-to-file compare mode
    if (file1 && file2) {
      const params = new URLSearchParams();
      params.set("file1", file1);
      params.set("file2", file2);
      api
        .get<{ original: string; modified: string }>(
          `/api/files/compare/${encodeURIComponent(projectName)}?${params.toString()}`,
        )
        .then((data) => {
          setFileContents(data);
          setLoading(false);
        })
        .catch((err) => {
          setError(err instanceof Error ? err.message : "Failed to compare files");
          setLoading(false);
        });
      return;
    }

    let url: string;
    if (filePath) {
      const params = new URLSearchParams();
      params.set("file", filePath);
      if (ref1) params.set("ref", ref1);
      url = `/api/git/file-diff/${encodeURIComponent(projectName)}?${params.toString()}`;
    } else if (ref1 || ref2) {
      const params = new URLSearchParams();
      if (ref1) params.set("ref1", ref1);
      if (ref2) params.set("ref2", ref2);
      url = `/api/git/diff/${encodeURIComponent(projectName)}?${params.toString()}`;
    } else {
      // Working tree diff
      url = `/api/git/diff/${encodeURIComponent(projectName)}`;
    }

    api
      .get<{ diff: string }>(url)
      .then((data) => {
        setDiffText(data.diff);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load diff");
        setLoading(false);
      });
  }, [filePath, projectName, ref1, ref2, file1, file2]);

  // Parse unified diff into original and modified content
  const { original, modified } = useMemo(() => {
    // File-to-file compare: use raw contents directly
    if (isFileCompare && fileContents) {
      return fileContents;
    }
    if (!diffText) return { original: "", modified: "" };
    return parseDiff(diffText);
  }, [diffText, isFileCompare, fileContents]);

  const extensions = useMemo(() => {
    const exts: Extension[] = [
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
    ];
    const langFile = filePath ?? file2 ?? file1;
    if (langFile) {
      const langExt = getLanguageExtension(langFile);
      if (langExt) exts.push(langExt);
    }
    return exts;
  }, [filePath, file1, file2]);

  if (!projectName) {
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

  if (!isFileCompare && (!diffText || diffText.trim() === "")) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
        <FileCode className="size-8" />
        <p className="text-sm">No changes detected</p>
        {filePath && (
          <p className="text-xs font-mono">{filePath}</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b text-xs text-muted-foreground">
        <FileCode className="size-3.5" />
        {isFileCompare ? (
          <span className="font-mono truncate">
            {file1} vs {file2}
          </span>
        ) : (
          <>
            <span className="font-mono">
              {filePath ?? "Working tree changes"}
            </span>
            {(ref1 || ref2) && (
              <span>
                ({ref1?.slice(0, 7) ?? "HEAD"} vs {ref2?.slice(0, 7) ?? "working tree"})
              </span>
            )}
          </>
        )}
      </div>

      {/* Diff content using CodeMirror merge view */}
      <div className="flex-1 overflow-hidden">
        <CodeMirror
          value={modified}
          extensions={[
            ...extensions,
            unifiedMergeView({ original }),
          ]}
          theme={oneDark}
          height="100%"
          style={{ height: "100%", fontSize: "13px", fontFamily: "var(--font-mono)" }}
          basicSetup={{
            lineNumbers: true,
            foldGutter: false,
            autocompletion: false,
            highlightActiveLine: false,
          }}
          editable={false}
        />
      </div>
    </div>
  );
}

/**
 * Parse unified diff format into original/modified strings.
 * Handles both single-file and multi-file diffs.
 */
function parseDiff(diff: string): { original: string; modified: string } {
  const lines = diff.split("\n");
  const originalLines: string[] = [];
  const modifiedLines: string[] = [];
  let inHunk = false;

  for (const line of lines) {
    // Skip diff headers
    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("---") ||
      line.startsWith("+++") ||
      line.startsWith("Binary files")
    ) {
      continue;
    }

    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }

    if (!inHunk) continue;

    if (line.startsWith("-")) {
      originalLines.push(line.slice(1));
    } else if (line.startsWith("+")) {
      modifiedLines.push(line.slice(1));
    } else if (line.startsWith(" ") || line === "") {
      // Context line
      const content = line.startsWith(" ") ? line.slice(1) : line;
      originalLines.push(content);
      modifiedLines.push(content);
    } else if (line === "\\ No newline at end of file") {
      // skip
    }
  }

  return {
    original: originalLines.join("\n"),
    modified: modifiedLines.join("\n"),
  };
}
