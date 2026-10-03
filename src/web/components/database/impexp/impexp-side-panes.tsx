/**
 * The right-hand column of the Import/Export tab, as DBGate's: Output files — what the last run
 * wrote, each with its download link — Messages — the job's log, with a switch per level, Preserve
 * Logs and a filter box — and, for an import, Preview — the first rows of the file ticked in the
 * map table, as Import would write them.
 */
import { useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "@/lib/icons";
import { api } from "@/lib/api-client";
import { formatBytes } from "@/lib/format-bytes";
import { cn } from "@/lib/utils";
import type {
  ImpExpMessage, ImpExpMessageLevel, ImpExpOutputFile, ImportFileFormat, ImportFormatOptions, ImportPreview,
} from "../../../../shared/db-impexp";
import { SearchBox, linkButtonClass } from "../explorer/tree-parts";
import { DEFAULT_SHOWN_LEVELS, MESSAGE_LEVELS, levelCounts, messageClock, messageLines, type ImpExpRow } from "./impexp-state";
import { CheckField } from "./impexp-parts";

const th = "sticky top-0 h-6 border-b border-border bg-panel-2 px-2 text-left text-[11px] font-medium whitespace-nowrap text-text-2";
const td = "border-b border-border-soft px-2 py-1 align-top text-xs text-text-primary";

function Empty({ children }: { children: string }) {
  return <p className="px-3 py-2 text-xs text-text-subtle">{children}</p>;
}

export function OutputFilesPane({ files, onDownload }: { files: readonly ImpExpOutputFile[]; onDownload: (name: string) => void }) {
  if (files.length === 0) return <Empty>No output files</Empty>;
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full border-collapse">
        <thead><tr><th className={th}>Name</th><th className={cn(th, "w-20 text-right")}>Size</th><th className={cn(th, "w-20")} /></tr></thead>
        <tbody>
          {files.map((f) => (
            <tr key={f.name}>
              <td className={cn(td, "break-all")}>{f.name}</td>
              <td className={cn(td, "text-right whitespace-nowrap tabular-nums")}>{formatBytes(f.size)}</td>
              <td className={td}>
                <button type="button" className={cn(linkButtonClass, "text-xs")} aria-label={`Download ${f.name}`} onClick={() => onDownload(f.name)}>
                  download
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MessagesPane({ messages, preserveLogs, onPreserveLogs }: {
  messages: readonly ImpExpMessage[];
  preserveLogs: boolean;
  onPreserveLogs: (on: boolean) => void;
}) {
  const [shown, setShown] = useState<readonly ImpExpMessageLevel[]>(DEFAULT_SHOWN_LEVELS);
  const [query, setQuery] = useState("");
  const counts = levelCounts(messages);
  const lines = messageLines(messages, shown, query);
  const toggle = (level: ImpExpMessageLevel) => setShown((s) => (s.includes(level) ? s.filter((l) => l !== level) : [...s, level]));
  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-2 py-1.5">
        {MESSAGE_LEVELS.map(({ level, label }) => (
          <button
            key={level} type="button" aria-pressed={shown.includes(level)} onClick={() => toggle(level)}
            className={cn(
              "h-6 rounded-[5px] border px-2 text-[11px] tabular-nums",
              shown.includes(level)
                ? "border-primary bg-primary/10 text-text-primary"
                : "border-border text-text-subtle can-hover:hover:bg-surface-hover",
            )}
          >
            {label} ({counts[level]})
          </button>
        ))}
        <CheckField label="Preserve Logs" checked={preserveLogs} onChange={onPreserveLogs} />
      </div>
      <div className="flex shrink-0 px-2 py-1.5">
        <SearchBox value={query} onChange={setQuery} placeholder="Filter log messages" />
      </div>
      {lines.length === 0 ? (
        <Empty>No messages</Empty>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={cn(th, "w-10 text-right")}>Number</th>
                <th className={th}>Message</th>
                <th className={cn(th, "w-16")}>Time</th>
                <th className={cn(th, "w-14 text-right")}>Delta</th>
                <th className={cn(th, "w-16 text-right")}>Duration</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((m) => (
                <tr key={m.number}>
                  <td className={cn(td, "text-right text-text-subtle tabular-nums")}>{m.number}</td>
                  <td
                    className={cn(
                      td, "break-words whitespace-pre-wrap",
                      m.level === "error" && "text-destructive",
                      m.level === "warning" && "text-warning",
                      m.level === "debug" && "text-text-subtle",
                    )}
                  >
                    {m.text}
                  </td>
                  <td className={cn(td, "whitespace-nowrap tabular-nums")}>{messageClock(m.time)}</td>
                  <td className={cn(td, "text-right whitespace-nowrap tabular-nums")}>{m.delta}</td>
                  <td className={cn(td, "text-right whitespace-nowrap tabular-nums")}>{m.duration}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

const PREVIEW_DELAY_MS = 300;

function previewCell(v: unknown): string {
  if (v === null || v === undefined) return "(NULL)";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

/** The first rows of one uploaded file, read again whenever how it is read or mapped changes. */
export function PreviewPane({ row, format, options }: { row: ImpExpRow; format: ImportFileFormat; options: ImportFormatOptions }) {
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const uploadId = row.upload?.id ?? null;
  const body = JSON.stringify({ format, options, ...(row.columns ? { columns: row.columns } : {}) });
  useEffect(() => {
    if (!uploadId) return;
    const ctrl = new AbortController();
    setLoading(true);
    // The options are typed into: wait for the typing to stop.
    const timer = setTimeout(() => {
      api.post<ImportPreview>(`/api/db/impexp/uploads/${encodeURIComponent(uploadId)}/preview`, JSON.parse(body), { signal: ctrl.signal })
        .then((p) => { setPreview(p); setError(null); })
        .catch((e: Error) => { if (!ctrl.signal.aborted) { setPreview(null); setError(e.message); } })
        .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    }, PREVIEW_DELAY_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [uploadId, body]);

  if (loading && !preview) {
    return (
      <div className="flex flex-1 items-center justify-center text-text-subtle" role="status" aria-label="Reading the file">
        <Loader2 className="size-4 animate-spin" />
      </div>
    );
  }
  if (error) return <p role="alert" className="px-3 py-2 text-xs break-words text-destructive">{error}</p>;
  if (!preview) return null;
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", loading && "opacity-60")} aria-busy={loading}>
      {preview.warnings.map((w) => (
        <p key={w} className="flex shrink-0 items-start gap-1.5 border-b border-border-soft px-2 py-1 text-xs text-warning">
          <AlertTriangle className="mt-px size-3.5 shrink-0" />{w}
        </p>
      ))}
      {preview.columns.length === 0 ? (
        <Empty>The file has no rows</Empty>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="border-collapse">
            <thead><tr>{preview.columns.map((c, i) => <th key={i} className={th}>{c}</th>)}</tr></thead>
            <tbody>
              {preview.rows.map((r, i) => (
                <tr key={i}>
                  {preview.columns.map((_, j) => (
                    <td key={j} className={cn(td, "max-w-[240px] truncate whitespace-nowrap", (r[j] === null || r[j] === undefined) && "text-text-subtle italic")}>
                      {previewCell(r[j])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
