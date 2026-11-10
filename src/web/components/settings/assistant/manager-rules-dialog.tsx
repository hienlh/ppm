/**
 * A project's manager rules (`.ppm/manager.md`), edited by the user. The editable text is the
 * whole file in force; the lines the manager added since the user last approved are listed
 * read-only below it. Save writes the file and the approved copy together, so the user's own edit
 * never comes back as a decision — and it is always noted with its diff.
 *
 * When the manager made a change PPM held, the dialog shows it with Approve change / Revert, the
 * same decision the card offers, named by the change's hash.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Check, Loader2, Undo2 } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import {
  decideManagerRules, getManagerRules, putManagerRules, utf8Bytes, type ManagerRulesView,
} from "@/lib/assistant-settings-client";
import { RULES_GUARD_HINT } from "@/lib/assistant-manager-table";
import { RULES_FILE_MAX_BYTES } from "../../../../shared/assistant-limits";
import { AssistantSettingsDialog, DIALOG_BUTTON, DialogActions } from "./assistant-settings-dialog";
import { SizeCounter, RulesTextarea } from "./rules-text-fields";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function HeldChange({ rules, busy, onDecide }: { rules: ManagerRulesView; busy: boolean; onDecide: (a: "approve" | "revert") => void }) {
  const diff = rules.proposedDiff;
  return (
    <div className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3" data-rules-change="">
      <p className="text-sm font-medium">Rules change waiting</p>
      <p className="text-xs text-text-secondary">The manager changed its rules in a way PPM does not accept on its own. The rules in force stay as they are until you choose.</p>
      {diff && (diff.added.length > 0 || diff.removed.length > 0) ? (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-panel-2 px-3 py-2 font-mono text-xs">
          {diff.removed.map((l, i) => <span key={`r${i}`} className="block text-error">- {l}</span>)}
          {diff.added.map((l, i) => <span key={`a${i}`} className="block text-success">+ {l}</span>)}
        </pre>
      ) : <p className="text-xs text-text-subtle">The change is too large to show line by line.</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" className={`${DIALOG_BUTTON} gap-1`} disabled={busy} onClick={() => onDecide("approve")}><Check className="size-3.5" />Approve change</Button>
        <Button size="sm" variant="outline" className={`${DIALOG_BUTTON} gap-1 text-error`} disabled={busy} onClick={() => onDecide("revert")}><Undo2 className="size-3.5" />Revert</Button>
      </div>
    </div>
  );
}

export function ManagerRulesDialog({ projectName, onClose }: { projectName: string; onClose: () => void }) {
  const [rules, setRules] = useState<ManagerRulesView | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    getManagerRules(projectName)
      .then((r) => { if (live) { setRules(r); setText(r.accepted ?? r.approved ?? ""); } })
      .catch((e) => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [projectName]);

  const original = rules ? rules.accepted ?? rules.approved ?? "" : "";
  const bytes = utf8Bytes(text);
  const tooBig = bytes > RULES_FILE_MAX_BYTES;

  const run = async (work: () => Promise<ManagerRulesView>, done: string, close: boolean) => {
    setBusy(true);
    try {
      const next = await work();
      toast.success(done);
      if (close) { onClose(); return; }
      setRules(next);
      setText(next.accepted ?? next.approved ?? "");
    } catch (e) {
      toast.error("Could not change the rules", { description: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AssistantSettingsDialog open wide title={`${projectName} manager rules`} description={RULES_GUARD_HINT} onClose={onClose}>
      {error && <p className="text-sm text-error" role="alert">{error}</p>}
      {!rules && !error && <p className="flex items-center gap-2 text-sm text-text-subtle"><Loader2 className="size-3.5 animate-spin" />Loading the rules…</p>}
      {rules && (
        <div className="space-y-3">
          {rules.pendingHash && rules.proposed !== null && (
            <HeldChange rules={rules} busy={busy}
              onDecide={(action) => void run(() => decideManagerRules(projectName, action, rules.pendingHash!), action === "approve" ? "Change approved" : "Change reverted", false)} />
          )}
          <RulesTextarea label=".ppm/manager.md" value={text} disabled={busy} onChange={setText} />
          <SizeCounter bytes={bytes} />
          {rules.addedSince.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-text-subtle">Added by the manager since</p>
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-panel-2 px-3 py-2 font-mono text-xs text-text-secondary" data-added-since="">
                {rules.addedSince.join("\n")}
              </pre>
            </div>
          )}
          <DialogActions>
            <Button type="button" variant="outline" onClick={onClose} className={DIALOG_BUTTON}>Cancel</Button>
            <Button type="button" disabled={busy || tooBig || text === original} className={DIALOG_BUTTON}
              onClick={() => void run(() => putManagerRules(projectName, text), "Rules saved", true)}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : "Save"}
            </Button>
          </DialogActions>
        </div>
      )}
    </AssistantSettingsDialog>
  );
}
