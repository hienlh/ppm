/** One unit's details and its log: this boot's journal under systemd, the job's own
 *  log file or the unified log under launchd. Bottom sheet below `md`, dialog above
 *  — the rule every PPM dialog follows. */
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { fetchServiceDetails } from "./use-services";
import { serviceStatusText } from "./service-rows";
import {
  argumentsText, logEmptyText, logHeading, logLoadingText, outputText,
} from "./service-details-text";
import type { ServiceDetails, ServiceInfo, ServiceManager } from "../../../../types/system-services";

export interface ServiceDetailsSheetProps {
  target: ServiceInfo | null;
  manager: ServiceManager;
  onClose: () => void;
}

export function ServiceDetailsSheet({ target, manager, onClose }: ServiceDetailsSheetProps) {
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

  const launchd = manager === "launchd";
  const scm = manager === "scm";
  const source = details?.logSource;
  const body = (
    <div className="space-y-3" data-testid="sysmon-service-details" data-unit={target.unit}>
      <p className="text-xs text-text-subtle">{details?.description || target.description || serviceStatusText(target)}</p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        <Field label="State" value={serviceStatusText(details ?? target)} />
        <Field label="Main PID" value={(details ?? target).mainPid ?? "—"} />
        <Field label={scm ? "Log on as" : "User"} value={details?.user ?? "—"} />
        {scm ? (
          <>
            <Field label="Startup type" value={(details ?? target).unitFileState ?? "—"} />
            <Field wide label="Command" value={details?.fragmentPath ?? "—"} />
          </>
        ) : (
          <>
            <Field label="Group" value={details?.group ?? "—"} />
            <Field label="Scope" value={target.scope} />
          </>
        )}
        {!launchd && !scm && <Field label="Unit file" value={details?.fragmentPath ?? "—"} />}
        {launchd && (
          <>
            <Field label="Last exit" value={details?.lastExit ?? "—"} />
            <Field label="Keep alive" value={details?.keepAlive === undefined ? "—" : details.keepAlive ? "yes" : "no"} />
            {/* Wide: its tail is the part that names the job, and a phone has no hover to reveal it. */}
            <Field wide label="Property list" value={details?.fragmentPath ?? "—"} />
            <Field wide label="Program" value={details?.program ?? "—"} />
            <Field wide label="Arguments" value={argumentsText(details?.arguments)} />
            <Field wide label="Output" value={outputText(details)} />
          </>
        )}
      </dl>
      <div className="space-y-1">
        <h4 className="text-xs font-medium text-text-secondary">{logHeading(manager, source)}</h4>
        <div className="rounded-md border border-border bg-surface-hover/40 max-h-64 overflow-y-auto p-2">
          {error && <p className="text-xs text-error">{error}</p>}
          {!error && details === null && <p className="text-xs text-text-subtle">{logLoadingText(manager)}</p>}
          {details?.logs.length === 0 && <p className="text-xs text-text-subtle">{logEmptyText(manager, source)}</p>}
          {details?.logs.map((line, i) => (
            <p key={`${line.ts}-${i}`} className="text-[11px] font-mono whitespace-pre-wrap break-words">
              {/* A line from a job's own log file has no time of its own. */}
              {line.ts !== null && (
                <span className="text-text-subtle">{new Date(line.ts).toLocaleTimeString()} </span>
              )}
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

/** `wide` spans both columns and wraps: a command line truncated to half a dialog,
 *  with the rest only in a tooltip no touch screen can open, says nothing. */
function Field({ label, value, wide = false }: { label: string; value: string | number; wide?: boolean }) {
  return (
    <div className={cn("min-w-0", wide && "col-span-2")}>
      <dt className="text-text-subtle">{label}</dt>
      <dd className={wide ? "font-mono text-[11px] break-all" : "truncate"} title={String(value)}>{value}</dd>
    </div>
  );
}
