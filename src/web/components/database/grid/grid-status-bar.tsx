/**
 * What DBGate says over a grid while it shows it: Rows / Count / Sum at the bottom right once two or
 * more cells are selected, and the boxes that say rows are being read. A table's "Rows: N" is the
 * status bar's (`db-rows-status.tsx`); the form view's "Row: 2 / 14" sits in its corner.
 */
import { Loader2 } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { SelectionStats } from "./selection-stats";

const boxClass = "absolute z-20 rounded-[7px] border border-border bg-popover font-mono text-[11px] text-text-2 shadow-[0_8px_22px_-12px_rgb(0_0_0/0.45)]";

export function GridSelectionStats({ stats, right, bottom }: { stats: SelectionStats; right: number; bottom: number }) {
  const rows: [string, string][] = [
    ["Rows:", stats.rows.toLocaleString()],
    ["Count:", stats.count.toLocaleString()],
    ["Sum:", stats.sum === null ? "" : stats.sum.toLocaleString(undefined, { maximumFractionDigits: 10 })],
  ];
  return (
    <table aria-label="Selected cells" style={{ right, bottom }} className={cn(boxClass, "pointer-events-none border-separate px-2 py-1")}>
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label}>
            <td className="py-px pr-2.5 text-text-3">{label}</td>
            <td className="py-px">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * DBGate's label in a grid's or a form's corner: the form's "Row: 2 / 14" at the bottom right, a
 * grid's own "Rows: N" at the bottom left, by its row numbers, while two grids share the tab.
 */
export function GridCornerLabel({ text, left, right, bottom, title }: { text: string; left?: number; right?: number; bottom: number; title?: string }) {
  return (
    <div role="status" title={title} style={{ left, right, bottom }} className={cn(boxClass, "pointer-events-none px-2 py-[3px]")}>
      {text}
    </div>
  );
}

/** DBGate's loading box: over the whole grid while it is read again, at its foot while more rows come. */
export function GridLoadingBox({ text, cover, bottom }: { text: string; cover: boolean; bottom?: number }) {
  const box = (
    <div role="status" className="flex items-center gap-2.5 rounded-[10px] border border-border bg-popover px-3.5 py-2.5 text-[12.5px] text-text shadow-[0_12px_32px_-12px_rgb(0_0_0/0.45)]">
      <Loader2 className="size-4 animate-spin text-primary" aria-hidden />
      {text}
    </div>
  );
  if (cover) return <div className="absolute inset-0 z-30 grid place-items-center bg-background/55">{box}</div>;
  return <div className="pointer-events-none absolute inset-x-0 z-30 flex justify-center" style={{ bottom: bottom ?? 12 }}>{box}</div>;
}
