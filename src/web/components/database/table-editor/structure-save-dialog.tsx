/**
 * DBGate's Save changes dialog and its "Error when saving": the script a change turns into, read
 * from the server and shown read-only, then OK to run it, Close, or Open script to take it to a new
 * Query tab instead. A script that rebuilds a table (SQLite) runs only once Allow recreate is
 * ticked, and a MySQL script is said to commit statement by statement. A table changed under the
 * script meanwhile brings the new script back to be read again rather than running either.
 *
 * Loaded the first time a change is saved: it carries Monaco with it.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { api, ApiError } from "@/lib/api-client";
import { targetUrl } from "@/lib/db-tabs";
import type { StructureApplyResult, StructureFailure, StructurePreview } from "../../../../shared/db-structure-change";
import { CheckRow } from "../connection-form/form-controls";
import { refreshAfterStructureChange } from "../explorer/db-explorer-store";
import { openQueryTab } from "../explorer/open-db-tabs";
import { ReadOnlySql } from "../sql-object/sql-object-tab";
import { EditorDialog, type EditorDialogButton } from "./editor-dialog";
import { endStructureSave, type StructureSaveRequest } from "./structure-save-store";
import { OUTCOME_LABEL, failureOf, newerPreviewOf, statementReports } from "./structure-save-model";

const RECREATE_TEXT = "This operation is not directly supported by SQL engine. PPM can emulate it, but please check the generated SQL script.";
const MYSQL_TEXT = "MySQL commits each statement of this script on its own: should one fail, those before it stay applied.";

type Step =
  | { step: "reading" }
  | { step: "confirm"; preview: StructurePreview; notice?: string }
  | { step: "applying"; preview: StructurePreview }
  | { step: "failed"; message: string; preview?: StructurePreview; failure?: StructureFailure | null };

export function StructureSaveDialog({ request, seq }: { request: StructureSaveRequest; seq: number }) {
  const [state, setState] = useState<Step>({ step: "reading" });
  const [allowRecreate, setAllowRecreate] = useState(false);
  const close = () => endStructureSave(seq);

  useEffect(() => {
    let cancelled = false;
    api.post<StructurePreview>(targetUrl(request.target, "/structure/preview"), { change: request.change })
      .then((preview) => {
        if (cancelled) return;
        if (preview.statements.length > 0) { setState({ step: "confirm", preview }); return; }
        toast.info("Nothing to save: the database already has the table this way");
        endStructureSave(seq);
      })
      .catch((e: unknown) => { if (!cancelled) setState({ step: "failed", message: (e as Error).message }); });
    return () => { cancelled = true; };
  }, [request, seq]);

  const apply = async (preview: StructurePreview) => {
    setState({ step: "applying", preview });
    try {
      await api.post<StructureApplyResult>(targetUrl(request.target, "/structure/apply"), {
        change: request.change, allowRecreate: preview.recreate && allowRecreate, sql: preview.sql,
      });
    } catch (e) {
      const body = e instanceof ApiError ? e.body : null;
      const newer = e instanceof ApiError && e.status === 409 ? newerPreviewOf(body) : null;
      if (newer) {
        // A script nobody read yet: its own tick, not the old one's.
        setAllowRecreate(false);
        setState({ step: "confirm", preview: newer, notice: (e as Error).message });
        return;
      }
      setState({ step: "failed", message: (e as Error).message, preview, failure: failureOf(body) });
      return;
    }
    toast.success("Saved to database");
    endStructureSave(seq);
    request.onSaved?.();
    void refreshAfterStructureChange(request.target);
  };

  if (state.step === "failed") {
    return (
      <EditorDialog
        title="Error when saving"
        description="Why the change could not be saved"
        onClose={close}
        onSubmit={close}
        problems={[]}
        buttons={[{ label: "Close", onClick: close, variant: "default" }]}
        wide
      >
        <p role="alert" className="whitespace-pre-wrap break-words text-[13px] text-text-primary">{state.message}</p>
        {state.preview && state.failure && <StatementList preview={state.preview} failure={state.failure} />}
      </EditorDialog>
    );
  }

  const preview = state.step === "reading" ? null : state.preview;
  const applying = state.step === "applying";
  const blocked = !preview || applying || (preview.recreate && !allowRecreate);
  const openScript = () => {
    if (!preview) return;
    close();
    openQueryTab(request.place, preview.sql);
  };
  const buttons: EditorDialogButton[] = [
    { label: applying ? "Saving…" : "OK", onClick: () => { if (preview && !blocked) void apply(preview); }, variant: "default", disabled: blocked },
    { label: "Close", onClick: close, disabled: applying },
    { label: "Open script", onClick: openScript, disabled: !preview || applying },
  ];

  return (
    <EditorDialog
      title="Save changes"
      description="The script that makes the change, to read before it runs"
      // Nothing closes it while the script runs: what it did is the answer that comes back.
      onClose={() => { if (!applying) close(); }}
      onSubmit={blocked ? undefined : () => void apply(preview!)}
      problems={[]}
      buttons={buttons}
      wide
    >
      {state.step === "confirm" && state.notice && (
        <p role="alert" className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[12.5px] text-text-primary">{state.notice}</p>
      )}
      <div className="h-[min(22rem,45dvh)] overflow-hidden rounded-md border border-border bg-panel-2">
        {preview ? <ReadOnlySql sql={preview.sql} /> : (
          <div className="grid h-full place-items-center text-text-subtle" role="status" aria-label="Reading the script">
            <Loader2 className="size-5 animate-spin" />
          </div>
        )}
      </div>
      {preview && preview.warnings.length > 0 && (
        <ul className="grid gap-1 text-[12.5px] text-warning">
          {preview.warnings.map((w) => <li key={w}>{w}</li>)}
        </ul>
      )}
      {preview && !preview.transactional && <p className="text-[12.5px] text-text-2">{MYSQL_TEXT}</p>}
      {preview?.recreate && (
        <div className="grid gap-1.5">
          <p className="text-[12.5px] text-warning">{RECREATE_TEXT}</p>
          <CheckRow
            id="structure-save-recreate" title="Allow recreate (don't use on production databases)"
            checked={allowRecreate} disabled={applying} onChange={setAllowRecreate}
          />
        </div>
      )}
    </EditorDialog>
  );
}

const OUTCOME_CLASS = {
  ran: "text-success",
  "rolled-back": "text-text-subtle",
  failed: "text-error font-semibold",
  "not-run": "text-text-subtle",
} as const;

/** Each statement of the script with what became of it, the failed one marked. */
function StatementList({ preview, failure }: { preview: StructurePreview; failure: StructureFailure }) {
  const reports = statementReports(preview, failure);
  return (
    <ol aria-label="Statements" className="grid max-h-64 gap-px overflow-y-auto rounded-md border border-border bg-border-soft">
      {reports.map((r, i) => (
        <li key={i} className={cn("grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2 bg-panel-2 px-2.5 py-1.5", r.outcome === "failed" && "bg-error/10")}>
          <span className={cn("text-xs", r.outcome ? OUTCOME_CLASS[r.outcome] : "text-text-dim")}>{r.outcome ? OUTCOME_LABEL[r.outcome] : ""}</span>
          <code className={cn("whitespace-pre-wrap break-words font-mono text-[11.5px]", r.outcome === null ? "text-text-dim" : "text-text-primary")}>{r.sql}</code>
        </li>
      ))}
    </ol>
  );
}
