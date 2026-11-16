/**
 * Notes: Why, Next step and free notes, plain text. Edit opens all three at once and saves the
 * ones that changed in one write.
 */
import { useState } from "react";
import { Pencil } from "@/lib/icons";
import { PPM_TASK_LIMITS, type TaskPatch } from "../../../shared/ppm-tasks";
import type { TaskDto } from "../../../shared/ppm-tasks-api";
import { CardTextButton, TaskCard } from "./task-card";
import { Button } from "@/components/ui/button";

const area = "w-full resize-y rounded-md border border-border-soft bg-surface px-2 py-1.5 text-[13px] text-text outline-none focus:border-ring";

export function TaskNotesCard({ task, onSave }: { task: TaskDto; onSave(patch: TaskPatch): void }) {
  const [editing, setEditing] = useState(false);
  const [why, setWhy] = useState("");
  const [next, setNext] = useState("");
  const [notes, setNotes] = useState("");
  const start = () => { setWhy(task.why ?? ""); setNext(task.nextStep ?? ""); setNotes(task.notes ?? ""); setEditing(true); };
  const save = () => {
    const norm = (s: string) => (s.trim() ? s.trim() : null);
    const patch: TaskPatch = {};
    if (norm(why) !== task.why) patch.why = norm(why);
    if (norm(next) !== task.nextStep) patch.nextStep = norm(next);
    if (norm(notes) !== task.notes) patch.notes = norm(notes);
    setEditing(false);
    if (Object.keys(patch).length) onSave(patch);
  };
  const empty = !task.why && !task.nextStep && !task.notes;
  return (
    <TaskCard title="Notes" data-task-card="notes" aside={!editing && <CardTextButton onClick={start}><Pencil className="size-3" />Edit</CardTextButton>}>
      {editing ? (
        <div className="space-y-2">
          <label className="block text-xs font-medium text-text-2">Why
            <textarea aria-label="Why" rows={2} maxLength={PPM_TASK_LIMITS.why} value={why} onChange={(e) => setWhy(e.target.value)} className={`${area} mt-1`} />
          </label>
          <label className="block text-xs font-medium text-text-2">Next step
            <textarea aria-label="Next step" rows={2} maxLength={PPM_TASK_LIMITS.nextStep} value={next} onChange={(e) => setNext(e.target.value)} className={`${area} mt-1`} />
          </label>
          <label className="block text-xs font-medium text-text-2">Notes
            <textarea aria-label="Notes" rows={4} maxLength={PPM_TASK_LIMITS.notes} value={notes} onChange={(e) => setNotes(e.target.value)} className={`${area} mt-1`} />
          </label>
          <div className="flex justify-end gap-1.5">
            <Button size="xs" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            <Button size="xs" onClick={save}>Save</Button>
          </div>
        </div>
      ) : empty ? (
        <button type="button" onClick={start} className="text-[13px] text-text-3 hover:text-text">Add why, the next step or notes</button>
      ) : (
        <div className="space-y-2 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-text-2">
          {task.why && <p><b className="font-semibold text-text">Why:</b> {task.why}</p>}
          {task.nextStep && <p><b className="font-semibold text-text">Next step:</b> {task.nextStep}</p>}
          {task.notes && <p>{task.notes}</p>}
        </div>
      )}
    </TaskCard>
  );
}
