/**
 * DBGate's Export ▾ on a table's data: every row the grid's filters and sort select — not only the
 * rows loaded — in one of DBGate's quick-export formats, in its order. Export advanced... heads the
 * list on a computer: the Import/Export tab on the grid's query.
 *
 * Two steps, so that a refusal is said rather than saved as the file: the server answers a ticket
 * once the database has begun answering (`POST grid/export`), or why it would not; the browser
 * then downloads the ticket's URL itself — no token, no Blob, the file goes to disk as it is read.
 */
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowRightFromLine, ChevronDown } from "@/lib/icons";
import { triggerDownload } from "@/lib/file-download";
import { formatCombo } from "@/stores/keybindings-store";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  GRID_EXPORT_FORMATS, gridExportDownloadUrl, gridExportFileName, type GridExportFormat, type GridExportTicket,
} from "../../../shared/db-grid-export";
import { toolButtonClass } from "./db-tab-parts";

export interface GridExport {
  /**
   * Exports in `format`: settles once the download has begun, or once why it could not was said.
   * Absent where only Export advanced... can say what to export — a query's result, its rows held
   * in the browser and nowhere for a quick export to read them again from.
   */
  run?: (format: GridExportFormat) => Promise<void>;
  /** One is being started; the menu waits for it. */
  busy: boolean;
  /** Nothing can be exported — every column is hidden — and why. */
  unavailable?: string;
  /** Opens Export advanced...; absent on a phone, which has no Import/Export tab. */
  advanced?: () => void;
}

/**
 * Export, started by `start` — which answers the download's ticket, or null when there is nothing
 * to export — with a toast that follows it: the database can take a while to begin answering,
 * a sorted table being read through before its first row.
 */
export function useGridExport(
  start: (format: GridExportFormat) => Promise<GridExportTicket | null>, table: string, unavailable?: string, advanced?: () => void,
): GridExport {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const run = useCallback(async (format: GridExportFormat) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const id = toast.loading(`Exporting ${gridExportFileName(table, format)}…`);
    try {
      const ticket = await start(format);
      if (!ticket) {
        toast.dismiss(id);
        return;
      }
      triggerDownload(gridExportDownloadUrl(ticket.ticket), ticket.fileName);
      toast.success(`Downloading ${ticket.fileName}`, { id });
    } catch (e) {
      toast.error("Export failed", { id, description: (e as Error).message });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [start, table]);
  return { run, busy, unavailable, advanced };
}

/** The toolbar's Export ▾; `labelClassName` hides its label where the toolbar has no room. */
export function ExportButton({ exporter, labelClassName }: { exporter: GridExport; labelClassName?: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button" disabled={!!exporter.unavailable} aria-label="Export"
          title={exporter.unavailable ?? "Export every row the filters select"}
          className={toolButtonClass}
        >
          <ArrowRightFromLine className="size-4 shrink-0" />
          <span className={labelClassName}>Export</span>
          <ChevronDown className="-ml-0.5 size-3 shrink-0" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        {exporter.advanced && (
          <>
            <DropdownMenuItem onSelect={exporter.advanced}>
              Export advanced...
              <DropdownMenuShortcut className="tracking-normal">{formatCombo("Mod+E")}</DropdownMenuShortcut>
            </DropdownMenuItem>
            {exporter.run && <DropdownMenuSeparator />}
          </>
        )}
        {exporter.run && GRID_EXPORT_FORMATS.map((f) => (
          <DropdownMenuItem key={f.id} disabled={exporter.busy} onSelect={() => void exporter.run?.(f.id)}>
            {f.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
