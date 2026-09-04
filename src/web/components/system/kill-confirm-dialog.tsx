import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { formatRam } from "@/lib/format-bytes";
import type { KillTarget } from "./build-kill-request";

export interface KillConfirmDialogProps {
  target: KillTarget | null;
  /** `tree` is only meaningful for a single process; a group is always ended whole. */
  onConfirm: (target: KillTarget, tree: boolean) => void;
  onCancel: () => void;
}

/** Confirm dialog for ending a process or a whole app group. Bottom sheet below
 *  `md`, centered dialog at `md`+. The "end child processes" toggle defaults off and
 *  the destructive action is never the default focus — Escape/backdrop cancels either
 *  way. */
export function KillConfirmDialog({ target, onConfirm, onCancel }: KillConfirmDialogProps) {
  const isMobile = useIsMobile();
  const [tree, setTree] = useState(false);

  useEffect(() => {
    if (!target) setTree(false);
  }, [target]);

  if (!target) return null;

  const isGroup = target.kind === "group";
  const title = isGroup ? "End app" : "End process";
  const cpu = isGroup ? target.group.cpu : target.proc.cpu;
  const ramMB = isGroup ? target.group.ramMB : target.proc.ramMB;

  const body = (
    <div className="space-y-4" data-testid="sysmon-kill-confirm" data-kill-kind={target.kind}>
      {isGroup ? (
        <p className="text-sm">
          End <span className="font-medium">{target.group.label}</span> and all its{" "}
          <span className="font-medium">{target.members.length}</span> processes?
        </p>
      ) : (
        <p className="text-sm">
          End <span className="font-medium">{target.proc.name}</span> (pid {target.proc.pid})?
        </p>
      )}
      <p className="text-xs text-text-subtle">
        CPU {cpu.toFixed(1)}% · RAM {formatRam(ramMB)}
      </p>
      {!isGroup && (
        <label className="flex items-center justify-between gap-3 min-h-11 py-1">
          <span className="text-sm">Also end child processes</span>
          <Switch
            checked={tree}
            onCheckedChange={setTree}
            data-testid="sysmon-kill-tree"
            aria-label="Also end child processes"
          />
        </label>
      )}
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
          onClick={() => onConfirm(target, tree)}
          data-testid="sysmon-kill-confirm-ok"
          className="min-h-11"
        >
          {isGroup ? `End ${target.members.length} processes` : "End process"}
        </Button>
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <BottomSheet open onClose={onCancel}>
        <div className="px-4 pb-4">
          <h2 className="text-base font-semibold mb-3">{title}</h2>
          {body}
        </div>
      </BottomSheet>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}
