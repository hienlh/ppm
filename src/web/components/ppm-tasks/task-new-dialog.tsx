/**
 * New task: title, the project (in the all-projects scope), type, urgency, importance and due
 * date. Everything else is edited on the task once it exists. A new task opens in a kept tab.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { IMPORTANCE_LABEL, URGENCY_LABEL, typeLabel } from "@/lib/ppm-tasks/ppm-tasks-kit-logic";
import { IMPORTANCES, TASK_TYPES, URGENCIES, type Importance, type Urgency } from "../../../shared/ppm-tasks";
import type { TaskDto, TaskProjectSummary } from "../../../shared/ppm-tasks-api";
import type { TaskScope } from "@/stores/ppm-tasks-view-store";
import { useTaskWrite } from "./use-task-write";

export interface TaskNewDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  scope: TaskScope;
  project: string | null;
  projects: readonly TaskProjectSummary[];
  /** A parent makes the new task its child (Child tasks → Add child). */
  parent?: Pick<TaskDto, "id" | "project" | "ref"> | null;
  onCreated(task: TaskDto): void;
}

const field = "h-9 w-full rounded-md border border-border-soft bg-surface px-2.5 text-sm text-text outline-none focus:border-ring";
const label = "mb-1 block text-xs font-medium text-text-2";

export function TaskNewDialog({ open, onOpenChange, scope, project, projects, parent, onCreated }: TaskNewDialogProps) {
  const { run, actions } = useTaskWrite();
  const fixedProject = parent?.project ?? (scope === "project" ? project : null);
  const [title, setTitle] = useState("");
  const [target, setTarget] = useState<string>(fixedProject ?? project ?? "");
  const [type, setType] = useState<string>("task");
  const [urgency, setUrgency] = useState<Urgency>("week");
  const [importance, setImportance] = useState<Importance>("should");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(""); setType("task"); setUrgency("week"); setImportance("should"); setDue("");
    const enabled = projects.map((p) => p.name);
    setTarget(fixedProject ?? (project && enabled.includes(project) ? project : enabled[0] ?? ""));
  }, [open, fixedProject, project, projects]);

  const submit = async () => {
    if (!title.trim() || !target) return;
    setBusy(true);
    const r = await run(null, () => actions.create({
      project: target, title: title.trim(), type, urgency, importance,
      ...(due ? { dueDate: due } : {}), ...(parent ? { parentId: parent.id } : {}),
    }));
    setBusy(false);
    if (!r) return;
    toast.success(`Created ${r.task.ref}`);
    onOpenChange(false);
    onCreated(r.task);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-task-new-dialog="">
        <DialogHeader><DialogTitle>{parent ? `New child of ${parent.ref}` : "New task"}</DialogTitle></DialogHeader>
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <div>
            <label className={label} htmlFor="task-new-title">Title</label>
            <input id="task-new-title" autoFocus className={field} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing" />
          </div>
          {!fixedProject && (
            <div>
              <label className={label} htmlFor="task-new-project">Project</label>
              <select id="task-new-project" className={field} value={target} onChange={(e) => setTarget(e.target.value)}>
                {projects.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
              </select>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label} htmlFor="task-new-type">Type</label>
              <select id="task-new-type" className={field} value={type} onChange={(e) => setType(e.target.value)}>
                {TASK_TYPES.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}
              </select>
            </div>
            <div>
              <label className={label} htmlFor="task-new-due">Due</label>
              <input id="task-new-due" type="date" className={field} value={due} onChange={(e) => setDue(e.target.value)} />
            </div>
            <div>
              <label className={label} htmlFor="task-new-urgency">Urgency</label>
              <select id="task-new-urgency" className={field} value={urgency} onChange={(e) => setUrgency(e.target.value as Urgency)}>
                {URGENCIES.map((u) => <option key={u} value={u}>{URGENCY_LABEL[u]}</option>)}
              </select>
            </div>
            <div>
              <label className={label} htmlFor="task-new-importance">Importance</label>
              <select id="task-new-importance" className={field} value={importance} onChange={(e) => setImportance(e.target.value as Importance)}>
                {IMPORTANCES.map((i) => <option key={i} value={i}>{IMPORTANCE_LABEL[i]}</option>)}
              </select>
            </div>
          </div>
          {type === "decision" && <p className="text-xs text-text-3">Add the options on the task once it exists, or let the manager prepare them.</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !title.trim() || !target}>Create task</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
