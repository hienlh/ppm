/**
 * A project's statuses: name, the base group it belongs to (what all-projects views merge on),
 * done/dropped for a closed one, order, and delete — a status tasks still use needs another one
 * to move them to.
 */
import { useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import type { BaseGroup, ClosedAs, TaskStatusDef } from "../../../../shared/ppm-tasks";
import type { TaskProjectSettingsUpdate } from "../../../../shared/ppm-tasks-api";
import { CommitInput, EditorHint, SmallSelect, rowBtn } from "./task-settings-parts";

const GROUPS: Array<{ value: BaseGroup; label: string }> = [
  { value: "not_started", label: "Not started" }, { value: "active", label: "Active" },
  { value: "waiting", label: "Waiting" }, { value: "closed", label: "Closed" },
];
const CLOSED: Array<{ value: ClosedAs; label: string }> = [{ value: "done", label: "Done" }, { value: "dropped", label: "Dropped" }];

export function TaskStatusesEditor({ statuses, save }: { statuses: TaskStatusDef[]; save(u: TaskProjectSettingsUpdate): void }) {
  const sorted = [...statuses].sort((a, b) => a.position - b.position);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [replacement, setReplacement] = useState("");
  const move = (i: number, delta: -1 | 1) => {
    const a = sorted[i]!;
    const b = sorted[i + delta];
    if (!b) return;
    save({ statuses: { update: [{ id: a.id, position: b.position }, { id: b.id, position: a.position }] } });
  };
  return (
    <div className="space-y-2" data-task-statuses-editor="">
      <EditorHint>Every status belongs to a base group, so lists across projects can merge them.</EditorHint>
      {sorted.map((s, i) => (
        <div key={s.id} className="space-y-1.5">
          <div className="grid grid-cols-[minmax(0,1fr)_7.5rem_6rem_auto] items-center gap-1.5">
            <CommitInput label="Status name" value={s.name} required onCommit={(name) => save({ statuses: { update: [{ id: s.id, name }] } })} />
            <SmallSelect label="Base group" value={s.baseGroup} options={GROUPS}
              onChange={(baseGroup) => save({ statuses: { update: [{ id: s.id, baseGroup, closedAs: baseGroup === "closed" ? s.closedAs ?? "done" : null }] } })} />
            {s.baseGroup === "closed"
              ? <SmallSelect label="Closed as" value={s.closedAs ?? "done"} options={CLOSED} onChange={(closedAs) => save({ statuses: { update: [{ id: s.id, closedAs }] } })} />
              : <span />}
            <span className="flex">
              <button type="button" className={rowBtn} aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="size-3.5" /></button>
              <button type="button" className={rowBtn} aria-label="Move down" disabled={i === sorted.length - 1} onClick={() => move(i, 1)}><ArrowDown className="size-3.5" /></button>
              <button type="button" className={rowBtn} aria-label={`Delete ${s.name}`} disabled={sorted.length <= 1}
                onClick={() => { setDeleting(s.id); setReplacement(sorted.find((x) => x.id !== s.id)?.id ?? ""); }}><Trash2 className="size-3.5" /></button>
            </span>
          </div>
          {deleting === s.id && (
            <div className="flex flex-wrap items-center gap-1.5 rounded-md bg-surface p-2 text-xs text-text-2">
              Move its tasks to
              <SmallSelect label="Replacement status" value={replacement} className="w-36" onChange={setReplacement}
                options={sorted.filter((x) => x.id !== s.id).map((x) => ({ value: x.id, label: x.name }))} />
              <Button size="xs" variant="destructive" onClick={() => { save({ statuses: { delete: [{ id: s.id, replacementId: replacement || null }] } }); setDeleting(null); }}>Delete</Button>
              <Button size="xs" variant="ghost" onClick={() => setDeleting(null)}>Cancel</Button>
            </div>
          )}
        </div>
      ))}
      <Button size="sm" variant="outline" onClick={() => save({ statuses: { add: [{ name: "New status", baseGroup: "not_started" }] } })}>
        <Plus className="size-3.5" />Add status
      </Button>
    </div>
  );
}
