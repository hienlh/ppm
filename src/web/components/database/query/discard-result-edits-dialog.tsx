/**
 * Running again replaces the results, and with them rows edited there and not saved yet: asked
 * first, as a dialog on a desktop and a bottom sheet on a phone. Cancel is the default.
 */
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-is-mobile";

const TITLE = "Discard unsaved changes?";
const EXPLANATION = "Rows were changed in the results and not saved. Running again replaces the results and discards the changes.";

export function DiscardResultEditsDialog({ onCancel, onDiscard }: { onCancel: () => void; onDiscard: () => void }) {
  const isMobile = useIsMobile();
  const buttons = (
    <div className="flex flex-col-reverse gap-2 pt-2 md:flex-row md:justify-end">
      <Button variant="outline" onClick={onCancel} className="min-h-11 md:min-h-9" autoFocus>Cancel</Button>
      <Button variant="destructive" onClick={onDiscard} className="min-h-11 md:min-h-9">Discard and run</Button>
    </div>
  );
  if (isMobile) {
    return (
      <BottomSheet open onClose={onCancel}>
        <div className="space-y-3 px-4 pb-4" role="alertdialog" aria-label={TITLE}>
          <h2 className="text-base font-semibold">{TITLE}</h2>
          <p className="text-sm text-text-secondary">{EXPLANATION}</p>
          {buttons}
        </div>
      </BottomSheet>
    );
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent role="alertdialog">
        <DialogHeader>
          <DialogTitle>{TITLE}</DialogTitle>
          <DialogDescription>{EXPLANATION}</DialogDescription>
        </DialogHeader>
        {buttons}
      </DialogContent>
    </Dialog>
  );
}
