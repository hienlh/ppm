/**
 * DBGate's "Confirm close tabs": the tabs a close would take unsaved work with, listed, before any
 * of them goes. One is mounted in the app; it shows the question `closeTabsAsked` is waiting on,
 * as a dialog on a desktop and a bottom sheet on a phone. Cancel is the default.
 */
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { settleTabClose, useTabCloseConfirm } from "@/stores/tab-close-confirm-store";

export function TabCloseConfirmHost() {
  const pending = useTabCloseConfirm((s) => s.pending);
  const isMobile = useIsMobile();
  if (!pending) return null;

  const one = pending.tabs.length === 1;
  const title = "Confirm close tabs";
  const explanation = one
    ? "This tab has changes that are not saved. Closing it discards them."
    : "These tabs have changes that are not saved. Closing them discards the changes.";
  const cancel = () => settleTabClose(false);
  const list = (
    <ul className="max-h-48 overflow-y-auto rounded-md border border-border bg-panel-2 px-3 py-2 text-sm text-text-primary">
      {pending.tabs.map((t) => <li key={t.id} className="truncate py-0.5" title={t.title}>{t.title}</li>)}
    </ul>
  );
  const buttons = (
    <div className="flex flex-col-reverse gap-2 pt-2 md:flex-row md:justify-end">
      <Button variant="outline" onClick={cancel} className="min-h-11 md:min-h-9" autoFocus>Cancel</Button>
      <Button variant="destructive" onClick={() => settleTabClose(true)} className="min-h-11 md:min-h-9">
        {one ? "Close tab" : "Close tabs"}
      </Button>
    </div>
  );

  if (isMobile) {
    return (
      <BottomSheet open onClose={cancel}>
        <div className="space-y-3 px-4 pb-4" role="alertdialog" aria-label={title}>
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="text-sm text-text-secondary">{explanation}</p>
          {list}
          {buttons}
        </div>
      </BottomSheet>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) cancel(); }}>
      <DialogContent role="alertdialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{explanation}</DialogDescription>
        </DialogHeader>
        {list}
        {buttons}
      </DialogContent>
    </Dialog>
  );
}
