import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Loader2, FileWarning } from "@/lib/icons";
import { api, ApiError, projectUrl } from "@/lib/api-client";
import { columnLetters, columnWidths, sheetAfterError } from "@/lib/xlsx-preview-model";

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
const ROW_NUMBER_WIDTH = 52;

function sheetUrl(filePath: string, projectName: string | undefined, sheet: number): string {
  const isExternal = /^(\/|[A-Za-z]:[/\\])/.test(filePath);
  const base = isExternal ? "/api/fs/xlsx-sheet" : `${projectUrl(projectName!)}/files/xlsx-sheet`;
  return `${base}?path=${encodeURIComponent(filePath)}&sheet=${sheet}`;
}

/** Read-only preview of an .xlsx/.xlsm: one sheet at a time, read and cut to size by the server. */
export function XlsxPreview({ filePath, projectName }: XlsxPreviewProps) {
  const [data, setData] = useState<XlsxSheet | null>(null);
  /** The sheet being loaded after a tab was picked; lit until it loads or fails. */
  const [pending, setPending] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ row: number; col: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Only the latest request's answer is applied. */
  const requestRef = useRef(0);
  const shownRef = useRef<number>(0);
  shownRef.current = data?.sheet ?? 0;
  const pendingRef = useRef<number | null>(null);
  pendingRef.current = pending;

  const fetchSheet = useCallback(
    (target: number, quiet: boolean) => {
      const id = ++requestRef.current;
      if (!quiet) setPending(target);
      setLoading(true);
      api
        .get<XlsxSheet>(sheetUrl(filePath, projectName, target))
        .then((d) => {
          if (id !== requestRef.current) return;
          if (d.sheet !== shownRef.current) setSelected(null);
          setData(d);
          setError(null);
          setPending(null);
          setLoading(false);
        })
        .catch((err) => {
          if (id !== requestRef.current) return;
          const instead = sheetAfterError(err instanceof ApiError ? err.status : undefined, target);
          if (instead !== null) { fetchSheet(instead, quiet); return; }
          // Keep the sheet on screen (and its tab lit); the next change of the file tries again.
          setError(err instanceof Error ? err.message : "Failed to read workbook");
          setPending(null);
          setLoading(false);
        });
    },
    [filePath, projectName],
  );

  useEffect(() => {
    setData(null);
    setSelected(null);
    setError(null);
    fetchSheet(0, false);
    return () => { requestRef.current++; };
  }, [fetchSheet]);

  // Reload on change of this file, keeping the sheet on screen.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.projectName !== projectName || detail.path !== filePath) return;
      // A tab picked but not loaded yet is still the one wanted.
      const wanted = pendingRef.current;
      fetchSheet(wanted ?? shownRef.current, wanted === null);
    };
    window.addEventListener("file:changed", handler);
    return () => window.removeEventListener("file:changed", handler);
  }, [filePath, projectName, fetchSheet]);

  const rows = data?.rows ?? [];
  const columns = data?.columns ?? 0;
  const widths = useMemo(() => columnWidths(rows, columns), [rows, columns]);
  const width = ROW_NUMBER_WIDTH + widths.reduce((a, b) => a + b, 0);

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

  if (!data && loading) {
    return (
      <div className="flex items-center justify-center h-full gap-2 text-text-secondary">
        <Loader2 className="size-5 animate-spin" />
        <span className="text-sm">Reading workbook...</span>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-text-secondary px-6 text-center">
        <FileWarning className="size-10 text-text-subtle" />
        <p className="text-sm">Failed to load workbook.</p>
        <p className="text-xs text-text-subtle">{error}</p>
      </div>
    );
  }

  const litSheet = pending ?? data.sheet;
  const selectedValue = selected ? rows[selected.row]?.[selected.col] ?? "" : "";
  const notices = [
    data.truncatedRows && `Showing the first ${rows.length.toLocaleString()} rows`,
    data.truncatedColumns && `Showing the first ${columns} columns`,
  ].filter(Boolean);

  return (
    <div className="flex flex-col h-full min-h-0">
      {error && (
        <div role="alert" data-testid="xlsx-error" className="shrink-0 px-3 py-1.5 text-xs text-error bg-background border-b border-border">
          {error}
        </div>
      )}
      {notices.length > 0 && (
        <div className="shrink-0 px-3 py-1.5 text-xs text-text-secondary bg-muted/50 border-b border-border">
          {notices.join(" · ")}
        </div>
      )}

      {/* The cell bar: the picked cell's address and its whole value, selectable, like Excel's formula bar. */}
      <div className="shrink-0 flex items-stretch min-h-8 border-b border-border text-xs font-mono">
        <div data-testid="xlsx-cell-ref" className="shrink-0 w-16 flex items-center justify-center border-r border-border text-text-secondary select-none">
          {selected ? `${columnLetters(selected.col)}${selected.row + 1}` : ""}
        </div>
        <div
          data-testid="xlsx-cell-value"
          className="flex-1 min-w-0 max-h-24 overflow-auto px-2 py-1.5 whitespace-pre-wrap break-words select-text"
        >
          {selected ? selectedValue : <span className="text-text-subtle select-none">Tap a cell to see its full value</span>}
        </div>
      </div>

      <div ref={scrollRef} className="relative flex-1 min-h-0 overflow-auto">
        {rows.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">Empty sheet</div>
        ) : (
          <div className="text-xs font-mono" style={{ width, minWidth: "100%" }}>
            <div className="sticky top-0 z-10 flex bg-background border-b border-border" style={{ height: ROW_HEIGHT }}>
              <div className="sticky left-0 z-10 shrink-0 bg-background border-r border-border" style={{ width: ROW_NUMBER_WIDTH }} />
              {widths.map((w, c) => (
                <div
                  key={c}
                  className="shrink-0 flex items-center justify-center text-muted-foreground font-medium border-r border-border/50 select-none"
                  style={{ width: w }}
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
                      className="sticky left-0 z-[1] shrink-0 flex items-center justify-end pr-2 bg-background text-muted-foreground border-r border-border select-none"
                      style={{ width: ROW_NUMBER_WIDTH }}
                    >
                      {v.index + 1}
                    </div>
                    {widths.map((w, c) => {
                      const value = row[c];
                      const isSelected = selected?.row === v.index && selected.col === c;
                      return (
                        <div
                          key={c}
                          data-cell={`${columnLetters(c)}${v.index + 1}`}
                          onClick={() => setSelected({ row: v.index, col: c })}
                          className={`shrink-0 px-2 flex items-center border-r border-r-border/30 overflow-hidden cursor-cell ${
                            isSelected ? "outline outline-2 -outline-offset-2 outline-primary" : ""
                          }`}
                          style={{ width: w }}
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

      {data.sheets.length > 0 && (
        <div className="shrink-0 flex overflow-x-auto border-t border-border bg-muted/30" role="tablist" aria-label="Sheets">
          {data.sheets.map((name, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={i === litSheet}
              onClick={() => { if (i !== litSheet) fetchSheet(i, false); }}
              className={`shrink-0 min-h-8 pointer-coarse:min-h-11 px-4 text-xs whitespace-nowrap border-r border-border ${
                i === litSheet ? "bg-background text-foreground font-medium" : "text-text-secondary hover:bg-muted/50"
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
