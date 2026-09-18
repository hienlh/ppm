/**
 * One process's properties — Mission Center's Details dialog.
 *
 * Fetched when the dialog opens rather than ridden on the tick: it is a handful
 * of `/proc` reads per process and nobody needs a working directory at 0.5 Hz.
 * A field this user cannot read (another user's `exe`, `cwd`) comes back null,
 * which is the normal case on a shared machine and renders as an em dash.
 */
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { api } from "@/lib/api-client";
import type { ProcessDetails } from "../../../types/system-metrics";

export interface ProcessDetailsDialogProps {
  pid: number | null;
  name: string;
  onClose: () => void;
}

function started(ms: number): string {
  return ms > 0 ? new Date(ms).toLocaleString() : "—";
}

export function ProcessDetailsDialog({ pid, name, onClose }: ProcessDetailsDialogProps) {
  const isMobile = useIsMobile();
  const [details, setDetails] = useState<ProcessDetails | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (pid === null) {
      setDetails(null);
      setError(null);
      return;
    }
    let live = true;
    setDetails(null);
    setError(null);
    api.get<ProcessDetails>(`/api/system/resources/process/${pid}`)
      .then((d) => { if (live) setDetails(d); })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : "Could not read the process");
      });
    return () => { live = false; };
  }, [pid]);

  if (pid === null) return null;

  const body = (
    <div className="space-y-3" data-testid="sysmon-process-details" data-pid={pid}>
      {error && <p className="text-sm text-error">{error}</p>}
      {!error && details === null && <p className="text-sm text-text-subtle">Reading /proc…</p>}
      {details && (
        <>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            <Field label="PID" value={details.pid} />
            <Field label="Parent PID" value={details.ppid} />
            <Field label="User" value={details.user} />
            <Field label="State" value={details.state} />
            <Field label="Threads" value={details.threads} />
            <Field label="Nice" value={details.nice} />
            <Field label="Started" value={started(details.startedAt)} />
            <Field label="Control group" value={details.cgroup} />
          </dl>
          <Block label="Executable" value={details.exe} />
          <Block label="Working directory" value={details.cwd} />
          {/* The whole line, not the table row's 160 characters: showing it is
              what this dialog is for. Secrets are redacted server-side. */}
          <Block label="Command line" value={details.command} mono />
        </>
      )}
    </div>
  );

  if (isMobile) {
    return (
      <BottomSheet open onClose={onClose}>
        <div className="px-4 pb-4 space-y-3">
          <h2 className="text-base font-semibold break-all">{name}</h2>
          {body}
        </div>
      </BottomSheet>
    );
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      {/* `sm:` or the primitive's own `sm:max-w-lg` wins and this is dead. */}
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="break-all">{name}</DialogTitle>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, value }: { label: string; value: string | number | null }) {
  const text = value === null || value === "" ? "—" : String(value);
  return (
    <div className="min-w-0">
      <dt className="text-text-subtle">{label}</dt>
      <dd className="truncate" title={text}>{text}</dd>
    </div>
  );
}

function Block({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div className="space-y-1">
      <p className="text-[11px] text-text-subtle">{label}</p>
      <p className={`text-xs break-all ${mono ? "font-mono" : ""}`}>{value ?? "—"}</p>
    </div>
  );
}
