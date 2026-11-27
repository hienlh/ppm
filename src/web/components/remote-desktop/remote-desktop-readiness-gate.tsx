/**
 * Second gate after the warning: the host's requirements checklist. Renders `children` (the
 * viewer) straight away when every requirement is met; otherwise shows one row per item with
 * its actions and re-polls until they clear. Video requirements block; input requirements only
 * downgrade the button to "view only" — a screen you can see but not drive is still useful.
 *
 * Actions are generic (`terminal` types into a PPM dock terminal — the host's shell, so it works
 * from a phone; `host` asks the server to prompt/open Settings on the host; `link` opens on the
 * client). Same dark chrome as the warning gate; buttons take the standard sizes from
 * `docs/design-guidelines.md` rule 3 (28px with text, 26px below `md`).
 */
import { useState, type ReactNode } from "react";
import { Loader2, MonitorSmartphone } from "@/lib/icons";
import { runInTerminal } from "@/lib/run-in-terminal";
import {
  useRemoteDesktopReadiness, type HostAction, type HostActionResult, type RemoteDesktopCapabilities,
} from "./use-remote-desktop-readiness";
import { useHeadlessRescue } from "./use-headless-rescue";
import { RescueBar } from "./remote-desktop-rescue-bar";
import { GATE_BUTTON, RequirementRow } from "./remote-desktop-requirement-row";

export { GATE_BUTTON } from "./remote-desktop-requirement-row";

export interface RemoteDesktopReadinessGateProps {
  onCancel: () => void;
  children: ReactNode;
}

export function RemoteDesktopReadinessGate({ onCancel, children }: RemoteDesktopReadinessGateProps) {
  const [accepted, setAccepted] = useState(false);
  const { caps, failed, runHostAction: runOnHost } = useRemoteDesktopReadiness(!accepted);
  const rescue = useHeadlessRescue(caps?.platform === "win32");
  // Bringing the session back or turning the display on arms the safety net: show it at once.
  const runHostAction = async (id: string, action: HostAction) => {
    const result = await runOnHost(id, action);
    rescue.refresh();
    return result;
  };

  // One wrapper in every state, so the bar coming and going never remounts the viewer.
  return (
    <div className="relative h-full w-full">
      {accepted || (caps?.videoReady && caps.inputReady && !hasOpenChoice(caps))
        ? children
        : <Checklist caps={caps} failed={failed} onCancel={onCancel} onAccept={() => setAccepted(true)} runHostAction={runHostAction} />}
      {rescue.rescue && (
        // Above the viewer's toolbar (z-40): for five minutes this is the one thing that matters.
        <div className="pointer-events-none absolute inset-x-0 top-2 z-50 flex justify-center px-4">
          <RescueBar rescue={rescue.rescue} now={Date.now()} onConfirm={rescue.confirm} />
        </div>
      )}
    </div>
  );
}

/** A `choice` row still unanswered: the host works, but the user is asked first (Windows'
 *  fallback screen: turn on the virtual display, or continue at the fallback's size). */
export function hasOpenChoice(caps: RemoteDesktopCapabilities): boolean {
  return caps.requirements.some((r) => !r.ok && r.gates === "choice");
}

function Checklist({ caps, failed, onCancel, onAccept, runHostAction }: {
  caps: RemoteDesktopCapabilities | null;
  failed: boolean;
  onCancel: () => void;
  onAccept: () => void;
  runHostAction: (id: string, action: HostAction) => Promise<HostActionResult | null>;
}) {
  const pending = caps?.requirements.filter((r) => !r.ok && r.gates !== "choice") ?? [];
  const viewOnly = !!caps?.videoReady && !caps.inputReady;
  // A `choice` row carries its own "continue as is" button; a second generic Continue beside it
  // would be the same answer under a vaguer name.
  const openChoice = !!caps && hasOpenChoice(caps);
  // The dock terminal opens *under* this surface (the mobile sheet covers the whole viewport),
  // so hand the command over and get out of the way; the entry stays in the nav to come back to.
  const onTerminal = (command: string) => { runInTerminal(command); onCancel(); };

  return (
    <div
      className="flex h-full w-full overflow-y-auto bg-black p-4 text-white"
      data-testid="remote-desktop-readiness-gate"
    >
      {/* `m-auto`, not `items-center`: centring a card taller than the scroller puts its top above
          the scroll origin, where the title and the first rows can never be scrolled to. Auto
          margins centre only while there is room. */}
      <div className="m-auto flex w-full max-w-sm flex-col gap-4 rounded-xl border border-white/10 bg-white/5 p-5">
        <div className="flex items-center gap-2">
          <MonitorSmartphone className="size-5 shrink-0 text-primary" />
          <h2 className="text-base font-semibold">This host needs a few things</h2>
        </div>

        {!caps && !failed && (
          <div className="flex items-center gap-2 text-sm text-white/70"><Loader2 className="size-4 animate-spin" /> Checking the host…</div>
        )}
        {failed && <p className="text-sm text-red-300">Could not reach the host&apos;s remote-desktop service.</p>}

        <ul className="flex flex-col gap-3">
          {caps?.requirements.map((r) => (
            <RequirementRow key={r.id} req={r} onHostAction={runHostAction} onTerminal={onTerminal} onAccept={onAccept} />
          ))}
        </ul>

        {pending.length > 0 && (
          <p className="text-xs text-white/50">Re-checking every few seconds — this updates by itself once fixed.</p>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className={`${GATE_BUTTON} bg-white/10 hover:bg-white/20`}>
            Cancel
          </button>
          {!openChoice && (
            <button
              type="button"
              disabled={!caps?.videoReady}
              onClick={onAccept}
              className={`${GATE_BUTTON} bg-primary font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40`}
              data-testid="remote-desktop-readiness-continue"
            >
              {viewOnly ? "Continue (view only)" : "Continue"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
