/**
 * Small inputs the task settings editors share: a text field that saves when it loses focus (and
 * only if it changed), a select, and the editors' row button style.
 */
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export const inputCls = "h-8 w-full min-w-0 rounded-md border border-border-soft bg-surface px-2 text-xs text-text outline-none focus:border-ring";
export const rowBtn = "grid size-8 shrink-0 place-items-center rounded-md text-text-3 hover:bg-surface-hover hover:text-text disabled:opacity-30";

/** Saves on blur or Enter, only when the text changed; an empty value is refused when `required`. */
export function CommitInput({ value, onCommit, placeholder, required, label, className }: {
  value: string; onCommit(v: string): void; placeholder?: string; required?: boolean; label: string; className?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const v = draft.trim();
    if (v === value.trim()) return;
    if (required && !v) { setDraft(value); return; }
    onCommit(v);
  };
  return (
    <input aria-label={label} className={cn(inputCls, className)} value={draft} placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
  );
}

export function SmallSelect<T extends string>({ value, options, onChange, label, className }: {
  value: T; options: ReadonlyArray<{ value: T; label: string }>; onChange(v: T): void; label: string; className?: string;
}) {
  return (
    <select aria-label={label} className={cn(inputCls, "pr-1", className)} value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function EditorHint({ children }: { children: ReactNode }) {
  return <p className="text-xs text-text-3">{children}</p>;
}
