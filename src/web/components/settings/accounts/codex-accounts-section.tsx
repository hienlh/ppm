/**
 * Codex accounts pane.
 *
 * Same shape as the Claude pane — shared header, shared message strip, shared account card,
 * shared usage bar, and every action behind a dialog — because the two sit next to each other
 * as sub-tabs and used to look like two different products.
 */

import { useState } from "react";
import { Download, KeyRound, Loader2, Plus, Settings, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AccountCardShell, AccountsPaneHeader, AccountsPaneMessage } from "./accounts-pane-header";
import { AccountUsageBar } from "./account-bucket-row";
import { CodexAddAccountDialog } from "./codex-add-account-dialog";
import { CodexBackupDialog } from "./codex-backup-dialog";
import { CodexRotationDialog } from "./codex-rotation-dialog";
import { useCodexAccounts } from "./use-codex-accounts";

/** Usage arrives as a 0-1 fraction; the shared bar wants whole percent. */
function toPct(v?: number): number | null { return v != null ? Math.round(v * 100) : null; }

/** Codex multi-account management, separate from Claude accounts because codex auth is owned
 *  by the app-server per CODEX_HOME. Added by API key or ChatGPT device code. */
export function CodexAccountsSection() {
  const [dialog, setDialog] = useState<"add" | "export" | "import" | "rotation" | null>(null);
  const c = useCodexAccounts(() => setDialog(null));

  return (
    <div className="space-y-4">
      <AccountsPaneHeader
        description={<>Each Codex account keeps its own login (<code>CODEX_HOME</code>). One is picked per chat by the rotation setting.</>}
        onRefresh={() => void c.load()}
        refreshing={c.loading}
        actions={<>
          <Button size="sm" className="cursor-pointer gap-1.5" onClick={() => setDialog("add")}>
            <Plus className="size-4" /> Add account
          </Button>
          <Button size="sm" variant="outline" className="cursor-pointer gap-1.5" onClick={() => setDialog("export")}>
            <Download className="size-4" /> Export
          </Button>
          <Button size="sm" variant="outline" className="cursor-pointer gap-1.5" onClick={() => setDialog("import")}>
            <Upload className="size-4" /> Import
          </Button>
          <Button size="sm" variant="outline" className="cursor-pointer gap-1.5" onClick={() => setDialog("rotation")}>
            <Settings className="size-4" /> Rotation
          </Button>
        </>}
      />

      {/* Errors show here too, so a failure that happened behind a dialog is not lost when
          the dialog closes. */}
      <AccountsPaneMessage message={c.msg ?? c.err} onDismiss={() => { c.setMsg(null); c.setErr(null); }} />

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Codex Accounts</h3>
          <span className="text-[10px] text-muted-foreground capitalize">{c.strategy.replace("-", " ")}</span>
        </div>

        {c.loading && c.accounts.length === 0 ? (
          <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading accounts...
          </div>
        ) : c.accounts.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <KeyRound className="size-5 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No Codex accounts yet.</p>
            <p className="text-xs text-muted-foreground">
              Chats use your default <code>~/.codex</code> login until you add one.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {c.accounts.map((a) => {
              const u = c.usages[a.id] ?? {};
              return (
                <AccountCardShell key={a.id} data-testid="account-card" data-account-id={a.id}>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate flex-1 min-w-0">{a.label}</span>
                    <span className="text-[10px] uppercase tracking-wide text-text-subtle border border-border rounded px-1 shrink-0">
                      {a.type}
                    </span>
                    {a.planType && <span className="text-[10px] text-text-subtle shrink-0">{a.planType}</span>}
                    <button
                      type="button"
                      onClick={() => void c.remove(a.id)}
                      title="Remove account"
                      aria-label="Remove account"
                      className="p-2 rounded cursor-pointer text-text-subtle hover:text-error hover:bg-surface-elevated transition-colors shrink-0"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                  <div className="space-y-2">
                    <AccountUsageBar label="5-Hour Session" pct={toPct(u.fiveHour)} />
                    <AccountUsageBar label="Weekly" pct={toPct(u.sevenDay)} />
                  </div>
                </AccountCardShell>
              );
            })}
          </div>
        )}
      </section>

      <CodexAddAccountDialog
        open={dialog === "add"}
        onOpenChange={(v) => setDialog(v ? "add" : null)}
        label={c.label}
        onLabelChange={c.setLabel}
        apiKey={c.apiKey}
        onApiKeyChange={c.setApiKey}
        adding={c.adding}
        onAddApiKey={() => void c.addApiKey()}
        deviceWaiting={c.deviceWaiting}
        onStartDevice={() => void c.startDevice()}
        device={c.device}
        error={c.err}
      />
      <CodexBackupDialog
        mode={dialog === "export" ? "export" : dialog === "import" ? "import" : null}
        onOpenChange={(v) => { if (!v) setDialog(null); }}
        password={c.backupPassword}
        onPasswordChange={c.setBackupPassword}
        busy={c.exporting || c.importing}
        onExport={() => void c.doExport()}
        onImport={(f) => void c.doImport(f)}
        error={c.err}
      />
      <CodexRotationDialog
        open={dialog === "rotation"}
        onOpenChange={(v) => setDialog(v ? "rotation" : null)}
        strategy={c.strategy}
        onChange={(v) => void c.changeStrategy(v)}
      />
    </div>
  );
}
