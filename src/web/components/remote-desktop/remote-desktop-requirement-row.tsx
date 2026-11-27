/**
 * One row of the Remote Desktop readiness checklist: what is missing, what to do in order
 * (`steps`), what pressing the action costs (`warning`) and what protects the PC if it goes wrong
 * (`safety`), then the row's buttons. Everything after the title shows only while the row is unmet.
 *
 * Buttons take the standard text-button size from `docs/design-guidelines.md` rule 3 (28px, 26px
 * below `md`) over this gate's own dark colours.
 */
import { AlertTriangle, CheckCircle2, Circle, ExternalLink, ShieldCheck, TerminalSquare } from "@/lib/icons";
import { TEXT_BUTTON } from "@/lib/control-size";
import { FfmpegInstallButton } from "./ffmpeg-install-button";
import { HostActionButton } from "./remote-desktop-host-action-button";
import type { HostAction, HostActionResult, RemoteDesktopRequirement, RequirementAction } from "./use-remote-desktop-readiness";

/** Every button on the checklist: the standard text-button size over the gate's own colours. */
export const GATE_BUTTON = `inline-flex items-center justify-center ${TEXT_BUTTON}`;

export interface ActionHandlers {
  onHostAction: (id: string, a: HostAction) => Promise<HostActionResult | null>;
  onTerminal: (command: string) => void;
  /** Answers a `choice` row: carry on as things are. */
  onAccept: () => void;
}

export function RequirementRow({ req, ...handlers }: { req: RemoteDesktopRequirement } & ActionHandlers) {
  return (
    <li className="flex gap-2" data-testid={`remote-desktop-requirement-${req.id}`} data-ok={req.ok}>
      {req.ok
        ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-400" />
        : <Circle className="mt-0.5 size-4 shrink-0 text-amber-300" />}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="text-sm font-medium">
          {req.title}
          {!req.ok && <span className="ml-2 text-xs font-normal text-white/50">{req.gates === "video" ? "required" : req.gates === "choice" ? "choose one" : "for mouse & keyboard"}</span>}
        </div>
        {!req.ok && (
          <>
            <p className="text-sm text-white/70">{req.detail}</p>
            {req.steps && req.steps.length > 0 && (
              <ol
                className="flex list-decimal flex-col gap-1 pl-5 text-sm text-white/80 marker:text-white/50"
                data-testid={`remote-desktop-requirement-${req.id}-steps`}
              >
                {req.steps.map((step) => <li key={step}>{step}</li>)}
              </ol>
            )}
            {req.warning && (
              <p
                className="flex gap-2 rounded-md border border-amber-300/30 bg-amber-300/10 px-3 py-2 text-xs text-amber-100"
                data-testid={`remote-desktop-requirement-${req.id}-warning`}
              >
                <AlertTriangle className="mt-px size-3.5 shrink-0 text-amber-300" />
                <span>{req.warning}</span>
              </p>
            )}
            {req.safety && (
              <p
                className="flex gap-2 rounded-md border border-emerald-300/25 bg-emerald-300/10 px-3 py-2 text-xs text-emerald-50"
                data-testid={`remote-desktop-requirement-${req.id}-safety`}
              >
                <ShieldCheck className="mt-px size-3.5 shrink-0 text-emerald-300" />
                <span>{req.safety}</span>
              </p>
            )}
            {req.actions.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {req.actions.map((a) => <ActionButton key={a.label} action={a} reqId={req.id} {...handlers} />)}
              </div>
            )}
          </>
        )}
      </div>
    </li>
  );
}

function ActionButton({ action, reqId, onHostAction, onTerminal, onAccept }: { action: RequirementAction; reqId: string } & ActionHandlers) {
  const cls = `${GATE_BUTTON} bg-white/10 hover:bg-white/20`;
  if (action.kind === "install") return <FfmpegInstallButton label={action.label} />;
  if (action.kind === "continue") {
    return (
      <button type="button" className={cls} onClick={onAccept} data-testid={`remote-desktop-requirement-${reqId}-continue`}>
        {action.label}
      </button>
    );
  }
  if (action.kind === "terminal") {
    return (
      <button type="button" className={cls} onClick={() => onTerminal(action.command)} title={action.command}>
        <TerminalSquare className="size-3.5" /> {action.label}
      </button>
    );
  }
  if (action.kind === "link") {
    return (
      <a className={cls} href={action.url} target="_blank" rel="noreferrer">
        <ExternalLink className="size-3.5" /> {action.label}
      </a>
    );
  }
  return <HostActionButton className={cls} label={action.label} run={() => onHostAction(reqId, action.action)} />;
}
