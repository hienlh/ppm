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
import type { ServiceAction, ServiceInfo, ServiceManager } from "../../../../types/system-services";

/** The actions worth a question. */
export const CONFIRMED_ACTIONS: readonly ServiceAction[] = ["stop", "restart", "disable"];

export function needsConfirm(action: ServiceAction): boolean {
  return CONFIRMED_ACTIONS.includes(action);
}

type Wording = Partial<Record<ServiceAction, { title: string; body: (unit: string) => string; cta: string }>>;

const WORDING: Wording = {
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

/**
 * launchd's own terms. A stopped job stays loaded, and launchd starts it again on
 * demand — by itself if it is set to keep alive — so saying "stops" alone would
 * promise more than the button does. A user's jobs load at login, not at boot.
 */
const LAUNCHD_WORDING: Wording = {
  ...WORDING,
  stop: {
    title: "Stop job",
    body: (unit) => `Stop ${unit}? launchd starts it again when something needs it, or by itself if it keeps it alive.`,
    cta: "Stop",
  },
  restart: {
    title: "Restart job",
    body: (unit) => `Restart ${unit}? It will be briefly unavailable.`,
    cta: "Restart",
  },
  disable: {
    title: "Disable at login",
    body: (unit) => `${unit} will no longer load at login. It keeps running now.`,
    cta: "Disable",
  },
};

/**
 * Windows' terms. Stop does not take dependents down — Windows refuses instead — and
 * "disable at boot" sets the startup type to Manual, so it can still be started by hand.
 */
const SCM_WORDING: Wording = {
  ...WORDING,
  stop: {
    title: "Stop service",
    body: (unit) => `Stop ${unit}? Windows refuses if other running services depend on it.`,
    cta: "Stop",
  },
  disable: {
    title: "Disable at boot",
    body: (unit) => `${unit} will no longer start automatically (startup type Manual). It keeps running now.`,
    cta: "Disable",
  },
};

/** The system domain's jobs load at boot, as units do — only root can change them. */
function wordingFor(manager: ServiceManager, service: ServiceInfo): Wording {
  if (manager === "scm") return SCM_WORDING;
  if (manager !== "launchd") return WORDING;
  return service.scope === "user" ? LAUNCHD_WORDING : { ...LAUNCHD_WORDING, disable: WORDING.disable };
}

export interface PendingServiceAction {
  service: ServiceInfo;
  action: ServiceAction;
}

export interface ServiceActionConfirmProps {
  pending: PendingServiceAction | null;
  manager: ServiceManager;
  onConfirm: (pending: PendingServiceAction) => void;
  onCancel: () => void;
}

export function ServiceActionConfirm({ pending, manager, onConfirm, onCancel }: ServiceActionConfirmProps) {
  const isMobile = useIsMobile();
  if (!pending) return null;
  const launchd = manager === "launchd";
  const wording = wordingFor(manager, pending.service)[pending.action];
  if (!wording) return null;

  const body = (
    <div className="space-y-4" data-testid="sysmon-service-confirm" data-action={pending.action}>
      <p className="text-sm break-words">{wording.body(pending.service.unit)}</p>
      <p className="text-xs text-text-subtle">
        {manager === "scm" ? "Windows" : pending.service.scope === "system" ? "System" : "User"} {launchd ? "job" : "service"}
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
