/**
 * One notebook line: its text (plain text, never markup), who wrote it and when, an
 * "Unverified" label on a line the Assistant wrote while nobody was there with "Mark as
 * verified", and edit / delete buttons that are 44px on touch. Editing happens in place; a saved
 * edit makes the line the user's and verified.
 */
import { useState } from "react";
import { Check, Pencil, ShieldCheck, Trash2, X } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { NOTE_UNVERIFIED_LABEL, type AssistantNote } from "../../../../shared/assistant-notes";
import { shortDate } from "./assistant-session-picker";

/** "You · 04/11" or "Assistant · 10/11". */
export function noteSourceLabel(note: Pick<AssistantNote, "source" | "updatedAt">): string {
  const at = new Date(note.updatedAt);
  const date = Number.isNaN(at.getTime()) ? "" : shortDate(at.toISOString());
  return `${note.source === "user" ? "You" : "Assistant"}${date ? ` · ${date}` : ""}`;
}

const ICON_BUTTON = "size-11 shrink-0 md:size-8";

export function NotebookRow({ note, noteMax, busy, onEdit, onDelete, onVerify }: {
  note: AssistantNote;
  noteMax: number;
  busy: boolean;
  onEdit: (text: string) => Promise<boolean>;
  onDelete: () => void;
  onVerify: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  if (draft !== null) {
    const tooLong = draft.length > noteMax;
    const save = async () => { if (await onEdit(draft)) setDraft(null); };
    return (
      <li className="space-y-1.5 px-3.5 py-2.5" data-note-id={note.id}>
        <textarea value={draft} rows={2} autoFocus aria-label="Edit note" disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") setDraft(null); if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!tooLong && draft.trim()) void save(); } }}
          className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        <div className="flex items-center gap-2">
          <span className={cn("mr-auto text-xs", tooLong ? "text-error" : "text-text-subtle")}>{draft.length} / {noteMax}</span>
          <Button variant="ghost" size="icon" className={ICON_BUTTON} aria-label="Cancel edit" onClick={() => setDraft(null)}><X className="size-4" /></Button>
          <Button variant="ghost" size="icon" className={ICON_BUTTON} aria-label="Save note" disabled={busy || tooLong || !draft.trim()} onClick={() => void save()}>
            <Check className="size-4" />
          </Button>
        </div>
      </li>
    );
  }

  return (
    <li className="flex items-start gap-2.5 px-3.5 py-2 text-sm leading-relaxed" data-note-id={note.id}>
      <div className="min-w-0 flex-1 py-1.5">
        <p className="whitespace-pre-wrap break-words">{note.text}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-text-subtle">
          <span>{noteSourceLabel(note)}</span>
          {note.unverified && (
            <>
              <span className="rounded bg-warning/15 px-1.5 font-medium leading-5 text-warning" data-unverified="">{NOTE_UNVERIFIED_LABEL}</span>
              <button type="button" onClick={onVerify} disabled={busy}
                className="inline-flex min-h-11 items-center gap-1 font-medium text-primary hover:underline md:min-h-6">
                <ShieldCheck className="size-3.5" />Mark as verified
              </button>
            </>
          )}
        </p>
      </div>
      <div className="flex shrink-0 items-center text-text-subtle">
        <Button variant="ghost" size="icon" className={ICON_BUTTON} aria-label="Edit note" disabled={busy} onClick={() => setDraft(note.text)}>
          <Pencil className="size-4" />
        </Button>
        <Button variant="ghost" size="icon" className={cn(ICON_BUTTON, "hover:text-error")} aria-label="Delete note" disabled={busy} onClick={onDelete}>
          <Trash2 className="size-4" />
        </Button>
      </div>
    </li>
  );
}
