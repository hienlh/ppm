/**
 * "I can still reach this PC": the answer the Windows helper's safety net waits for after the
 * session was brought back or the virtual display was turned on. Unanswered, a SYSTEM task turns
 * the virtual display on for the session at the PC's screen at the deadline (it never signs
 * anyone out). Floats over the checklist and the viewer alike, so it is there whichever the
 * user is looking at, without changing the layout under it (which would remount the viewer and
 * drop its connection).
 */
import { useState } from "react";
import { Loader2, ShieldCheck } from "@/lib/icons";
import { TEXT_BUTTON } from "@/lib/control-size";
import type { RescueState } from "./use-headless-rescue";

export function formatRescueTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function RescueBar({ rescue, now, onConfirm }: {
  rescue: RescueState;
  now: number;
  onConfirm: () => Promise<{ ok: boolean; message: string }>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const due = now >= rescue.deadlineMs;

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await onConfirm();
      if (!r.ok) setError(r.message || "The PC did not answer.");
    } finally { setBusy(false); }
  };

  return (
    <div
      role="status"
      className="pointer-events-auto flex w-full max-w-xl flex-col gap-2 rounded-lg border border-amber-300/30 bg-black/85 px-3 py-2 text-xs text-amber-50 shadow-lg backdrop-blur md:flex-row md:items-center"
      data-testid="remote-desktop-rescue-bar"
    >
      <ShieldCheck className="hidden size-4 shrink-0 text-amber-300 md:block" />
      <p className="min-w-0 flex-1 leading-relaxed">
        {due
          ? "Safety net is running: Windows is making sure the session at this PC has a screen."
          : <>Safety net: unless you confirm by <strong>{formatRescueTime(rescue.deadlineMs)}</strong>, Windows turns the
            virtual display on for the session at this PC. It never signs you out.</>}
        {error && <span className="mt-1 block text-red-300" role="alert">{error}</span>}
      </p>
      {!due && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void confirm()}
          className={`inline-flex items-center justify-center gap-1.5 ${TEXT_BUTTON} shrink-0 self-end bg-amber-300 font-medium text-black hover:bg-amber-200 disabled:opacity-60 md:self-auto`}
          data-testid="remote-desktop-rescue-confirm"
        >
          {busy && <Loader2 className="size-3.5 animate-spin" />}
          I can still reach this PC
        </button>
      )}
    </div>
  );
}
