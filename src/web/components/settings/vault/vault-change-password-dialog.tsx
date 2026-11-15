/**
 * Changing a locked tier's password: the current one, then the new one twice. The server
 * re-wraps the tier's key, so no item is re-encrypted and nothing is lost, and every open unlock
 * of that tier ends.
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { DesignResponsiveDialog } from "@/components/design/dialogs/design-responsive-dialog";
import { useNow } from "@/hooks/use-now";
import { vaultApi, vaultFailure, vaultFailureDetail, type VaultFailure } from "@/lib/vault-client";
import { VAULT_TIER_LABELS, type VaultLockedTier } from "../../../../shared/vault";
import { VaultPasswordInput } from "../../chat/vault-card-parts";
import { ForgetPasswordWarning, newPasswordProblem, VaultNewPasswordFields } from "./vault-new-password-fields";

export function VaultChangePasswordDialog({ tier, onClose, onDone }: { tier: VaultLockedTier | null; onClose: () => void; onDone: () => void }) {
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<VaultFailure | null>(null);
  const now = useNow(!!failure?.lockedUntil);

  useEffect(() => {
    setCurrent("");
    setPassword("");
    setConfirm("");
    setFailure(null);
  }, [tier]);

  if (!tier) return null;
  const lockedOut = (failure?.lockedUntil ?? 0) > now;
  const ready = !busy && !lockedOut && current.length > 0 && !newPasswordProblem(tier, password, confirm);
  const detail = failure ? vaultFailureDetail(failure, now) : null;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setFailure(null);
    try {
      await vaultApi.changePassword(tier, current, password);
      onDone();
      onClose();
    } catch (e) {
      setFailure(vaultFailure(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DesignResponsiveDialog
      open
      onClose={() => { if (!busy) onClose(); }}
      title={`Change the ${VAULT_TIER_LABELS[tier]} tier password`}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button disabled={!ready} onClick={() => void submit()}>Change password</Button>
        </>
      }
    >
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <VaultPasswordInput label="Current password" value={current} onChange={setCurrent} disabled={busy} invalid={!!failure} />
        <VaultNewPasswordFields tier={tier} password={password} confirm={confirm} onPassword={setPassword} onConfirm={setConfirm} disabled={busy} />
        {tier === "sealed" && <p className="text-xs text-text-secondary">The new password must differ from the Secure tier's password.</p>}
        <ForgetPasswordWarning />
        {failure && <p className="text-xs text-error" role="alert">{failure.message}{detail && ` ${detail}`}</p>}
      </form>
    </DesignResponsiveDialog>
  );
}
