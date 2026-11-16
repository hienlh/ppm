/**
 * A yes/no question before a change that cannot be taken back from the same screen (replacing a
 * task's working chat, turning tasks off). `useTaskConfirm` returns an async `confirm` and the
 * element to render; the promise answers true only on the confirm button.
 */
import { useCallback, useRef, useState, type ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export interface ConfirmRequest {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
}

export function useTaskConfirm(): [(req: ConfirmRequest) => Promise<boolean>, ReactNode] {
  const [req, setReq] = useState<ConfirmRequest | null>(null);
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
  const element = (
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
