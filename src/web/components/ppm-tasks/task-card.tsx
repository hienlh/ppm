/**
 * The bordered card every section of a task's page sits in ("Notes", "Links 3 · checked 2 min ago
 * · + Add"), and the plain-text editor the editable cards share: Save / Cancel, Ctrl+Enter saves,
 * Escape cancels. Task text is shown as plain text, never rendered as Markdown or HTML.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function TaskCard({ title, count, aside, children, className, tone, ...rest }: {
  title: ReactNode; count?: number | string; aside?: ReactNode; children: ReactNode; className?: string;
  tone?: "decision"; "data-task-card"?: string;
}) {
  return (
    <section {...rest} className={cn("overflow-hidden rounded-lg border border-border-soft bg-panel", tone === "decision" && "border-accent-2/40", className)}>
      <header className={cn("flex min-h-10 flex-wrap items-center gap-2 border-b border-border-soft px-3 py-1.5 text-[13px] font-semibold text-text",
        tone === "decision" && "bg-accent-2/10 text-accent-2")}>
        {title}
        {count !== undefined && <span className="rounded bg-surface px-1.5 font-mono text-[11px] font-normal text-text-3">{count}</span>}
        <span className="flex-1" />
        {aside}
      </header>
      <div className="px-3 py-2.5">{children}</div>
    </section>
  );
}

/**
 * A card's text action (Edit, + Add, Record result). It never shrinks: whatever shares its row (a
 * card title, who-and-when) gives way instead. On a phone the task page makes it 44 × 44
 * (`THUMB_CARDS` in mobile/task-detail-mobile-details.tsx).
 */
export function CardTextButton({ children, onClick, disabled }: { children: ReactNode; onClick(): void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} data-card-text-button=""
      className="inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 text-xs font-normal text-primary hover:bg-accent-wash disabled:opacity-40">
      {children}
    </button>
  );
}

/** A plain-text field with Save / Cancel. */
export function PlainTextEditor({ value, label, placeholder, rows = 3, maxLength, onSave, onCancel }: {
  value: string; label: string; placeholder?: string; rows?: number; maxLength?: number; onSave(v: string): void; onCancel(): void;
}) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div className="space-y-1.5">
      <textarea ref={ref} aria-label={label} rows={rows} maxLength={maxLength} placeholder={placeholder} value={draft} onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) onSave(draft);
        }}
        className="w-full resize-y rounded-md border border-border-soft bg-surface px-2 py-1.5 text-[13px] text-text outline-none focus:border-ring" />
      <div className="flex justify-end gap-1.5">
        <Button size="xs" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button size="xs" onClick={() => onSave(draft)}>Save</Button>
      </div>
    </div>
  );
}
