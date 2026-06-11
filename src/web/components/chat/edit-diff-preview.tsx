/**
 * Compact inline diff for Edit/MultiEdit tool cards.
 * Old lines on red tint, new lines on green tint, syntax-highlighted via
 * highlight.js — same engine + theme stylesheet as markdown code blocks,
 * so colors follow the app light/dark theme automatically.
 * Loaded lazily (see tool-cards.tsx) to keep hljs out of the main chunk.
 */
import { useMemo } from "react";
import hljs from "highlight.js/lib/common";

/** Map file extension to a highlight.js language id; undefined = plain text */
function hljsLanguage(filePath?: string): string | undefined {
  const ext = filePath?.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    ts: "typescript", tsx: "typescript",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
    c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp",
    json: "json", css: "css", scss: "scss", less: "less",
    html: "xml", xml: "xml", svg: "xml",
    md: "markdown", mdx: "markdown",
    yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini",
    sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell",
    sql: "sql", php: "php", kt: "kotlin", swift: "swift",
  };
  const lang = map[ext];
  return lang && hljs.getLanguage(lang) ? lang : undefined;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Highlight one line — hljs escapes its input, so the output HTML is injection-safe */
function highlightLine(line: string, language?: string): string {
  if (!language) return escapeHtml(line);
  try {
    return hljs.highlight(line, { language }).value;
  } catch {
    return escapeHtml(line);
  }
}

function useHighlightedLines(text: string, language: string | undefined, maxLines: number) {
  return useMemo(() => {
    if (!text) return null;
    const lines = text.split("\n");
    const shown = lines.slice(0, maxLines);
    return {
      html: shown.map((l) => highlightLine(l, language)),
      extra: lines.length - shown.length,
    };
  }, [text, language, maxLines]);
}

export default function EditDiffPreview({ oldStr, newStr, filePath, maxLines = 8 }: {
  oldStr: string;
  newStr: string;
  filePath?: string;
  maxLines?: number;
}) {
  const language = useMemo(() => hljsLanguage(filePath), [filePath]);
  const oldLines = useHighlightedLines(oldStr, language, maxLines);
  const newLines = useHighlightedLines(newStr, language, maxLines);

  const block = (data: { html: string[]; extra: number } | null, kind: "old" | "new") => {
    if (!data) return null;
    const prefix = kind === "old" ? "-" : "+";
    const tint = kind === "old" ? "bg-diff-removed" : "bg-diff-added";
    const gutter = kind === "old" ? "text-red-400" : "text-green-400";
    return (
      <div className={`font-mono text-[11px] overflow-x-auto rounded px-1.5 py-1 ${tint}`}>
        {data.html.map((html, i) => (
          <div key={i} className="flex">
            <span className={`select-none shrink-0 w-3 ${gutter}`}>{prefix}</span>
            <code
              className="whitespace-pre-wrap break-all text-text-primary"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </div>
        ))}
        {data.extra > 0 && (
          <p className="text-text-subtle select-none">… +{data.extra} more line{data.extra !== 1 ? "s" : ""}</p>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-0.5">
      {block(oldLines, "old")}
      {block(newLines, "new")}
    </div>
  );
}
