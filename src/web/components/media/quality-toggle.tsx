import { Loader2 } from "@/lib/icons";
import { TEXT_CONTROL_HEIGHT } from "@/lib/control-size";
import { cn } from "@/lib/utils";
import type { VideoQuality } from "../../../shared/card-files";

/**
 * Original / Smooth, as two halves of one chip (docs/design-guidelines.md rule 3: 28px, 26px on
 * a phone). Shared by a report card's file viewer and the File Explorer's video preview.
 * `smoothPending` shows Smooth as being prepared and not pressable yet.
 */
export function QualityToggle({ value, onChange, smoothPending = false, className }: {
  value: VideoQuality;
  onChange: (q: VideoQuality) => void;
  smoothPending?: boolean;
  className?: string;
}) {
  const half = (q: VideoQuality, label: string, title: string, disabled = false) => (
    <button
      type="button"
      aria-pressed={value === q}
      disabled={disabled}
      title={title}
      onClick={() => onChange(q)}
      data-quality={q}
      className={cn(
        TEXT_CONTROL_HEIGHT,
        "inline-flex items-center gap-1 px-2.5 text-[11.5px] font-medium transition-colors max-md:px-2 disabled:cursor-default disabled:opacity-60",
        value === q ? "bg-primary text-primary-foreground" : "text-text-secondary hover:bg-surface-hover",
      )}
    >
      {label}
    </button>
  );
  return (
    <div role="group" aria-label="Video quality" data-quality-toggle={value}
      className={cn("inline-flex shrink-0 overflow-hidden rounded-full border border-border bg-panel-2", className)}>
      {half("original", "Original", "The file as it is: best picture, needs a fast link")}
      {smoothPending
        ? (
          <span className={cn(TEXT_CONTROL_HEIGHT, "inline-flex items-center gap-1 px-2.5 text-[11.5px] text-text-subtle max-md:px-2")} data-quality="smooth" aria-disabled="true" title="The smooth copy is being prepared">
            <Loader2 className="size-3 animate-spin" />Smooth
          </span>
        )
        : half("smooth", "Smooth", "About 4 Mbit/s at the same resolution: plays without stalling on a slow link")}
    </div>
  );
}
