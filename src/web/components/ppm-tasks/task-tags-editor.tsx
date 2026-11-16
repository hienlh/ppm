/**
 * A task's tags as chips, each removable, with a field that adds one on Enter or comma.
 */
import { useState } from "react";
import { X } from "@/lib/icons";
import { PPM_TASK_LIMITS } from "../../../shared/ppm-tasks";

export function TaskTagsEditor({ tags, onSave }: { tags: readonly string[]; onSave(tags: string[]): void }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const t = draft.trim().replace(/,$/, "").trim().slice(0, PPM_TASK_LIMITS.tag);
    setDraft("");
    if (!t || tags.includes(t) || tags.length >= PPM_TASK_LIMITS.tags) return;
    onSave([...tags, t]);
  };
  return (
    <div className="flex flex-wrap items-center gap-1" data-task-tags="">
      {tags.map((t) => (
        <span key={t} className="inline-flex h-6 items-center gap-0.5 rounded-md bg-surface pl-1.5 pr-0.5 text-xs text-text-2">
          {t}
          <button type="button" aria-label={`Remove tag ${t}`} onClick={() => onSave(tags.filter((x) => x !== t))}
            className="grid size-5 place-items-center rounded text-text-3 hover:text-text"><X className="size-3" /></button>
        </span>
      ))}
      <input aria-label="Add tag" value={draft} placeholder={tags.length ? "+ tag" : "Add a tag"} onChange={(e) => setDraft(e.target.value)} onBlur={add}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); } }}
        className="h-6 min-w-16 flex-1 rounded-md border border-transparent bg-transparent px-1 text-xs text-text outline-none hover:border-border-soft focus:border-ring" />
    </div>
  );
}
