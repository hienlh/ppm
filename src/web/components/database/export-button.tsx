import { useState, useRef, useEffect } from "react";
import { Download } from "lucide-react";
import { serializeCsv } from "@/lib/csv-parser";

interface ExportButtonProps {
  columns: string[];
  rows: Record<string, unknown>[];
  filename?: string;
  /** Optional: connection ID + table for server-side "Export All" */
  exportAllUrl?: string;
}

function downloadFile(name: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function ExportButton({ columns, rows, filename = "export", exportAllUrl }: ExportButtonProps) {
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const exportPageCsv = () => {
    const csvRows = rows.map((r) => columns.map((c) => String(r[c] ?? "")));
    const csv = serializeCsv(columns, csvRows);
    downloadFile(`${filename}.csv`, csv, "text/csv");
    setOpen(false);
  };

  const exportPageJson = () => {
    const json = JSON.stringify(rows, null, 2);
    downloadFile(`${filename}.json`, json, "application/json");
    setOpen(false);
  };

  const exportAll = async (format: "csv" | "json") => {
    if (!exportAllUrl) return;
    setExporting(true);
    try {
      const res = await fetch(`${exportAllUrl}&format=${format}&limit=10000`);
      const text = await res.text();
      const mimeType = format === "csv" ? "text/csv" : "application/json";
      downloadFile(`${filename}-all.${format}`, text, mimeType);
    } catch { /* ignore */ }
    setExporting(false);
    setOpen(false);
  };

  if (columns.length === 0 || rows.length === 0) return null;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors"
        title="Export"
      >
        <Download className="size-3.5" />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 bg-popover border border-border rounded-md shadow-md py-1 min-w-[160px] text-xs">
          <button onClick={exportPageCsv} className="w-full text-left px-3 py-1.5 hover:bg-muted transition-colors">
            Export Page (CSV)
          </button>
          <button onClick={exportPageJson} className="w-full text-left px-3 py-1.5 hover:bg-muted transition-colors">
            Export Page (JSON)
          </button>
          {exportAllUrl && (
            <>
              <div className="border-t border-border my-1" />
              <button onClick={() => exportAll("csv")} disabled={exporting} className="w-full text-left px-3 py-1.5 hover:bg-muted transition-colors disabled:opacity-50">
                {exporting ? "Exporting…" : "Export All (CSV)"}
              </button>
              <button onClick={() => exportAll("json")} disabled={exporting} className="w-full text-left px-3 py-1.5 hover:bg-muted transition-colors disabled:opacity-50">
                {exporting ? "Exporting…" : "Export All (JSON)"}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
