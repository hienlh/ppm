/**
 * The inputs a script declares: what someone importing it fills in, and what it reads as
 * `ctx.inputs`. A secret has no default, so that sharing the schedule never shares one.
 */
import { Plus, Trash2 } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { InputDraft } from "@/lib/schedule-form-model";
import type { ScheduleInputType } from "../../../../types/scheduler";

const TYPES: ScheduleInputType[] = ["text", "number", "boolean", "secret"];
const FIELD = "h-11 md:h-9 text-xs";
const NATIVE_SELECT = "h-11 md:h-9 w-full rounded-md border border-input bg-transparent px-2 text-xs";

export function ScheduleInputsEditor({ inputs, onChange }: { inputs: InputDraft[]; onChange: (inputs: InputDraft[]) => void }) {
  const update = (i: number, patch: Partial<InputDraft>) =>
    onChange(inputs.map((d, j) => (j === i ? { ...d, ...patch, ...(patch.type === "secret" && { default: "" }) } : d)));
  const add = () => onChange([...inputs, { key: "", label: "", type: "text", required: false, default: "", description: "" }]);

  return (
    <div className="space-y-2">
      {inputs.length === 0 && <p className="text-[11px] text-muted-foreground">No inputs. A script reads its inputs as ctx.inputs.</p>}
      {inputs.map((d, i) => (
        <div key={i} className="rounded-md border border-border p-2 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <Input aria-label="Key" value={d.key} onChange={(e) => update(i, { key: e.target.value })} placeholder="key" className={`${FIELD} font-mono`} />
            <Input aria-label="Label" value={d.label} onChange={(e) => update(i, { label: e.target.value })} placeholder="Label" className={FIELD} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <select aria-label="Type" value={d.type} onChange={(e) => update(i, { type: e.target.value as ScheduleInputType })} className={NATIVE_SELECT}>
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <DefaultField draft={d} onChange={(value) => update(i, { default: value })} />
          </div>
          <Input
            aria-label="Description"
            value={d.description}
            onChange={(e) => update(i, { description: e.target.value })}
            placeholder="Description (optional)"
            className={FIELD}
          />
          <div className="flex items-center justify-between min-h-11 md:min-h-9">
            <label className="flex items-center gap-2 text-xs">
              <Switch checked={d.required} onCheckedChange={(v) => update(i, { required: v })} /> Required
            </label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onChange(inputs.filter((_, j) => j !== i))}
              className="min-h-11 md:min-h-8 text-xs gap-1 text-error cursor-pointer"
            >
              <Trash2 className="size-3.5" /> Remove
            </Button>
          </div>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={add} className="w-full min-h-11 md:min-h-8 text-xs gap-1 cursor-pointer">
        <Plus className="size-3.5" /> Add input
      </Button>
    </div>
  );
}

function DefaultField({ draft, onChange }: { draft: InputDraft; onChange: (value: string) => void }) {
  if (draft.type === "secret") {
    return <p className="flex items-center text-[11px] text-muted-foreground">A secret has no default</p>;
  }
  if (draft.type === "boolean") {
    return (
      <select aria-label="Default" value={draft.default} onChange={(e) => onChange(e.target.value)} className={NATIVE_SELECT}>
        <option value="">No default</option>
        <option value="true">Default: on</option>
        <option value="false">Default: off</option>
      </select>
    );
  }
  return (
    <Input
      aria-label="Default"
      value={draft.default}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Default (optional)"
      inputMode={draft.type === "number" ? "decimal" : undefined}
      className={FIELD}
    />
  );
}
