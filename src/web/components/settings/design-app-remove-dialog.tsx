import { useState } from "react";
import { Loader2 } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { deleteDesignSystem } from "@/lib/design/api-design-systems";
import { DesignResponsiveDialog } from "@/components/design/dialogs/design-responsive-dialog";
import type { DesignSystemSummary } from "../../../shared/design-types";

/** Un-declares an app; its `DESIGN.md`/`tokens.css`/`kit/` are only deleted if asked to. */
export function DesignAppRemoveDialog({ projectName, system, onClose, onRemoved }: {
  projectName: string;
  system: DesignSystemSummary;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    setRemoving(true);
    setError(null);
    try {
      await deleteDesignSystem(projectName, system.id, deleteFiles);
      onRemoved();
    } catch (e) {
      setError((e as Error).message || "Could not remove this app");
      setRemoving(false);
    }
  };

  return (
    <DesignResponsiveDialog
      open
      onClose={() => { if (!removing) onClose(); }}
      title={`Remove "${system.label}"?`}
      description="Designs already made for it keep working; it just stops being offered as an app."
      footer={<>
        <Button variant="outline" onClick={onClose} disabled={removing}>Cancel</Button>
        <Button variant="destructive" onClick={() => void remove()} disabled={removing}>
          {removing && <Loader2 className="size-4 animate-spin" />} Remove
        </Button>
      </>}
    >
      <label className="flex min-h-11 items-center gap-2 text-sm text-text-secondary">
        <input type="checkbox" checked={deleteFiles} onChange={(e) => setDeleteFiles(e.target.checked)} className="size-4" />
        Also delete its design-system files (DESIGN.md, tokens.css, kit/)
      </label>
      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
    </DesignResponsiveDialog>
  );
}
