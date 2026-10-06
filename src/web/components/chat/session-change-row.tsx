/**
 * One file in the session's change list — shared by the changes bar above the composer
 * and the Review tab's file list. `dense` switches from the 52px touch row to the 36px
 * desktop row.
 *
 * With `onToggleReviewed` the row ends in a Reviewed checkbox: its own button beside the
 * row's, because a button inside a button is not one a browser will reliably click.
 */
import { FileIcon } from "@/lib/file-icons";
import { Check } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { StartEllipsis } from "@/components/ui/start-ellipsis";
import { displayPath, splitDisplayPath } from "@/lib/session-file-changes";
import { ChangeCounts } from "./change-file-row";
import type { SessionChangeStatus, SessionFileChange } from "../../../shared/session-file-changes";

/** The letters and colours Source Control uses for the same three states. */
const STATUS: Record<SessionChangeStatus, { glyph: string; cls: string; label: string }> = {
  added: { glyph: "A", cls: "text-success", label: "Added" },
  modified: { glyph: "M", cls: "text-warning", label: "Modified" },
  deleted: { glyph: "D", cls: "text-error", label: "Deleted" },
};

export function SessionChangeCounts({ file, className }: { file: SessionFileChange; className?: string }) {
  if (file.additions == null || file.deletions == null) {
    return (
      <span className={cn("text-text-subtle", className)}>
        {file.binary ? "binary" : file.tooLarge ? "too large" : ""}
      </span>
    );
  }
  return <ChangeCounts added={file.additions} removed={file.deletions} className={className} />;
}

/** The box a Reviewed checkbox draws: empty, or filled with a tick. */
export function ReviewedBox({ checked, className }: { checked: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded border transition-colors",
        checked ? "border-primary bg-primary text-primary-foreground" : "border-text-subtle",
        className,
      )}
    >
      {checked && <Check className="size-3" />}
    </span>
  );
}

export function SessionChangeRow({ file, projectPath, dense, selected, onClick, onToggleReviewed }: {
  file: SessionFileChange;
  projectPath?: string;
  dense?: boolean;
  selected?: boolean;
  onClick: () => void;
  onToggleReviewed?: () => void;
}) {
  const status = STATUS[file.status];
  const { base, dir } = splitDisplayPath(displayPath(file.path, projectPath));
  const reviewed = !!file.reviewed;

  return (
    <div className="flex border-b border-border-soft" data-testid="session-change-item">
      <button
        type="button"
        onClick={onClick}
        title={file.path}
        aria-current={selected ? "true" : undefined}
        data-testid="session-change-row"
        className={cn(
          "grid min-w-0 flex-1 grid-cols-[16px_minmax(0,1fr)_auto_12px] items-center gap-2.5 text-left",
          "transition-colors hover:bg-surface",
          dense ? "min-h-9 px-2.5 py-1 text-xs" : "min-h-[52px] px-3 py-1.5 text-[13px]",
          selected && "bg-surface shadow-[inset_2px_0_0_var(--accent)]",
        )}
      >
        <FileIcon name={base} className="size-4" />
        <span className="flex min-w-0 flex-col">
          <span
            className={cn(
              "truncate",
              file.status === "deleted" && "line-through",
              file.status === "deleted" || reviewed ? "text-text-secondary" : "text-text-primary",
            )}
          >
            {base}
          </span>
          {dir && (
            <span className="flex min-w-0 text-[11px] text-text-subtle">
              <StartEllipsis>{dir}</StartEllipsis>
            </span>
          )}
        </span>
        <SessionChangeCounts file={file} className="font-mono text-[11px]" />
        <span aria-label={status.label} title={status.label} className={cn("text-center font-mono text-[11px] font-semibold", status.cls)}>
          {status.glyph}
        </span>
      </button>
      {onToggleReviewed && (
        <button
          type="button"
          role="checkbox"
          aria-checked={reviewed}
          aria-label={`Mark ${base} reviewed`}
          title={reviewed ? "Reviewed — click to bring it back to the list" : "Mark reviewed"}
          onClick={onToggleReviewed}
          className={cn(
            "flex shrink-0 items-center justify-center transition-colors hover:bg-surface",
            dense ? "w-8" : "w-11",
          )}
        >
          <ReviewedBox checked={reviewed} />
        </button>
      )}
    </div>
  );
}
