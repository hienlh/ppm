/**
 * The line beside Connect · Test · Save: what the last Test or Connect found out.
 *
 * On a phone it sits above the buttons across the whole width and wraps; on a wider screen it
 * shares their row and keeps to one line, with the full text in its title.
 */
import { AlertCircle, CheckCircle2, Loader2 } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { DbTestFailure, DbTestSuccess } from "../../../../shared/db-connection-config";

export type RunState =
  | { kind: "idle" }
  | { kind: "running"; action: "test" | "connect" | "save"; target: string }
  | { kind: "ok"; result: DbTestSuccess; key: string }
  | { kind: "failed"; result: DbTestFailure; key: string }
  | { kind: "saveFailed"; message: string };

export function ConnectionTestResult({ run, successDetail, successDetails, detailsOpen, onToggleDetails }: {
  run: RunState;
  /** The small print after the version, worked out by the tab from the current form. */
  successDetail: string;
  /** What Details shows after a success: the tunnel's host keys and SSL. */
  successDetails: string;
  detailsOpen: boolean;
  onToggleDetails: () => void;
}) {
  const idle = run.kind === "idle";
  let icon: React.ReactNode = null;
  let text: React.ReactNode = null;
  let title = "";
  if (run.kind === "running") {
    const doing = run.action === "test" ? "Testing connection…" : run.action === "connect" ? "Connecting…" : "Saving…";
    icon = <Loader2 className="size-4 animate-spin text-text-2" />;
    text = <>{doing}{run.target && <Small>{run.target}</Small>}</>;
    title = `${doing} ${run.target}`;
  } else if (run.kind === "ok") {
    icon = <CheckCircle2 className="size-4 text-success" />;
    text = <><b className="font-semibold">Connected:</b> {run.result.version}<Small>{successDetail}</Small></>;
    title = `Connected: ${run.result.version} · ${successDetail}`;
  } else if (run.kind === "failed") {
    icon = <AlertCircle className="size-4 text-error" />;
    text = <><b className="font-semibold text-error">Connection failed:</b> {run.result.error}</>;
    title = `Connection failed: ${run.result.error}`;
  } else if (run.kind === "saveFailed") {
    icon = <AlertCircle className="size-4 text-error" />;
    text = <><b className="font-semibold text-error">Could not save:</b> {run.message}</>;
    title = `Could not save: ${run.message}`;
  }
  const details = run.kind === "failed" ? run.result.details : run.kind === "ok" ? successDetails : "";

  return (
    <>
      <div
        role="status"
        aria-live="polite"
        data-testid="db-connection-result"
        data-state={run.kind}
        className={cn(
          "order-first basis-full grow md:order-none md:basis-0 min-w-0 flex items-start md:items-center gap-2 md:ml-1.5 text-[13.5px] md:text-[12.5px] text-text-primary",
          idle && "hidden md:flex md:invisible",
        )}
      >
        {icon && <span className="grid place-items-center shrink-0 pt-0.5 md:pt-0">{icon}</span>}
        <span title={title} className="min-w-0 break-words md:truncate">{text}</span>
        {details && (
          <button
            type="button"
            onClick={onToggleDetails}
            aria-expanded={detailsOpen}
            className="shrink-0 min-h-11 min-w-11 md:min-h-0 md:min-w-0 text-[13px] md:text-[12px] text-primary underline-offset-2 hover:underline"
          >
            {detailsOpen ? "Hide details" : "Details"}
          </button>
        )}
      </div>
      {details && detailsOpen && (
        <pre
          data-testid="db-connection-details"
          className="order-first md:order-none basis-full m-0 max-h-[30vh] md:max-h-60 overflow-auto rounded-md border border-border-soft bg-surface px-2.5 py-2 font-mono text-[11.5px] leading-normal text-text-2 whitespace-pre-wrap break-words"
        >
          {details}
        </pre>
      )}
    </>
  );
}

function Small({ children }: { children: React.ReactNode }) {
  return <small className="block md:inline md:ml-1.5 mt-0.5 md:mt-0 text-[12.5px] md:text-[12px] text-text-subtle">{children}</small>;
}
