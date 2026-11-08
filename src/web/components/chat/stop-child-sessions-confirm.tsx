/**
 * "Stop all child sessions?" — a bottom sheet on a phone, a dialog on a desktop. Names the
 * sessions it will stop, so the user knows what the button reaches before pressing it.
 */
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-is-mobile";

const TITLE = "Stop all child sessions?";

export function StopChildSessionsConfirm({ titles, busy, onConfirm, onCancel }: {
  /** The running sessions this one created. */
  titles: string[];
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const isMobile = useIsMobile();
  const body = (
    <div className="space-y-3" data-stop-children-confirm="">
      <p className="text-sm">
        Stops the running {titles.length === 1 ? "session" : `${titles.length} sessions`} this session created.
        This session keeps running. You can chat into a stopped session to start it again.
      </p>
      <ul className="max-h-40 list-disc overflow-y-auto pl-5 text-sm text-text-secondary">
        {titles.map((t, i) => <li key={i} className="break-words">{t}</li>)}
      </ul>
      <div className="flex flex-col-reverse gap-2 pt-1 md:flex-row md:justify-end">
        <Button variant="outline" onClick={onCancel} className="min-h-11">Cancel</Button>
        <Button variant="destructive" disabled={busy} onClick={onConfirm} className="min-h-11">
          {busy ? "Stopping…" : "Stop all"}
        </Button>
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <BottomSheet open onClose={onCancel}>
        <div className="px-4 pb-4">
          <h2 className="mb-3 text-base font-semibold">{TITLE}</h2>
          {body}
        </div>
      </BottomSheet>
    );
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{TITLE}</DialogTitle></DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}
