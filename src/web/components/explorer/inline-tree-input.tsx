/**
 * InlineTreeInput — inline input for creating/renaming files in the tree.
 * Renders at the correct tree depth with auto-focus.
 * Blur or Enter confirms, Escape cancels.
 */
import { useState, useRef, useEffect, useCallback } from "react";
import { File, Folder } from "lucide-react";
import { cn } from "@/lib/utils";

interface InlineTreeInputProps {
  defaultValue: string;
  placeholder: string;
  depth: number;
  icon: "file" | "folder";
  onConfirm: (value: string) => Promise<void>;
  onCancel: () => void;
}

export function InlineTreeInput({
  defaultValue,
  placeholder,
  depth,
  icon,
  onConfirm,
  onCancel,
}: InlineTreeInputProps) {
  const [value, setValue] = useState(defaultValue);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmedRef = useRef(false);

  useEffect(() => {
    // Auto-focus and select filename (before last dot) for rename
    const el = inputRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.focus();
      if (defaultValue) {
        const dotIdx = defaultValue.lastIndexOf(".");
        el.setSelectionRange(0, dotIdx > 0 ? dotIdx : defaultValue.length);
      }
    });
  }, [defaultValue]);

  const doConfirm = useCallback(async () => {
    if (confirmedRef.current || submitting) return;
    const trimmed = value.trim();
    if (!trimmed) {
      onCancel();
      return;
    }
    confirmedRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm(trimmed);
    } catch (err) {
      confirmedRef.current = false;
      setError(err instanceof Error ? err.message : "Failed");
      setSubmitting(false);
    }
  }, [value, submitting, onConfirm, onCancel]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      doConfirm();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  }

  function handleBlur() {
    // Blur = confirm (VS Code style)
    if (!confirmedRef.current) {
      doConfirm();
    }
  }

  const Icon = icon === "folder" ? Folder : File;

  return (
    <div>
      <div
        className={cn(
          "flex items-center w-full gap-1.5 px-2 py-0.5",
          "min-h-[32px] text-left",
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        <span className="w-3.5 shrink-0" />
        <Icon className="size-4 shrink-0 text-text-secondary" />
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => { setValue(e.target.value); setError(null); }}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          placeholder={placeholder}
          disabled={submitting}
          className={cn(
            "flex-1 min-w-0 bg-input text-sm px-1.5 py-0.5 rounded border outline-none",
            "focus:ring-1 focus:ring-primary/50",
            error ? "border-destructive" : "border-primary",
          )}
        />
      </div>
      {error && (
        <p
          className="text-[10px] text-destructive truncate"
          style={{ paddingLeft: `${depth * 16 + 8 + 14 + 22}px` }}
        >
          {error}
        </p>
      )}
    </div>
  );
}
