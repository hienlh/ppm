import { useState } from "react";
import { Loader2 } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { renameDesign } from "@/lib/design/api-designs";
import { announceDesignsChanged } from "@/lib/design/design-ui-events";
import { DesignResponsiveDialog } from "./design-responsive-dialog";
import type { DesignSummary } from "../../../../shared/design-types";

/**
 * Change a design's title. The slug — its folder name — never changes, because the design's
 * sessions were told to work in `designs/<slug>/` and would keep writing to the old path.
 */
export function RenameDesignDialog({ projectName, design, onClose }: {
  projectName: string;
  design: DesignSummary;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(design.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = title.trim();
  const canSave = !!trimmed && trimmed !== design.title && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await renameDesign(projectName, design.slug, trimmed);
      announceDesignsChanged(projectName);
      onClose();
    } catch (e) {
      setError((e as Error).message || "Could not rename the design");
      setSaving(false);
    }
  };

  return (
    <DesignResponsiveDialog
      open
      onClose={() => { if (!saving) onClose(); }}
      title="Rename design"
      description={`The folder stays designs/${design.slug}/.`}
      footer={<>
        <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button onClick={save} disabled={!canSave}>{saving && <Loader2 className="size-4 animate-spin" />} Rename</Button>
      </>}
    >
      <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="flex flex-col gap-2">
        <input autoFocus value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} aria-label="Title"
          className="min-h-11 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary md:min-h-9" />
        {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
      </form>
    </DesignResponsiveDialog>
  );
}
