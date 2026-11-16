/**
 * A yes/no question before a change that cannot be taken back from the same screen (replacing a
 * task's working chat, turning tasks off). `useTaskConfirm` returns an async `confirm` and the
 * element to render; the promise answers true only on the confirm button. Below `md` the question
 * is a bottom sheet with the confirm button full width at the bottom, in the thumb zone.
 */
import { useCallback, useRef, useState, type ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { useIsMobile } from "@/hooks/use-is-mobile";

export interface ConfirmRequest {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
}

export function useTaskConfirm(): [(req: ConfirmRequest) => Promise<boolean>, ReactNode] {
  const [req, setReq] = useState<ConfirmRequest | null>(null);
  const isMobile = useIsMobile();
  const resolver = useRef<((yes: boolean) => void) | null>(null);
  const confirm = useCallback((next: ConfirmRequest) => new Promise<boolean>((resolve) => {
    resolver.current?.(false);
    resolver.current = resolve;
    setReq(next);
  }), []);
  const settle = (yes: boolean) => {
    resolver.current?.(yes);
    resolver.current = null;
    setReq(null);
  };
  const element = isMobile ? (
    <BottomSheet open={!!req} onClose={() => settle(false)}>
      {req && (
        <div role="dialog" aria-label={req.title} data-task-confirm="" className="px-4 pb-2 pt-1">
          <p className="text-[15px] font-semibold text-text">{req.title}</p>
          <div className="mt-1 text-sm text-text-2">{req.body}</div>
          <div className="mt-4 flex flex-col gap-2">
            <Button variant={req.destructive ? "destructive" : "default"} className="h-12 w-full text-[15px]" onClick={() => settle(true)}>{req.confirmLabel}</Button>
            <Button variant="outline" className="h-11 w-full text-[15px]" onClick={() => settle(false)}>Cancel</Button>
          </div>
        </div>
      )}
    </BottomSheet>
  ) : (
    <Dialog open={!!req} onOpenChange={(open) => { if (!open) settle(false); }}>
      {req && (
        <DialogContent className="sm:max-w-md" data-task-confirm="">
          <DialogHeader>
            <DialogTitle>{req.title}</DialogTitle>
            <DialogDescription asChild><div className="text-sm text-text-2">{req.body}</div></DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => settle(false)}>Cancel</Button>
            <Button variant={req.destructive ? "destructive" : "default"} onClick={() => settle(true)}>{req.confirmLabel}</Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
  return [confirm, element];
}
