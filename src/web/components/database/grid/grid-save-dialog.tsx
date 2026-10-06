/**
 * DBGate's Save changes for a grid's rows: the script the changes turn into, read from the server
 * and shown read-only, then OK to run all of it in one transaction, Close, or Open script to take
 * it to a new Query tab instead. Rows other tables still point at, about to be deleted, bring
 * "Delete references CASCADE": a box per table, whose DELETEs then come first in the script; with
 * nothing to cascade the dialog offers Don't ask again, and a save after that runs straight away.
 * A database refusing the script writes nothing: the dialog stays open with its words, so a table
 * can be ticked and OK pressed again.
 *
 * A dialog on a desktop, a bottom sheet with OK in the thumb zone on a phone. Loaded the first
 * time a grid saves: it carries Monaco with it.
 */
import { useEffect, useId, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { Loader2 } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api-client";
import { targetUrl } from "@/lib/db-tabs";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ChangesetApplyResult, ChangesetPreview } from "../../../../shared/db-changeset";
import { CheckRow } from "../connection-form/form-controls";
import { openQueryTab } from "../explorer/open-db-tabs";
import { ReadOnlySql } from "../sql-object/sql-object-tab";
import {
  cascadeTables, gridSaveAsks, refKey, refLabel, refPaths, savedText, saveScript, stopAskingGridSave,
} from "./grid-save-model";
import { endGridSave, type GridSaveRequest } from "./grid-save-store";
import { useOpenerFocus } from "./use-opener-focus";

type Step =
  | { step: "reading" }
  | { step: "unreadable"; message: string }
  /** `error`: why the last OK wrote nothing, in the server's words — which name the statement. */
  | { step: "confirm"; preview: ChangesetPreview; error?: string }
  | { step: "applying"; preview: ChangesetPreview };

