/**
 * One file row in the change tray / sheet. Shared by both presentations; `dense`
 * switches from the 52px touch row to the 38px desktop row.
 */
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FileChangeOp, TurnFileChange } from "@/lib/aggregate-turn-file-changes";

/**
 * The sigil slot carries two dimensions at once: the glyph is the operation, the
 * tint is sub-agent provenance. Because colour alone encodes provenance, the
 * combined label is required rather than decorative.
 */
const SIGIL: Record<FileChangeOp, { glyph: string; cls: string; label: string }> = {
  create: { glyph: "A", cls: "text-success", label: "created" },
  write: { glyph: "W", cls: "text-warning", label: "overwritten" },
  notebook: { glyph: "N", cls: "text-accent-2", label: "notebook edited" },
  edit: { glyph: "·", cls: "text-text-subtle", label: "edited" },
};

function splitPath(path: string): { base: string; dir: string } {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i < 0 ? { base: path, dir: "" } : { base: path.slice(i + 1), dir: path.slice(0, i) };
}

export function ChangeCounts({ added, removed, editCount, className }: {
  added: number;
  removed: number;
  editCount?: number;
  className?: string;
}) {
  return (
    <span className={cn("flex items-center gap-[5px] tabular-nums", className)}>
      <span className="text-success">+{added}</span>
      <span className="text-error">{"−"}{removed}</span>
      {editCount != null && editCount > 1 && (
        <span className="text-text-subtle">{"×"}{editCount}</span>
      )}
    </span>
  );
}

export function ChangeFileRow({ change, dense, selected, onClick }: {
  change: TurnFileChange;
  dense?: boolean;
  selected?: boolean;
  onClick: () => void;
}) {
  const sigil = SIGIL[change.op];
  const { base, dir } = splitPath(change.filePath);
  const sigilLabel = change.viaSubagent
    ? `${sigil.label} · changed by a sub-agent`
    : sigil.label;

  return (
    <button
      type="button"
      onClick={onClick}
      title={change.filePath}
      className={cn(
        "grid w-full grid-cols-[16px_1fr_auto_10px] items-center gap-[10px] text-left font-mono",
        "border-b border-border-soft hover:bg-surface transition-colors",
        dense ? "min-h-[38px] px-2.5 py-[5px] text-xs" : "min-h-[52px] px-3 py-[7px] text-[12.5px]",
        selected && "bg-surface shadow-[inset_2px_0_0_var(--accent)]",
      )}
    >
      <span
        aria-label={sigilLabel}
        title={sigilLabel}
        className={cn(
          "inline-flex size-4 items-center justify-center rounded bg-white/5 text-[9px] font-semibold",
          sigil.cls,
          change.viaSubagent && "bg-accent-2/20 ring-1 ring-inset ring-accent-2/35",
        )}
      >
        {sigil.glyph}
      </span>

      <span className="min-w-0">
        <span className="block truncate text-text-primary">{base}</span>
        {dir && (
          // Head-truncated: the tail of a path is the informative part.
          <span className="block overflow-hidden text-ellipsis whitespace-nowrap text-[10px] text-text-subtle [direction:rtl] text-left">
            {dir}
          </span>
        )}
      </span>

      <ChangeCounts
        added={change.linesAdded}
        removed={change.linesRemoved}
        editCount={change.editCount}
        className="text-[11px]"
      />

      <ChevronRight className="size-[11px] text-text-subtle" />
    </button>
  );
}
