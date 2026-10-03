import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-is-mobile";

interface DeleteConnectionDialogProps {
  /** The connection to delete; null keeps the dialog closed. */
  target: { id: number; name: string } | null;
  onConfirm: (id: number) => Promise<void>;
  onCancel: () => void;
}

/**
 * Deleting a saved connection, which removes PPM's entry and nothing else — the step that says so
 * before anyone wonders whether their database goes with it. Bottom sheet below `md`, a dialog
 * above; Cancel is the default and the destructive button never takes focus by itself.
 */
export function DeleteConnectionDialog({ target, onConfirm, onCancel }: DeleteConnectionDialogProps) {
  const isMobile = useIsMobile();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!target) return null;

  const close = () => { setError(null); onCancel(); };
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(target.id);
    } catch (e) {
      setError((e as Error).message || "The connection could not be deleted");
    } finally {
      setBusy(false);
    }
  };

  const title = `Delete ${target.name}?`;
  const explanation = "This removes the saved connection from PPM. The database itself is not touched: no table, row or user on the server is changed.";
  const buttons = (
    <div className="flex flex-col-reverse gap-2 pt-2 md:flex-row md:justify-end">
      <Button variant="outline" onClick={close} className="min-h-11 md:min-h-9">Cancel</Button>
      <Button variant="destructive" onClick={confirm} disabled={busy} className="min-h-11 md:min-h-9">
        {busy ? "Deleting…" : "Delete connection"}
      </Button>
    </div>
  );
  const failure = error && <p role="alert" className="text-sm text-error">{error}</p>;

  if (isMobile) {
    return (
      <BottomSheet open onClose={close}>
        <div className="space-y-3 px-4 pb-4" role="alertdialog" aria-label={title}>
          <h2 className="text-base font-semibold break-words">{title}</h2>
          <p className="text-sm text-text-secondary">{explanation}</p>
          {failure}
          {buttons}
        </div>
      </BottomSheet>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="break-words">{title}</DialogTitle>
          <DialogDescription>{explanation}</DialogDescription>
        </DialogHeader>
        {failure}
        {buttons}
      </DialogContent>
    </Dialog>
  );
}