export function GridSaveDialog({ request, seq }: { request: GridSaveRequest; seq: number }) {
  const [state, setState] = useState<Step>({ step: "reading" });
  // A save that does not ask is shown only once there is something to ask or to say.
  const [shown, setShown] = useState(gridSaveAsks);
  const [cascade, setCascade] = useState(false);
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const [dontAsk, setDontAsk] = useState(false);
  const ids = useId();

  const body = useMemo(() => ({ table: request.table, schema: request.schema, ...request.changes }), [request]);
  const close = () => endGridSave(seq, null);

  const apply = async (preview: ChangesetPreview, keepAsking: boolean) => {
    const ticked = cascadeTables(preview, cascade, off);
    setState({ step: "applying", preview });
    let result: ChangesetApplyResult;
    try {
      result = await api.post<ChangesetApplyResult>(targetUrl(request.target, "/changeset/apply"), {
        ...body,
        ...(ticked.length > 0 ? { cascade: ticked.map((r) => ({ schema: r.schema, table: r.table })) } : {}),
      });
    } catch (e) {
      setShown(true);
      setState({ step: "confirm", preview, error: (e as Error).message });
      return;
    }
    if (!keepAsking) stopAskingGridSave();
    toast.success(savedText(result));
    endGridSave(seq, result);
  };

  useEffect(() => {
    let cancelled = false;
    api.post<ChangesetPreview>(targetUrl(request.target, "/changeset/preview"), body)
      .then((preview) => {
        if (cancelled) return;
        // Don't ask again covers a save with nothing to cascade; deleting rows others point at asks.
        if (!shown && preview.references.length === 0) { void apply(preview, true); return; }
        setShown(true);
        setState({ step: "confirm", preview });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setShown(true);
        setState({ step: "unreadable", message: (e as Error).message });
      });
    return () => { cancelled = true; };
  }, [body]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!shown) return null;

  const preview = state.step === "confirm" || state.step === "applying" ? state.preview : null;
  const applying = state.step === "applying";
  const ticked = preview ? cascadeTables(preview, cascade, off) : [];
  const script = preview ? saveScript(preview, ticked) : "";
  const ok = preview && !applying ? () => void apply(preview, !dontAsk) : undefined;
  const openScript = request.place && preview && !applying
    ? () => { const place = request.place!; close(); openQueryTab(place, script); }
    : undefined;
  const error = state.step === "confirm" ? state.error : undefined;

  const content = (
    <>
      {error && (
        <p role="alert" className="whitespace-pre-wrap break-words rounded-md border border-error/40 bg-error/10 px-3 py-2 text-[12.5px] text-text-primary">{error}</p>
      )}
      {state.step === "unreadable" ? (
        <p role="alert" className="whitespace-pre-wrap break-words text-[13px] text-error">{state.message}</p>
      ) : (
        <div className="h-[min(20rem,40dvh)] shrink-0 overflow-hidden rounded-md border border-border bg-panel-2">
          {preview ? <ReadOnlySql sql={script} /> : (
            <div className="grid h-full place-items-center text-text-subtle" role="status" aria-label="Reading the script">
              <Loader2 className="size-5 animate-spin" />
            </div>
          )}
        </div>
      )}
      {preview && preview.references.length > 0 && (
        <div className="grid gap-1.5">
          <CheckRow
            id={`${ids}-cascade`} title="Delete references CASCADE" checked={cascade} disabled={applying} onChange={setCascade}
            help="Other tables can hold rows that point at the rows being deleted. Tick to delete those rows first."
          />
          {cascade && (
            <div className="grid gap-1.5 pl-6 max-md:pl-7">
              <div className="flex gap-4">
                <LinkButton disabled={applying} onClick={() => setOff(new Set())}>Check all</LinkButton>
                <LinkButton disabled={applying} onClick={() => setOff(new Set(preview.references.map(refKey)))}>Uncheck all</LinkButton>
              </div>
              <ul aria-label="Tables to delete from first" className="grid gap-1.5">
                {preview.references.map((r) => {
                  const key = refKey(r);
                  return (
                    <li key={key}>
                      <CheckRow
                        id={`${ids}-ref-${key}`} checked={!off.has(key)} disabled={applying}
                        title={<span className="font-mono">{refLabel(r, request.schema || null)}</span>}
                        help={[...refPaths(r), ...(r.cascadesInDb ? ["ON DELETE CASCADE in the database already"] : [])].join(" · ")}
                        onChange={(on) => setOff((prev) => {
                          const next = new Set(prev);
                          if (on) next.delete(key);
                          else next.add(key);
                          return next;
                        })}
                      />
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}
      {preview && preview.references.length === 0 && (
        <CheckRow id={`${ids}-dont-ask`} title="Don't ask again" checked={dontAsk} disabled={applying} onChange={setDontAsk} />
      )}
    </>
  );

  return (
    <SaveFrame
      onOk={ok}
      okLabel={applying ? "Saving…" : "OK"}
      // Nothing closes it while the script runs: what it did is the answer that comes back.
      onClose={applying ? undefined : close}
      onOpenScript={openScript}
      showOpenScript={!!request.place}
    >
      {content}
    </SaveFrame>
  );
}

function LinkButton({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button" onClick={onClick} disabled={disabled}
      className="text-[12.5px] text-primary select-none can-hover:hover:underline disabled:opacity-55 max-md:min-h-11 max-md:text-sm"
    >
      {children}
    </button>
  );
}

const TITLE = "Save changes";
const DESCRIPTION = "The script that writes the changes, to read before it runs";

/** DBGate's modal with OK, Close and Open script at its foot; a bottom sheet on a phone. */
function SaveFrame({ onOk, okLabel, onClose, onOpenScript, showOpenScript, children }: {
  /** Absent while OK can do nothing: no script yet, or one running. */
  onOk?: () => void;
  okLabel: string;
  /** Absent while the script runs. */
  onClose?: () => void;
  onOpenScript?: () => void;
  showOpenScript: boolean;
  children: ReactNode;
}) {
  const isMobile = useIsMobile();
  const titleId = useId();
  const backToOpener = useOpenerFocus();
  const close = () => onClose?.();

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.nativeEvent.isComposing || !onOk) return;
    // A button answers Enter itself, and Monaco keeps its own keys.
    if ((e.target as HTMLElement).closest("button, textarea, .monaco-editor")) return;
    e.preventDefault();
    onOk();
  };

  const wide = isMobile ? "h-11 flex-1 text-sm" : undefined;
  const buttons = (
    <>
      <Button type="button" size="sm" disabled={!onOk} onClick={onOk} className={cn(isMobile && "h-11 flex-[2] text-sm")}>{okLabel}</Button>
      <Button type="button" size="sm" variant="outline" disabled={!onClose} onClick={close} className={wide}>Close</Button>
      {showOpenScript && <Button type="button" size="sm" variant="outline" disabled={!onOpenScript} onClick={onOpenScript} className={wide}>Open script</Button>}
    </>
  );

  if (isMobile) {
    return (
      <BottomSheet open onClose={close} className="popover-solid">
        <div role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown} className="flex max-h-[calc(var(--sheet-vh,100dvh)*0.9)] flex-col">
          <h2 id={titleId} className="px-4 pb-2 pt-1 text-base font-semibold">{TITLE}</h2>
          <div className="grid min-h-0 grid-cols-[minmax(0,1fr)] content-start gap-3 overflow-y-auto px-4 pb-3">{children}</div>
          <div className="flex gap-2 border-t border-border-soft px-3 pt-2.5">{buttons}</div>
        </div>
      </BottomSheet>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent
        onKeyDown={onKeyDown}
        // The dialog itself, not its first button: OK waits for the script, so that would be Close,
        // and Enter — which runs OK — would close it instead.
        onOpenAutoFocus={(e) => { e.preventDefault(); (e.target as HTMLElement).focus(); }}
        onCloseAutoFocus={backToOpener}
        className="max-h-[calc(100dvh-4rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-3 p-5 sm:max-w-3xl"
      >
        <DialogHeader>
          <DialogTitle className="text-base">{TITLE}</DialogTitle>
          <DialogDescription className="sr-only">{DESCRIPTION}</DialogDescription>
        </DialogHeader>
        <div className="-mx-1 grid grid-cols-[minmax(0,1fr)] content-start gap-3 overflow-y-auto px-1 py-0.5">{children}</div>
        <div className="flex flex-wrap justify-end gap-2">{buttons}</div>
      </DialogContent>
    </Dialog>
  );
}
