import { X } from "@/lib/icons";
import { cn } from "@/lib/utils";

/** DBGate's ten, plus none. */
export const CONNECTION_COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e",
  "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899",
  "#6b7280", "#000000",
];

interface ConnectionColorPickerProps {
  value: string | null;
  onChange: (color: string | null) => void;
  labelId: string;
}

/** A connection's color as a row of swatches: a radio group, 44px targets on a phone. */
export function ConnectionColorPicker({ value, onChange, labelId }: ConnectionColorPickerProps) {
  // A color set before the swatches were all there was stays on offer, so it is shown picked.
  const custom = value && !CONNECTION_COLORS.includes(value) ? [value] : [];
  const options: Array<string | null> = [null, ...CONNECTION_COLORS, ...custom];
  const picked = value;

  const move = (e: React.KeyboardEvent, from: string | null) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = options[(options.indexOf(from) + step + options.length) % options.length]!;
    onChange(next);
    (e.currentTarget.parentElement?.querySelector(`[data-color="${next ?? ""}"]`) as HTMLElement | null)?.focus();
  };

  return (
    <div role="radiogroup" aria-labelledby={labelId} className="flex flex-wrap items-center gap-2 min-h-[30px]">
      {options.map((color) => {
        const checked = color === picked;
        const label = color ?? "No color";
        return (
          <button
            key={label}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={label}
            title={label}
            tabIndex={checked ? 0 : -1}
            data-color={color ?? ""}
            onClick={() => onChange(color)}
            onKeyDown={(e) => move(e, color)}
            className={cn(
              "grid place-items-center size-11 md:size-[22px] rounded-full",
              color ? "shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-text)_18%,transparent)]" : "border-[1.5px] border-dashed border-text-subtle text-text-subtle",
              checked && "ring-2 ring-text-2 ring-offset-2 ring-offset-background",
            )}
            style={color ? { backgroundColor: color } : undefined}
          >
            {!color && <X className="size-4 md:size-3" />}
          </button>
        );
      })}
    </div>
  );
}
