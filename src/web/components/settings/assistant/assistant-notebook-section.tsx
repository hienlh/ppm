/**
 * Settings → PPM Assistant → Notebook: the short facts the Assistant keeps across a long session.
 * Every line here is editable by the user; what the user adds or edits becomes theirs and
 * verified. The meter counts characters against the notebook's cap, the way the server does,
 * and "Add line" is off once the notebook is full. Updates live from `assistant:notes_changed`.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Plus, ScrollText } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { useAssistantNotes } from "@/hooks/use-assistant-notes";
import { addNote, deleteNote, editNote, verifyNote } from "@/lib/assistant-settings-client";
import { NOTEBOOK_HEADER_LINE } from "../../../../shared/assistant-notes";
import { SettingsCard } from "./assistant-settings-card";
import { NotebookRow } from "./notebook-row";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** "1,400 / 4,000 characters". */
export function notebookMeterLabel(used: number, cap: number): string {
  return `${used.toLocaleString("en-US")} / ${cap.toLocaleString("en-US")} characters`;
}

function Meter({ used, cap }: { used: number; cap: number }) {
  const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
  return (
    <span className="flex items-center gap-2" data-notebook-meter="">
      <span className="tabular-nums">{notebookMeterLabel(used, cap)}</span>
      <span className="h-1 w-24 overflow-hidden rounded-full bg-border" aria-hidden>
        <span className={used > cap ? "block h-full bg-error" : "block h-full bg-primary"} style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}

export function AssistantNotebookSection() {
  const { view, error, reload } = useAssistantNotes();
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);

  const act = async (work: () => Promise<unknown>, failure: string): Promise<boolean> => {
    setBusy(true);
    try {
      await work();
      await reload();
      return true;
    } catch (e) {
      toast.error(failure, { description: errorText(e) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (error && !view) return <p className="text-xs text-error" role="alert">{error}</p>;
  if (!view) return <div className="flex justify-center py-8 text-muted-foreground"><Loader2 className="size-4 animate-spin" /></div>;

  const room = view.cap - view.used;
  const full = room <= 0;
  const addTooLong = adding !== null && (adding.length > view.noteMax || adding.length > room);

  return (
    <div className="space-y-2" data-testid="assistant-notebook-section">
      <SettingsCard icon={ScrollText} title="Notebook" aside={<Meter used={view.used} cap={view.cap} />}>
        <p className="px-3.5 py-2 text-xs text-text-subtle" data-notebook-header="">{NOTEBOOK_HEADER_LINE}</p>
        {view.notes.length === 0 && <p className="px-3.5 py-3 text-sm text-text-subtle">No notes yet.</p>}
        {view.notes.length > 0 && (
          <ul className="divide-y divide-border-soft" aria-label="Notes">
            {view.notes.map((note) => (
              <NotebookRow key={note.id} note={note} noteMax={view.noteMax} busy={busy}
                onEdit={(text) => act(() => editNote(note.id, text), "Could not save the note")}
                onDelete={() => void act(() => deleteNote(note.id), "Could not delete the note")}
                onVerify={() => void act(() => verifyNote(note.id), "Could not mark the note verified")} />
            ))}
          </ul>
        )}
        {adding !== null ? (
          <div className="space-y-1.5 px-3.5 py-2.5">
            <textarea value={adding} rows={2} autoFocus aria-label="New note" disabled={busy}
              placeholder="A fact worth keeping, such as a deadline or how a report should read."
              onChange={(e) => setAdding(e.target.value)}
              className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
            <div className="flex flex-wrap items-center gap-2">
              <span className={addTooLong ? "mr-auto text-xs text-error" : "mr-auto text-xs text-text-subtle"}>
                {adding.length} / {Math.min(view.noteMax, Math.max(room, 0))}
              </span>
              <Button variant="outline" size="sm" className="min-h-11 md:min-h-8" onClick={() => setAdding(null)}>Cancel</Button>
              <Button size="sm" className="min-h-11 md:min-h-8" disabled={busy || addTooLong || !adding.trim()}
                onClick={() => void act(() => addNote(adding), "Could not add the note").then((ok) => { if (ok) setAdding(null); })}>
                Add
              </Button>
            </div>
          </div>
        ) : (
          <div className="px-2 py-1.5">
            <Button variant="ghost" size="sm" className="min-h-11 gap-1 md:min-h-8" disabled={full || busy} onClick={() => setAdding("")}
              title={full ? "The notebook is full. Delete or shorten a line first." : undefined}>
              <Plus className="size-4" />Add line
            </Button>
          </div>
        )}
      </SettingsCard>
    </div>
  );
}
