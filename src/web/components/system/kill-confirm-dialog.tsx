import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { formatRam } from "@/lib/format-bytes";
import type { ProcessInfo } from "../../../types/system-metrics";

export interface KillConfirmDialogProps {
  process: ProcessInfo | null;
  onConfirm: (proc: ProcessInfo, tree: boolean) => void;
  onCancel: () => void;
}

/** Confirm dialog for ending a process. Bottom sheet below `md`, centered dialog at
 *  `md`+. The "end child processes" toggle defaults off and the destructive action is
 *  never the default focus — Escape/backdrop cancels either way. */
export function KillConfirmDialog({ process, onConfirm, onCancel }: KillConfirmDialogProps) {
  const isMobile = useIsMobile();
  const [tree, setTree] = useState(false);

  useEffect(() => {
    if (!process) setTree(false);
  }, [process]);

  if (!process) return null;

  const body = (
    <div className="space-y-4" data-testid="sysmon-kill-confirm">
      <p className="text-sm">
        End <span className="font-medium">{process.name}</span> (pid {process.pid})?
      </p>
      <p className="text-xs text-text-subtle">
        CPU {process.cpu.toFixed(1)}% · RAM {formatRam(process.ramMB)}
      </p>
      <label className="flex items-center justify-between gap-3 min-h-11 py-1">
        <span className="text-sm">Also end child processes</span>
        <Switch
          checked={tree}
          onCheckedChange={setTree}
          data-testid="sysmon-kill-tree"
          aria-label="Also end child processes"
        />
      </label>
      <div className="flex flex-col-reverse md:flex-row gap-2 md:justify-end pt-2">
        <Button
          variant="outline"
          onClick={onCancel}
          data-testid="sysmon-kill-confirm-cancel"
          className="min-h-11"
        >
          Cancel
        </Button>
        <Button
          variant="destructive"
          autoFocus={false}
          onClick={() => onConfirm(process, tree)}
          data-testid="sysmon-kill-confirm-ok"
          className="min-h-11"
        >
          End process
        </Button>
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <BottomSheet open onClose={onCancel}>
        <div className="px-4 pb-4">
          <h2 className="text-base font-semibold mb-3">End process</h2>
          {body}
        </div>
      </BottomSheet>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>End process</DialogTitle>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}
