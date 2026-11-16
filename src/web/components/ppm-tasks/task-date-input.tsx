/**
 * A date field that saves once, not per keystroke: typing a year in a native date input passes
 * through `0002-…`, `0020-…`, and each of those would be a write, a history row and a "Tell the
 * manager now?". The draft is local; it saves on blur or Enter, and only a whole `YYYY-MM-DD` from
 * 1900 on (or an empty field, which clears the date).
 *
 * A field removed while it holds an unsaved date (its popover closed, another task shown in it)
 * saves that date on the way out, and a save that did not land is sent again on the next blur
 * (`useSavedDraft`).
 */
import { useSavedDraft } from "./use-saved-draft";

export function isSaveableDate(v: string): boolean {
  if (v === "") return true;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  return !!m && Number(m[1]) >= 1900;
}

export function TaskDateInput({ value, onSave, label, className }: {
  /** `onSave` may answer the write: `null` when it did not land. */
  value: string | null; onSave(v: string | null): unknown; label: string; className?: string;
}) {
  const { draft, setDraft, commit } = useSavedDraft({ shown: value ?? "", accept: isSaveableDate, onSave: (v) => onSave(v || null) });
  return (
    <input aria-label={label} type="date" className={className} value={draft}
      onChange={(e) => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
  );
}
