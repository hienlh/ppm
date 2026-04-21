/**
 * glob-list-editor.tsx
 * Reusable list editor for glob pattern arrays (filesExclude, searchExclude, etc).
 * Supports add, remove, inline edit, keyboard shortcuts (Enter=add, Backspace on empty=remove).
 */

import { useRef } from "react";
import { Plus, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface GlobListEditorProps {
  /** Current pattern list */
  value: string[];
  /** Called with updated list on any change */
  onChange: (next: string[]) => void;
  /** Placeholder text for each input row */
  placeholder?: string;
  /** Disabled state */
  disabled?: boolean;
}

/**
 * Vertical list editor for glob patterns.
 * - Each row: Input + Remove button (min 44px touch target)
 * - Footer: "Add pattern" button
 * - Enter on last row adds new; Backspace on empty row removes it
 */
export function GlobListEditor({
  value,
  onChange,
  placeholder = "e.g. **/*.log",
  disabled = false,
}: GlobListEditorProps) {
  // Refs for auto-focusing newly added rows
  const rowRefs = useRef<(HTMLInputElement | null)[]>([]);

  function handleChange(idx: number, text: string) {
    const next = [...value];
    next[idx] = text;
    onChange(next);
  }

  function handleRemove(idx: number) {
    const next = value.filter((_, i) => i !== idx);
    onChange(next);
    // Focus previous row or add-button area after removal
    setTimeout(() => {
      const prevIdx = Math.max(idx - 1, 0);
      rowRefs.current[prevIdx]?.focus();
    }, 0);
  }

  function handleAdd() {
    onChange([...value, ""]);
    // Focus the new row after render
    setTimeout(() => {
      rowRefs.current[value.length]?.focus();
    }, 0);
  }

  function handleKeyDown(idx: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      // Only add if current row is non-empty
      if (value[idx]?.trim()) {
        handleAdd();
      }
    } else if (e.key === "Backspace" && value[idx] === "") {
      e.preventDefault();
      handleRemove(idx);
    }
  }

  return (
    <div className="space-y-1.5">
      {value.length === 0 && (
        <p className="text-[11px] text-muted-foreground py-1">
          No patterns. Click "Add pattern" to start.
        </p>
      )}

      {value.map((pattern, idx) => (
        <div key={idx} className="flex items-center gap-1.5">
          <Input
            ref={(el) => { rowRefs.current[idx] = el; }}
            value={pattern}
            onChange={(e) => handleChange(idx, e.target.value)}
            onKeyDown={(e) => handleKeyDown(idx, e)}
            placeholder={placeholder}
            disabled={disabled}
            className="h-8 text-xs flex-1 font-mono"
            aria-label={`Pattern ${idx + 1}`}
          />
          {/* Remove button — min 44px touch target via p-2.5 */}
          <button
            type="button"
            onClick={() => handleRemove(idx)}
            disabled={disabled}
            aria-label={`Remove pattern ${idx + 1}`}
            className="shrink-0 flex items-center justify-center p-2.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-40 disabled:pointer-events-none"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleAdd}
        disabled={disabled}
        className="h-8 text-xs gap-1.5 w-full cursor-pointer"
      >
        <Plus className="size-3.5" />
        Add pattern
      </Button>
    </div>
  );
}
