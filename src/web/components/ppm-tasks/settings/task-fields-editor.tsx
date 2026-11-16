/**
 * A project's custom fields: key, label, type and, for a select, its options. A declared field is
 * shown typed on every task and can be filtered on; a value a task carries under an undeclared
 * key is kept and shown raw.
 */
import { useState } from "react";
import { Plus, Trash2 } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { FIELD_TYPES, type FieldDef, type FieldType } from "../../../../shared/ppm-tasks";
import type { TaskProjectSettingsUpdate } from "../../../../shared/ppm-tasks-api";
import { CommitInput, EditorHint, SmallSelect, inputCls, rowBtn } from "./task-settings-parts";

const TYPE_LABEL: Record<FieldType, string> = { text: "Text", number: "Number", select: "Select", date: "Date", link: "Link" };
const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

export function TaskFieldsEditor({ fields, save }: { fields: FieldDef[]; save(u: TaskProjectSettingsUpdate): void }) {
  const sorted = [...fields].sort((a, b) => a.position - b.position);
  const [newKey, setNewKey] = useState("");
  const upsert = (f: FieldDef, patch: Partial<FieldDef>) => save({
    fields: { upsert: [{ key: f.key, label: patch.label ?? f.label, type: patch.type ?? f.type, options: patch.options !== undefined ? patch.options : f.options, position: f.position }] },
  });
  const add = () => {
    const key = newKey.trim();
    if (!KEY_RE.test(key) || sorted.some((f) => f.key === key)) return;
    save({ fields: { upsert: [{ key, label: key.replace(/_/g, " "), type: "text", position: sorted.length }] } });
    setNewKey("");
  };
  return (
    <div className="space-y-2" data-task-fields-editor="">
      <EditorHint>Keys use lowercase letters, digits and underscores. Separate select options with commas.</EditorHint>
      {sorted.map((f) => (
        <div key={f.key} className="grid grid-cols-[7rem_minmax(0,1fr)_6rem_minmax(0,1.2fr)_auto] items-center gap-1.5">
          <span className="truncate font-mono text-xs text-text-2" title={f.key}>{f.key}</span>
          <CommitInput label="Label" value={f.label} required onCommit={(label) => upsert(f, { label })} />
          <SmallSelect label="Type" value={f.type} options={FIELD_TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] }))}
            onChange={(type) => upsert(f, { type, options: type === "select" ? f.options ?? [] : null })} />
          {f.type === "select"
            ? <CommitInput label="Options" placeholder="Option A, Option B" value={(f.options ?? []).join(", ")}
                onCommit={(v) => upsert(f, { options: v.split(",").map((o) => o.trim()).filter(Boolean) })} />
            : <span />}
          <button type="button" className={rowBtn} aria-label={`Delete field ${f.key}`} onClick={() => save({ fields: { delete: [f.key] } })}><Trash2 className="size-3.5" /></button>
        </div>
      ))}
      <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <input aria-label="New field key" className={inputCls} placeholder="new_field_key" value={newKey} onChange={(e) => setNewKey(e.target.value.toLowerCase())} />
        <Button size="sm" variant="outline" type="submit" disabled={!KEY_RE.test(newKey.trim())}><Plus className="size-3.5" />Add field</Button>
      </form>
    </div>
  );
}
