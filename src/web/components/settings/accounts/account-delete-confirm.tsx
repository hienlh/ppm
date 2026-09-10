/**
 * Confirmation before removing an account.
 *
 * Bottom sheet below `md`, centered dialog above — the same adaptive shell the process-kill
 * confirmation uses. Removal is destructive and not undoable, so the destructive button is
 * never the focused default and both Escape and the backdrop cancel.
 */

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-is-mobile";

export function AccountDeleteConfirm({ display, onConfirm, onCancel }: {
  /** Label shown to the user — never the raw token or id. */
  display: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const isMobile = useIsMobile();

  const body = (
    <div className="space-y-4" data-testid="account-delete-confirm">
      <p className="text-sm">
        Remove <span className="font-medium">{display}</span>?
      </p>
      <p className="text-xs text-text-subtle">
        The stored token is deleted from this machine. Any export you already made keeps working.
      </p>
      <div className="flex flex-col-reverse md:flex-row gap-2 md:justify-end pt-2">
        <Button variant="outline" onClick={onCancel} className="min-h-11">
          Cancel
        </Button>
        <Button variant="destructive" autoFocus={false} onClick={onConfirm} className="min-h-11">
          Remove account
        </Button>
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <BottomSheet open onClose={onCancel}>
        <div className="px-4 pb-4">
          <h2 className="text-base font-semibold mb-3">Remove account</h2>
          {body}
        </div>
      </BottomSheet>
    );
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onCancel(); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">Remove account</DialogTitle>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}
