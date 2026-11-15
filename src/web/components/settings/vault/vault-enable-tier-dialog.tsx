/**
 * Turning on the Secure or Sealed tier: its password twice, the warning that a forgotten password
 * loses the tier for good, and a tick acknowledging it. The Sealed tier's password must differ
 * from the Secure tier's (the server checks that by trying it).
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { DesignResponsiveDialog } from "@/components/design/dialogs/design-responsive-dialog";
import { vaultApi, vaultFailure } from "@/lib/vault-client";
import { VAULT_TIER_LABELS, type VaultLockedTier } from "../../../../shared/vault";
import { VaultCheckRow } from "../../chat/vault-card-parts";
import { ForgetPasswordWarning, newPasswordProblem, VaultNewPasswordFields } from "./vault-new-password-fields";

export function VaultEnableTierDialog({ tier, onClose, onDone }: { tier: VaultLockedTier | null; onClose: () => void; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPassword("");
    setConfirm("");
    setAck(false);
    setError(null);
  }, [tier]);

  if (!tier) return null;
  const problem = newPasswordProblem(tier, password, confirm);
  const ready = !busy && !problem && ack;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await vaultApi.enableTier(tier, password);
      onDone();
      onClose();
    } catch (e) {
      setError(vaultFailure(e).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <DesignResponsiveDialog
      open
      onClose={() => { if (!busy) onClose(); }}
      title={`Turn on the ${VAULT_TIER_LABELS[tier]} tier`}
      description={tier === "secure"
        ? "Items here are encrypted. The AI reads them only after you type this password on a card."
        : "Items here are encrypted under a second password. One item per card, shown to you unless you give it to the AI."}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button disabled={!ready} onClick={() => void submit()}>Turn on</Button>
        </>
      }
    >
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <VaultNewPasswordFields tier={tier} password={password} confirm={confirm} onPassword={setPassword} onConfirm={setConfirm} disabled={busy} label={`${VAULT_TIER_LABELS[tier]} tier password`} />
        {tier === "sealed" && <p className="text-xs text-text-secondary">This password must differ from the Secure tier's password.</p>}
        <ForgetPasswordWarning />
        <VaultCheckRow checked={ack} onChange={setAck} disabled={busy} dataAttr="forget-ack">
          I understand that PPM cannot recover this password or the items under it.
        </VaultCheckRow>
        {error && <p className="text-xs text-error" role="alert">{error}</p>}
      </form>
    </DesignResponsiveDialog>
  );
}
