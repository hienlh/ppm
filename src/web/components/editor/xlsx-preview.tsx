import { useCallback, useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Loader2, FileWarning } from "@/lib/icons";
import { api, projectUrl } from "@/lib/api-client";

interface XlsxPreviewProps {
  filePath: string;
  projectName?: string;
}

/** What `GET …/xlsx-sheet` answers: one sheet, cut to the server's limits. */
interface XlsxSheet {
  sheets: string[];
  sheet: number;
  rows: (string | null)[][];
  columns: number;
  truncatedRows: boolean;
  truncatedColumns: boolean;
}

const ROW_HEIGHT = 28;
const COL_WIDTH = 140;
const ROW_NUMBER_WIDTH = 52;

/** `A`, `B` … `Z`, `AA` …: the letters of the 0-based `index`-th column. */
function columnLetters(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function sheetUrl(filePath: string, projectName: string | undefined, sheet: number): string {
  const isExternal = /^(\/|[A-Za-z]:[/\\])/.test(filePath);
  const base = isExternal ? "/api/fs/xlsx-sheet" : `${projectUrl(projectName!)}/files/xlsx-sheet`;
  return `${base}?path=${encodeURIComponent(filePath)}&sheet=${sheet}`;
}

/** Read-only preview of an .xlsx/.xlsm: one sheet at a time, read and cut to size by the server. */
export function XlsxPreview({ filePath, projectName }: XlsxPreviewProps) {
  const [data, setData] = useState<XlsxSheet | null>(null);
  const [sheet, setSheet] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(
    (quiet: boolean) => {
      let cancelled = false;
      if (!quiet) {
        setLoading(true);
        setError(null);
      }
      api
        .get<XlsxSheet>(sheetUrl(filePath, projectName, sheet))
        .then((d) => {
          if (cancelled) return;
          setData(d);
          setError(null);
          setLoading(false);
        })
        .catch((err) => {
          if (cancelled) return;
          // A sheet removed since the last load falls back to the first one.
          if (quiet && sheet !== 0) { setSheet(0); return; }
          setError(err instanceof Error ? err.message : "Failed to read workbook");
          setLoading(false);
        });
      return () => { cancelled = true; };
    },
    [filePath, projectName, sheet],
  );

  useEffect(() => load(false), [load]);

  // Reload on change of this file, keeping the chosen sheet.
  useEffect(() => {
    let cancel: (() => void) | undefined;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.projectName !== projectName || detail.path !== filePath) return;
      cancel?.();
      cancel = load(true);
    };
    window.addEventListener("file:changed", handler);
    return () => {
      cancel?.();
      window.removeEventListener("file:changed", handler);
    };
  }, [filePath, projectName, load]);

  const rows = data?.rows ?? [];
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  // A different sheet starts at its top-left corner.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, left: 0 });
  }, [data?.sheet]);

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center h-full gap-2 text-text-secondary">
        <Loader2 className="size-5 animate-spin" />
        <span className="text-sm">Reading workbook...</span>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-text-secondary px-6 text-center">
        <FileWarning className="size-10 text-text-subtle" />
        <p className="text-sm">Failed to load workbook.</p>
        <p className="text-xs text-text-subtle">{error}</p>
      </div>
    );
  }

  const columns = data?.columns ?? 0;
  const width = ROW_NUMBER_WIDTH + columns * COL_WIDTH;
  const notices = [
    data?.truncatedRows && `Showing the first ${rows.length.toLocaleString()} rows`,
    data?.truncatedColumns && `Showing the first ${columns} columns`,
  ].filter(Boolean);

  return (
    <div className="flex flex-col h-full min-h-0">
      {notices.length > 0 && (
        <div className="shrink-0 px-3 py-1.5 text-xs text-text-secondary bg-muted/50 border-b border-border">
          {notices.join(" · ")}
        </div>
      )}

      <div ref={scrollRef} className="relative flex-1 min-h-0 overflow-auto">
        {error && (
          <div className="sticky top-0 left-0 z-20 px-3 py-1.5 text-xs text-error bg-background border-b border-border">{error}</div>
        )}
        {rows.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">Empty sheet</div>
        ) : (
          <div className="text-xs font-mono" style={{ width, minWidth: "100%" }}>
            <div className="sticky top-0 z-10 flex bg-background border-b border-border" style={{ height: ROW_HEIGHT }}>
              <div className="sticky left-0 z-10 shrink-0 bg-background border-r border-border" style={{ width: ROW_NUMBER_WIDTH }} />
              {Array.from({ length: columns }, (_, c) => (
                <div
                  key={c}
                  className="shrink-0 flex items-center justify-center text-muted-foreground font-medium border-r border-border/50 select-none"
                  style={{ width: COL_WIDTH }}
                >
                  {columnLetters(c)}
                </div>
              ))}
            </div>
            <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
              {virtualizer.getVirtualItems().map((v) => {
                const row = rows[v.index]!;
                return (
                  <div
                    key={v.index}
                    className="absolute left-0 flex border-b border-border/50"
                    style={{ top: 0, height: ROW_HEIGHT, width, transform: `translateY(${v.start}px)` }}
                  >
                    <div
                      className="sticky left-0 shrink-0 flex items-center justify-end pr-2 bg-background text-muted-foreground border-r border-border select-none"
                      style={{ width: ROW_NUMBER_WIDTH }}
                    >
                      {v.index + 1}
                    </div>
                    {Array.from({ length: columns }, (_, c) => {
                      const value = row[c];
                      return (
                        <div
                          key={c}
                          className="shrink-0 px-2 flex items-center border-r border-r-border/30 overflow-hidden"
                          style={{ width: COL_WIDTH }}
                          title={value && value.length > 16 ? value : undefined}
                        >
                          <span className="truncate">{value ?? ""}</span>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {data && data.sheets.length > 0 && (
        <div className="shrink-0 flex overflow-x-auto border-t border-border bg-muted/30" role="tablist" aria-label="Sheets">
          {data.sheets.map((name, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={i === sheet}
              onClick={() => setSheet(i)}
              className={`shrink-0 min-h-11 md:min-h-8 px-4 text-xs whitespace-nowrap border-r border-border ${
                i === sheet ? "bg-background text-foreground font-medium" : "text-text-secondary hover:bg-muted/50"
              }`}
            >
              {name || `Sheet ${i + 1}`}
            </button>
          ))}
          {loading && <Loader2 className="size-4 animate-spin self-center mx-3 text-text-secondary" />}
        </div>
      )}
    </div>
  );
}
