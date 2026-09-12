/**
 * Confirm before a service action that takes something away.
 *
 * Mission Center asks nothing and lets polkit decide. PPM asks, because its
 * Services page is reachable from a phone on a LAN where a mis-tap on "Stop" has
 * no undo — and because the actions that would be catastrophic are refused by the
 * server anyway, so what is left here is exactly the consequential-but-allowed
 * middle. Start and enable are not confirmed: they take nothing away.
 */
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-is-mobile";
import type { ServiceAction, ServiceInfo } from "../../../../types/system-services";

/** The actions worth a question. */
export const CONFIRMED_ACTIONS: readonly ServiceAction[] = ["stop", "restart", "disable"];

export function needsConfirm(action: ServiceAction): boolean {
  return CONFIRMED_ACTIONS.includes(action);
}

const WORDING: Partial<Record<ServiceAction, { title: string; body: (unit: string) => string; cta: string }>> = {
  stop: {
    title: "Stop service",
    body: (unit) => `Stop ${unit}? Anything depending on it stops too.`,
    cta: "Stop",
  },
  restart: {
    title: "Restart service",
    body: (unit) => `Restart ${unit}? It will be briefly unavailable.`,
    cta: "Restart",
  },
  disable: {
    title: "Disable at boot",
    body: (unit) => `${unit} will no longer start at boot. It keeps running now.`,
    cta: "Disable",
  },
};

export interface PendingServiceAction {
  service: ServiceInfo;
  action: ServiceAction;
}

export interface ServiceActionConfirmProps {
  pending: PendingServiceAction | null;
  onConfirm: (pending: PendingServiceAction) => void;
  onCancel: () => void;
}

export function ServiceActionConfirm({ pending, onConfirm, onCancel }: ServiceActionConfirmProps) {
  const isMobile = useIsMobile();
  if (!pending) return null;
  const wording = WORDING[pending.action];
  if (!wording) return null;

  const body = (
    <div className="space-y-4" data-testid="sysmon-service-confirm" data-action={pending.action}>
      <p className="text-sm break-words">{wording.body(pending.service.unit)}</p>
      <p className="text-xs text-text-subtle">
        {pending.service.scope === "system" ? "System service" : "User service"}
        {pending.service.mainPid !== null && ` · pid ${pending.service.mainPid}`}
      </p>
      <div className="flex flex-col-reverse md:flex-row gap-2 md:justify-end pt-2">
        <Button variant="outline" onClick={onCancel} className="min-h-11">Cancel</Button>
        <Button
          variant="destructive"
          autoFocus={false}
          onClick={() => onConfirm(pending)}
          data-testid="sysmon-service-confirm-ok"
          className="min-h-11"
        >
          {wording.cta}
        </Button>
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <BottomSheet open onClose={onCancel}>
        <div className="px-4 pb-4">
          <h2 className="text-base font-semibold mb-3">{wording.title}</h2>
          {body}
        </div>
      </BottomSheet>
    );
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{wording.title}</DialogTitle>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}
