/**
 * A task's custom fields in its properties: the project's declared fields typed (text, number,
 * select, date, link) with "Manage" opening the project's field settings, then "Other fields · not
 * declared": anything the task carries under a key the project never declared, shown raw and kept
 * untouched by every write.
 */
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { FieldDef, FieldValue } from "../../../shared/ppm-tasks";

const input = "h-7 w-full min-w-0 rounded-md border border-transparent bg-transparent px-1.5 text-[13px] text-text outline-none hover:border-border-soft focus:border-ring focus:bg-surface";

function FieldInput({ def, value, onSave }: { def: FieldDef; value: FieldValue | undefined; onSave(v: FieldValue): void }) {
  const shown = value === null || value === undefined ? "" : String(value);
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const commit = (next = draft) => {
    const t = next.trim();
    if (t === shown) return;
    if (!t) return onSave(null);
    if (def.type === "number") {
      const n = Number(t);
      if (Number.isFinite(n)) onSave(n);
      else setDraft(shown);
      return;
    }
    onSave(t);
  };
  const label = `${def.label} (${def.type})`;
  if (def.type === "select") {
    return (
      <select aria-label={label} className={cn(input, "pr-1")} value={draft} onChange={(e) => { setDraft(e.target.value); commit(e.target.value); }}>
        <option value="">—</option>
        {(def.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        {draft && !(def.options ?? []).includes(draft) && <option value={draft}>{draft}</option>}
      </select>
    );
  }
  return (
    <input aria-label={label} className={input} value={draft} inputMode={def.type === "number" ? "decimal" : undefined}
      type={def.type === "date" ? "date" : "text"} placeholder="—"
      onChange={(e) => { setDraft(e.target.value); if (def.type === "date") commit(e.target.value); }}
      onBlur={() => commit()} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
  );
}

export interface TaskCustomFieldsProps {
  project: string;
  defs: readonly FieldDef[];
  values: Record<string, FieldValue>;
  onSave(key: string, value: FieldValue): void;
  onManage(): void;
}

export function TaskCustomFields({ project, defs, values, onSave, onManage }: TaskCustomFieldsProps) {
  const sorted = [...defs].sort((a, b) => a.position - b.position);
  const declared = new Set(sorted.map((d) => d.key));
  const other = Object.entries(values).filter(([k]) => !declared.has(k));
  return (
    <div className="space-y-3" data-task-custom-fields="">
      <div>
        <div className="mb-1 flex items-center text-[11px] font-semibold uppercase tracking-wide text-text-3">
          Fields · {project}<span className="flex-1" />
          <button type="button" onClick={onManage} className="normal-case tracking-normal text-primary hover:underline">Manage</button>
        </div>
        {sorted.length === 0 && <p className="text-xs text-text-3">No fields declared for this project.</p>}
        {sorted.map((d) => (
          <div key={d.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] items-center gap-2 py-0.5">
            <span className="truncate text-[13px] text-text" title={d.key}>{d.label} <span className="font-mono text-[11px] text-text-3">{d.type}</span></span>
            <FieldInput def={d} value={values[d.key]} onSave={(v) => onSave(d.key, v)} />
          </div>
        ))}
      </div>
      {other.length > 0 && (
        <div>
          <div className="mb-1 flex text-[11px] font-semibold uppercase tracking-wide text-text-3">Other fields<span className="flex-1" /><span className="normal-case tracking-normal font-normal">not declared</span></div>
          {other.map(([k, v]) => (
            <div key={k} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] gap-2 py-0.5 font-mono text-xs" data-undeclared-field={k}>
              <span className="truncate text-text-2" title={k}>{k}</span>
              <span className="break-all text-text">{JSON.stringify(v)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
