/**
 * Compact inline diff for Edit/MultiEdit tool cards.
 * Interleaved unified diff (removed lines then added lines per hunk) with
 * char-level highlight on the exact changed spans, layered on highlight.js
 * syntax colors — same look as Monaco's inline diff. Unchanged context lines
 * render neutral (shown once). Loaded lazily (see tool-cards.tsx) to keep
 * highlight.js + jsdiff out of the main chunk.
 */
import { useMemo } from "react";
import { buildRows, hljsLanguage, renderLine, type DiffRow } from "./edit-diff-compute";

export default function EditDiffPreview({ oldStr, newStr, filePath, maxLines = 12 }: {
  oldStr: string;
  newStr: string;
  filePath?: string;
  maxLines?: number;
}) {
  const language = useMemo(() => hljsLanguage(filePath), [filePath]);

  const { rows, extra } = useMemo(
    () => buildRows(oldStr, newStr, maxLines),
    [oldStr, newStr, maxLines],
  );

  const lines = useMemo(
    () =>
      rows.map((row) => ({
        row,
        html: renderLine(
          row.text,
          language,
          row.kind === "equal" ? [] : row.ranges,
          row.kind === "del" ? "bg-diff-removed-word" : "bg-diff-added-word",
        ),
      })),
    [rows, language],
  );

  const style = (kind: DiffRow["kind"]) => {
    if (kind === "del") return { tint: "bg-diff-removed", gutter: "text-error", prefix: "-" };
    if (kind === "ins") return { tint: "bg-diff-added", gutter: "text-success", prefix: "+" };
    return { tint: "", gutter: "text-text-subtle", prefix: " " };
  };

  return (
    <div className="font-mono text-[11px] overflow-x-auto rounded py-1">
      {lines.map(({ row, html }, i) => {
        const s = style(row.kind);
        return (
          <div key={i} className={`flex ${s.tint}`}>
            <span className={`select-none shrink-0 w-3 pl-1.5 ${s.gutter}`}>{s.prefix}</span>
            <code
              className="whitespace-pre-wrap break-all text-text-primary pr-1.5"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </div>
        );
      })}
      {extra > 0 && (
        <p className="text-text-subtle select-none pl-1.5">
          … +{extra} more line{extra !== 1 ? "s" : ""}
        </p>
      )}
    </div>
  );
}
