/**
 * The one confirm-and-password dialog behind Settings → Vault's row and tier actions (Show,
 * Delete, Delete tier, Unlock). It stays open on a refusal and says why — attempts left, or how
 * long the tier is locked out — and asks for the password when an open Secure unlock ended
 * while the user was deciding (a 423 with no lock-out).
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { DesignResponsiveDialog } from "@/components/design/dialogs/design-responsive-dialog";
import { useNow } from "@/hooks/use-now";
import { vaultFailure, vaultFailureDetail, type VaultFailure } from "@/lib/vault-client";
import { VAULT_TIER_LABELS, type VaultLockedTier } from "../../../../shared/vault";
import { VaultCheckRow, VaultPasswordInput } from "../../chat/vault-card-parts";

export interface VaultPrompt {
  title: string;
  description?: string;
  confirmLabel: string;
  danger?: boolean;
  /** The tier whose password this action may need; null for the public tier. */
  tier: VaultLockedTier | null;
  /** Ask for the password from the start (always for Sealed; for Secure only while it is not unlocked). */
  askPassword: boolean;
  /** A statement the user must tick before the action runs. */
  acknowledge?: string;
  /** Throws to keep the dialog open; the error is shown in it. */
  run: (password?: string) => Promise<void>;
}

export function VaultPromptDialog({ prompt, onClose }: { prompt: VaultPrompt | null; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<VaultFailure | null>(null);
  const [askPassword, setAskPassword] = useState(false);
  const now = useNow(!!failure?.lockedUntil);

  // A new prompt starts clean; the password never outlives the dialog it was typed into.
  useEffect(() => {
    setPassword("");
    setAck(false);
    setFailure(null);
    setAskPassword(prompt?.askPassword ?? false);
  }, [prompt]);

  if (!prompt) return null;
  const lockedOut = (failure?.lockedUntil ?? 0) > now;
  const ready = !busy && !lockedOut && (!askPassword || password.length > 0) && (!prompt.acknowledge || ack);

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setFailure(null);
    try {
      await prompt.run(askPassword ? password : undefined);
      onClose();
    } catch (e) {
      const f = vaultFailure(e);
      if (f.needsPassword && prompt.tier) setAskPassword(true);
      setFailure(f);
    } finally {
      setBusy(false);
    }
  };
  const detail = failure ? vaultFailureDetail(failure, now) : null;

  return (
    <DesignResponsiveDialog
      open
      onClose={() => { if (!busy) onClose(); }}
      title={prompt.title}
      description={prompt.description}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button variant={prompt.danger ? "destructive" : "default"} disabled={!ready} onClick={() => void submit()}>
            {prompt.confirmLabel}
          </Button>
        </>
      }
    >
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        {askPassword && prompt.tier && (
          <VaultPasswordInput label={`${VAULT_TIER_LABELS[prompt.tier]} tier password`} value={password} onChange={setPassword} disabled={busy} invalid={!!failure} />
        )}
        {prompt.acknowledge && (
          <VaultCheckRow checked={ack} onChange={setAck} disabled={busy} dataAttr="acknowledge">{prompt.acknowledge}</VaultCheckRow>
        )}
        {failure && (
          <p className="text-xs text-error" role="alert">{failure.message}{detail && ` ${detail}`}</p>
        )}
      </form>
    </DesignResponsiveDialog>
  );
}
