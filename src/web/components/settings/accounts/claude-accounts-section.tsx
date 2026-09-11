/**
 * Claude accounts: added, removed, enabled, exported, imported and rotated here.
 *
 * It used to live behind the chat usage chip, where a 350px-tall strip had to carry an
 * account list, four dialogs and a delete confirmation. The chip keeps what it is good at —
 * showing the current session's usage — and management moved here, so there is a single
 * place that can add or remove an account rather than two that can drift.
 */

import { useState } from "react";
import {
  Download,
  KeyRound,
  Loader2,
  Plus,
  Settings,
  Upload,
  FlaskConical,
} from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { AccountCardRow, AccountsPaneHeader, AccountsPaneMessage } from "./accounts-pane-header";
import { patchAccount, deleteAccount, type OAuthProfileData } from "../../../lib/api-settings";
import { AccountProfilePanel } from "./account-profile-panel";
import { AccountDeleteConfirm } from "./account-delete-confirm";
import { AccountCard } from "./account-card";
import { AddAccountDialog } from "./account-add-dialog";
import { ExportAccountsDialog } from "./account-export-dialog";
import { ImportAccountsDialog } from "./account-import-dialog";
import { AccountRotationSettings } from "./account-rotation-settings";
import { AccountTokenTestDialog } from "./account-token-test-dialog";
import { useAccountsData } from "./use-accounts-data";
import { formatLastUpdated } from "./account-usage-format";

export function ClaudeAccountsSection() {
  const { usages, accounts, activeAccountId, initialLoading, refreshing, flashIds, reload } = useAccountsData();

  const [message, setMessage] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; display: string } | null>(null);
  const [profileView, setProfileView] = useState<{ profile: OAuthProfileData; accountId: string } | null>(null);
  const [exportPreselect, setExportPreselect] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"add" | "export" | "import" | "rotation" | "token-test" | null>(null);

  function handleSuccess(msg?: string) {
    void reload();
    if (msg) setMessage(msg);
  }

  async function handleToggle(id: string, status: string) {
    // Enabling a parked account makes the server prove its token first, which is a network
    // round trip that can come back 400 — and `patchAccount` throws on that. Without the
    // catch, the message the server took care to write reaches nobody and the switch just
    // snaps back. The pending flag is because that trip can take most of a minute.
    setTogglingId(id);
    try {
      await patchAccount(id, { status: status === "disabled" ? "active" : "disabled" });
    } catch (e) {
      setMessage((e as Error).message);
    }
    setTogglingId(null);
    void reload();
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      await deleteAccount(deleteTarget.id);
      setMessage(`Account "${deleteTarget.display}" removed.`);
      void reload();
    } catch (e) {
      setMessage(`Failed to remove: ${(e as Error).message}`);
    }
    setDeleteTarget(null);
  }

  const accountMap = new Map(accounts.map((a) => [a.id, a]));
  const lastFetched = usages[0]?.usage.lastFetchedAt;

  return (
    <div className="space-y-4">
      <AccountsPaneHeader
        description="Connect multiple Claude accounts. PPM rotates between them automatically to avoid rate limits."
        onRefresh={() => void reload()}
        refreshing={refreshing}
        disabled={initialLoading}
        actions={<>
          <Button size="sm" className="cursor-pointer gap-1.5" onClick={() => setDialog("add")}>
            <Plus className="size-4" /> Add account
          </Button>
          <Button size="sm" variant="outline" className="cursor-pointer gap-1.5" onClick={() => { setExportPreselect(null); setDialog("export"); }}>
            <Download className="size-4" /> Export
          </Button>
          <Button size="sm" variant="outline" className="cursor-pointer gap-1.5" onClick={() => setDialog("import")}>
            <Upload className="size-4" /> Import
          </Button>
          <Button size="sm" variant="outline" className="cursor-pointer gap-1.5" onClick={() => setDialog("rotation")}>
            <Settings className="size-4" /> Rotation
          </Button>
          <Button size="sm" variant="outline" className="cursor-pointer gap-1.5" onClick={() => setDialog("token-test")}>
            <FlaskConical className="size-4" /> Token test
          </Button>
        </>}
      />

      <AccountsPaneMessage message={message} onDismiss={() => setMessage(null)} />

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Accounts</h3>
          {lastFetched && (
            <span className="text-[10px] text-muted-foreground">
              usage {formatLastUpdated(new Date(lastFetched).getTime())}
            </span>
          )}
        </div>

        {initialLoading ? (
          <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading accounts...
          </div>
        ) : usages.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <KeyRound className="size-5 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No accounts connected yet.</p>
            <p className="text-xs text-muted-foreground">Add one to start using PPM.</p>
          </div>
        ) : (
          <AccountCardRow>
            {usages.map((entry) => (
              <AccountCard
                layout="strip"
                key={entry.accountId}
                entry={entry}
                isActive={entry.accountId === activeAccountId}
                accountInfo={accountMap.get(entry.accountId)}
                onToggle={handleToggle}
                toggling={togglingId === entry.accountId}
                onDelete={(id, display) => setDeleteTarget({ id, display })}
                onExport={(id) => { setExportPreselect(id); setDialog("export"); }}
                onViewProfile={(profile, accountId) => setProfileView({ profile, accountId })}
                flash={flashIds.has(entry.accountId)}
              />
            ))}
          </AccountCardRow>
        )}
      </section>

      {profileView && (
        <AccountProfilePanel
          profile={profileView.profile}
          accountId={profileView.accountId}
          onClose={() => setProfileView(null)}
        />
      )}

      {deleteTarget && (
        <AccountDeleteConfirm
          display={deleteTarget.display}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      <AddAccountDialog open={dialog === "add"} onOpenChange={(v) => setDialog(v ? "add" : null)} onSuccess={handleSuccess} />
      <ExportAccountsDialog
        open={dialog === "export"}
        onOpenChange={(v) => { setDialog(v ? "export" : null); if (!v) setExportPreselect(null); }}
        accounts={accounts}
        preselectId={exportPreselect}
        onMessage={setMessage}
      />
      <ImportAccountsDialog open={dialog === "import"} onOpenChange={(v) => setDialog(v ? "import" : null)} onSuccess={handleSuccess} />
      <AccountRotationSettings open={dialog === "rotation"} onOpenChange={(v) => setDialog(v ? "rotation" : null)} />
      <AccountTokenTestDialog open={dialog === "token-test"} onOpenChange={(v) => setDialog(v ? "token-test" : null)} accounts={accounts} />
    </div>
  );
}
