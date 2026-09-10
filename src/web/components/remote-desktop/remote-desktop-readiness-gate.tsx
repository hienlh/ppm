/**
 * Second gate after the warning: the host's requirements checklist. Renders `children` (the
 * viewer) straight away when every requirement is met; otherwise shows one row per item with
 * its actions and re-polls until they clear. Video requirements block; input requirements only
 * downgrade the button to "view only" — a screen you can see but not drive is still useful.
 *
 * Actions are generic (`terminal` types into a PPM dock terminal — the host's shell, so it works
 * from a phone; `host` asks the server to prompt/open Settings on the host; `link` opens on the
 * client). Same dark chrome and ≥44px targets as the warning gate, both surfaces.
 */
import { useState, type ReactNode } from "react";
import { CheckCircle2, Circle, ExternalLink, Loader2, MonitorSmartphone, TerminalSquare } from "lucide-react";
import { runInTerminal } from "@/lib/run-in-terminal";
import { useRemoteDesktopReadiness, type RemoteDesktopRequirement, type RequirementAction } from "./use-remote-desktop-readiness";

export interface RemoteDesktopReadinessGateProps {
  onCancel: () => void;
  children: ReactNode;
}

export function RemoteDesktopReadinessGate({ onCancel, children }: RemoteDesktopReadinessGateProps) {
  const [accepted, setAccepted] = useState(false);
  const { caps, failed, runHostAction } = useRemoteDesktopReadiness(!accepted);

  if (accepted || (caps?.videoReady && caps.inputReady)) return <>{children}</>;

  const pending = caps?.requirements.filter((r) => !r.ok) ?? [];
  const viewOnly = !!caps?.videoReady && !caps.inputReady;
  // The dock terminal opens *under* this surface (the mobile sheet covers the whole viewport),
  // so hand the command over and get out of the way; the entry stays in the nav to come back to.
  const onTerminal = (command: string) => { runInTerminal(command); onCancel(); };

  return (
    <div
      className="flex h-full w-full items-center justify-center overflow-y-auto bg-black p-4 text-white"
      data-testid="remote-desktop-readiness-gate"
    >
      <div className="flex w-full max-w-sm flex-col gap-4 rounded-xl border border-white/10 bg-white/5 p-5">
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
            <RequirementRow key={r.id} req={r} onHostAction={runHostAction} onTerminal={onTerminal} />
          ))}
        </ul>

        {pending.length > 0 && (
          <p className="text-xs text-white/50">Re-checking every few seconds — this updates by itself once fixed.</p>
        )}

        <div className="flex gap-2">
          <button type="button" onClick={onCancel} className="min-h-11 flex-1 rounded-md bg-white/10 px-3 text-sm hover:bg-white/20">
            Cancel
          </button>
          <button
            type="button"
            disabled={!caps?.videoReady}
            onClick={() => setAccepted(true)}
            className="min-h-11 flex-1 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="remote-desktop-readiness-continue"
          >
            {viewOnly ? "Continue (view only)" : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}

interface ActionHandlers {
  onHostAction: (id: string, a: "request" | "open-settings") => Promise<void>;
  onTerminal: (command: string) => void;
}

function RequirementRow({ req, ...handlers }: { req: RemoteDesktopRequirement } & ActionHandlers) {
  return (
    <li className="flex gap-2" data-testid={`remote-desktop-requirement-${req.id}`} data-ok={req.ok}>
      {req.ok
        ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-400" />
        : <Circle className="mt-0.5 size-4 shrink-0 text-amber-300" />}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="text-sm font-medium">
          {req.title}
          {!req.ok && <span className="ml-2 text-xs font-normal text-white/50">{req.gates === "video" ? "required" : "for mouse & keyboard"}</span>}
        </div>
        {!req.ok && (
          <>
            <p className="text-sm text-white/70">{req.detail}</p>
            <div className="flex flex-wrap gap-2">
              {req.actions.map((a) => <ActionButton key={a.label} action={a} reqId={req.id} {...handlers} />)}
            </div>
          </>
        )}
      </div>
    </li>
  );
}

function ActionButton({ action, reqId, onHostAction, onTerminal }: { action: RequirementAction; reqId: string } & ActionHandlers) {
  const cls = "inline-flex min-h-11 items-center gap-1.5 rounded-md bg-white/10 px-3 text-sm hover:bg-white/20";
  if (action.kind === "terminal") {
    return (
      <button type="button" className={cls} onClick={() => onTerminal(action.command)} title={action.command}>
        <TerminalSquare className="size-4" /> {action.label}
      </button>
    );
  }
  if (action.kind === "link") {
    return (
      <a className={cls} href={action.url} target="_blank" rel="noreferrer">
        <ExternalLink className="size-4" /> {action.label}
      </a>
    );
  }
  return (
    <button type="button" className={cls} onClick={() => void onHostAction(reqId, action.action)}>
      {action.label}
    </button>
  );
}
