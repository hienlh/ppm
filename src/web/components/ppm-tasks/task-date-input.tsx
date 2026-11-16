/**
 * A date field that saves once, not per keystroke: typing a year in a native date input passes
 * through `0002-…`, `0020-…`, and each of those would be a write, a history row and a "Tell the
 * manager now?". The draft is local; it saves on blur, Enter or the picker's choice, and only a
 * whole `YYYY-MM-DD` from 1900 on (or an empty field, which clears the date).
 */
import { useEffect, useState } from "react";

export function isSaveableDate(v: string): boolean {
  if (v === "") return true;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  return !!m && Number(m[1]) >= 1900;
}

export function TaskDateInput({ value, onSave, label, className }: {
  value: string | null; onSave(v: string | null): void; label: string; className?: string;
}) {
  const shown = value ?? "";
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const commit = (v = draft) => {
    if (v === shown || !isSaveableDate(v)) { if (!isSaveableDate(v)) setDraft(shown); return; }
    onSave(v || null);
  };
  return (
    <input aria-label={label} type="date" className={className} value={draft}
      onChange={(e) => setDraft(e.target.value)} onBlur={() => commit()}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
  );
}
