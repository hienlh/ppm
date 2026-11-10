/**
 * The text area and the size counter the rules and template dialogs share. Size is counted in
 * UTF-8 bytes against the 16 KB cap, the way the server counts it.
 */
import { useId } from "react";
import { cn } from "@/lib/utils";
import { RULES_FILE_MAX_BYTES } from "../../../../shared/assistant-limits";

export function RulesTextarea({ label, value, disabled, onChange }: {
  label: string;
  value: string;
  disabled?: boolean;
  onChange: (text: string) => void;
}) {
  const id = useId();
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block font-mono text-xs text-text-subtle">{label}</label>
      <textarea
        id={id}
        value={value}
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        className="h-[min(18rem,40dvh)] w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </div>
  );
}

/** "3.2 KB / 16 KB", red past the cap. */
export function SizeCounter({ bytes }: { bytes: number }) {
  const over = bytes > RULES_FILE_MAX_BYTES;
  return (
    <p className={cn("text-xs", over ? "text-error" : "text-text-subtle")} data-size-counter="">
      {(bytes / 1024).toFixed(1)} KB / {RULES_FILE_MAX_BYTES / 1024} KB{over ? " — too large to save" : ""}
    </p>
  );
}
