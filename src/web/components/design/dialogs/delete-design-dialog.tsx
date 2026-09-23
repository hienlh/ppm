import { useState } from "react";
import { Loader2 } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { usePanelStore } from "@/stores/panel-store";
import { deleteDesign } from "@/lib/design/api-designs";
import { announceDesignsChanged } from "@/lib/design/design-ui-events";
import { DesignResponsiveDialog } from "./design-responsive-dialog";
import type { DesignSummary } from "../../../../shared/design-types";

/**
 * Delete a design folder, history included. Typing the slug is the confirmation, and the
 * server checks it again (`?confirm=<slug>`), so a mistap or a replayed request cannot do it.
 * The design's open tab is closed with it; its chat sessions stay in the history.
 */
export function DeleteDesignDialog({ projectName, design, onClose }: {
  projectName: string;
  design: DesignSummary;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmed = typed.trim() === design.slug;

  const remove = async () => {
    if (!confirmed || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteDesign(projectName, design.slug);
      const store = usePanelStore.getState();
      for (const panel of Object.values(store.panels)) {
        for (const tab of panel.tabs) {
          if (tab.type === "design" && tab.metadata?.designSlug === design.slug
            && (tab.projectId ?? tab.metadata?.projectName) === projectName) store.closeTab(tab.id, panel.id);
        }
      }
      announceDesignsChanged(projectName);
      onClose();
    } catch (e) {
      setError((e as Error).message || "Could not delete the design");
      setDeleting(false);
    }
  };

  return (
    <DesignResponsiveDialog
      open
      onClose={() => { if (!deleting) onClose(); }}
      title={`Delete “${design.title}”?`}
      description={`This deletes designs/${design.slug}/ and its version history. It cannot be undone.`}
      footer={<>
        <Button variant="outline" onClick={onClose} disabled={deleting}>Cancel</Button>
        <Button variant="destructive" onClick={remove} disabled={!confirmed || deleting}>
          {deleting && <Loader2 className="size-4 animate-spin" />} Delete
        </Button>
      </>}
    >
      <form onSubmit={(e) => { e.preventDefault(); void remove(); }} className="flex flex-col gap-2">
        <label className="text-xs text-text-secondary">
          Type <span className="font-mono font-semibold">{design.slug}</span> to confirm
          <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false}
            className="mt-1 min-h-11 w-full rounded-md border border-border bg-background px-3 font-mono text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-destructive md:min-h-9" />
        </label>
        {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
      </form>
    </DesignResponsiveDialog>
  );
}
