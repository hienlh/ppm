/**
 * The in-place text field used for both renaming an entry and naming a new one.
 *
 * Renaming preselects the stem (not the extension), which is what Explorer and Finder do
 * and what makes "fix the typo in the name" a single gesture.
 */

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export interface InlineNameInputProps {
  initial: string;
  /** Error from the last rejected commit; keeps the field open and explains why. */
  error?: string | null;
  onCommit(value: string): void;
  onCancel(): void;
  className?: string;
}

export function InlineNameInput({ initial, error, onCommit, onCancel, className }: InlineNameInputProps) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    const dot = initial.lastIndexOf(".");
    if (dot > 0) input.setSelectionRange(0, dot);
    else input.select();
  }, [initial]);

  return (
    <div className="relative flex-1 min-w-0">
      <input
        ref={ref}
        value={value}
        aria-label="Name"
        aria-invalid={!!error}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => onCommit(value)}
        onKeyDown={(e) => {
          e.stopPropagation(); // the view container owns the same keys for navigation
          if (e.key === "Enter") onCommit(value);
          else if (e.key === "Escape") onCancel();
        }}
        className={cn(
          "w-full rounded-[var(--rad-sm)] border bg-panel px-1.5 py-0.5 text-[13px] text-text outline-none",
          error ? "border-error" : "border-primary",
          className,
        )}
      />
      {error && (
        <span className="absolute left-0 top-full z-10 mt-0.5 rounded border border-border bg-panel-2 px-1.5 py-0.5 text-[11px] text-error shadow-sm">
          {error}
        </span>
      )}
    </div>
  );
}
