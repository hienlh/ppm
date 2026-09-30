import { useState } from "react";
import { Loader2 } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { createDesignSystem, updateDesignSystem } from "@/lib/design/api-design-systems";
import { DesignResponsiveDialog } from "@/components/design/dialogs/design-responsive-dialog";
import type { DesignPlatform, DesignSystemSummary } from "../../../shared/design-types";

const PLATFORMS: Array<{ id: DesignPlatform; label: string }> = [
  { id: "web", label: "Web" },
  { id: "mobile", label: "Mobile" },
];

/** Declare a new app, or edit an existing one's label/folder/platform. */
export function DesignAppFormDialog({ projectName, editing, onClose, onSaved }: {
  projectName: string;
  /** Present to edit; absent to declare a new app. */
  editing: DesignSystemSummary | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState(editing?.label ?? "");
  const [root, setRoot] = useState(editing?.root ?? "");
  const [platform, setPlatform] = useState<DesignPlatform>(editing?.platform ?? "web");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedLabel = label.trim();
  const isDefault = editing?.id === "default";
  const canSave = !!trimmedLabel && (isDefault || !!root.trim()) && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      if (editing) await updateDesignSystem(projectName, editing.id, { label: trimmedLabel, root: root.trim(), platform });
      else await createDesignSystem(projectName, { label: trimmedLabel, root: root.trim() || ".", platform });
      onSaved();
    } catch (e) {
      setError((e as Error).message || "Could not save this app");
      setSaving(false);
    }
  };

  return (
    <DesignResponsiveDialog
      open
      onClose={() => { if (!saving) onClose(); }}
      title={editing ? `Edit "${editing.label}"` : "Add an app"}
      description="A folder under this project with its own design system — a separate frontend in a monorepo, or a mobile app."
      footer={<>
        <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button onClick={() => void save()} disabled={!canSave}>
          {saving && <Loader2 className="size-4 animate-spin" />} Save
        </Button>
      </>}
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
          Label
          <input autoFocus value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Payroll frontend"
            className="min-h-11 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground placeholder:text-text-subtle focus:outline-none focus:ring-1 focus:ring-primary md:min-h-9" />
        </label>
        {!isDefault && (
          <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
            Folder (relative to the project)
            <input value={root} onChange={(e) => setRoot(e.target.value)} spellCheck={false} autoComplete="off"
              placeholder="e.g. payroll-fe"
              className="min-h-11 w-full rounded-md border border-border bg-background px-3 font-mono text-sm text-foreground placeholder:text-text-subtle focus:outline-none focus:ring-1 focus:ring-primary md:min-h-9" />
          </label>
        )}
        <div role="radiogroup" aria-label="Platform" className="grid grid-cols-2 gap-2">
          {PLATFORMS.map((p) => (
            <button key={p.id} type="button" role="radio" aria-checked={platform === p.id} onClick={() => setPlatform(p.id)}
              className={cn("min-h-11 rounded-md border px-3 text-sm md:min-h-9",
                platform === p.id ? "border-primary text-foreground" : "border-border text-text-subtle")}>
              {p.label}
            </button>
          ))}
        </div>
        {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
      </form>
    </DesignResponsiveDialog>
  );
}
