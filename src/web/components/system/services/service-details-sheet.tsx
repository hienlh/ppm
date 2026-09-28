/** One unit's details and this boot's journal. Bottom sheet below `md`, dialog
 *  above — the rule every PPM dialog follows. */
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { fetchServiceDetails } from "./use-services";
import { serviceStatusText } from "./service-rows";
import type { ServiceDetails, ServiceInfo } from "../../../../types/system-services";

export interface ServiceDetailsSheetProps {
  target: ServiceInfo | null;
  onClose: () => void;
}

export function ServiceDetailsSheet({ target, onClose }: ServiceDetailsSheetProps) {
  const isMobile = useIsMobile();
  const [details, setDetails] = useState<ServiceDetails | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!target) {
      setDetails(null);
      setError(null);
      return;
    }
    let live = true;
    setDetails(null);
    setError(null);
    fetchServiceDetails(target.scope, target.unit)
      .then((d) => { if (live) setDetails(d); })
      .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : "Could not read the unit"); });
    return () => { live = false; };
  }, [target]);

  if (!target) return null;

  const body = (
    <div className="space-y-3" data-testid="sysmon-service-details" data-unit={target.unit}>
      <p className="text-xs text-text-subtle">{details?.description || target.description || serviceStatusText(target)}</p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        <Field label="State" value={serviceStatusText(details ?? target)} />
        <Field label="Main PID" value={(details ?? target).mainPid ?? "—"} />
        <Field label="User" value={details?.user ?? "—"} />
        <Field label="Group" value={details?.group ?? "—"} />
        <Field label="Scope" value={target.scope} />
        <Field label="Unit file" value={details?.fragmentPath ?? "—"} />
      </dl>
      <div className="space-y-1">
        <h4 className="text-xs font-medium text-text-secondary">Log (this boot)</h4>
        <div className="rounded-md border border-border bg-surface-hover/40 max-h-64 overflow-y-auto p-2">
          {error && <p className="text-xs text-error">{error}</p>}
          {!error && details === null && <p className="text-xs text-text-subtle">Reading the journal…</p>}
          {details?.logs.length === 0 && <p className="text-xs text-text-subtle">No entries this boot.</p>}
          {details?.logs.map((line, i) => (
            <p key={`${line.ts}-${i}`} className="text-[11px] font-mono whitespace-pre-wrap break-words">
              <span className="text-text-subtle">{new Date(line.ts).toLocaleTimeString()} </span>
              {line.message}
            </p>
          ))}
        </div>
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <BottomSheet open onClose={onClose}>
        <div className="px-4 pb-4 space-y-3">
          <h2 className="text-base font-semibold break-all">{target.unit}</h2>
          {body}
        </div>
      </BottomSheet>
    );
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      {/* `sm:` because the primitive caps at `sm:max-w-lg`: a bare `max-w-2xl`
          loses to it at every width where it would have mattered. */}
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="break-all">{target.unit}</DialogTitle>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="min-w-0">
      <dt className="text-text-subtle">{label}</dt>
      <dd className="truncate" title={String(value)}>{value}</dd>
    </div>
  );
}
