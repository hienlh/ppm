/**
 * Moving an item to another tier. Every locked tier involved has to open, so the dialog asks for
 * the source's and the target's password — the Secure one only while Settings' unlock is not
 * open, the Sealed one always. Moving down to Public repeats that tier's warning.
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { DesignResponsiveDialog } from "@/components/design/dialogs/design-responsive-dialog";
import { useNow } from "@/hooks/use-now";
import { vaultApi, vaultFailure, vaultFailureDetail, type VaultFailure, type VaultPasswords } from "@/lib/vault-client";
import { isVaultLockedTier, VAULT_TIER_LABELS, VAULT_TIERS, type VaultItemMeta, type VaultLockedTier, type VaultTier } from "../../../../shared/vault";
import { VaultPasswordInput } from "../../chat/vault-card-parts";
import { PublicTierWarning, VaultTierPicker } from "./vault-fields";

export interface VaultMove {
  item: VaultItemMeta;
  enabled: Record<VaultLockedTier, boolean>;
  secureOpen: boolean;
}

export function VaultMoveDialog({ move, onClose, onDone }: { move: VaultMove | null; onClose: () => void; onDone: () => void }) {
  const [to, setTo] = useState<VaultTier>("secure");
  const [passwords, setPasswords] = useState<VaultPasswords>({});
  const [forceSecure, setForceSecure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<VaultFailure | null>(null);
  const now = useNow(!!failure?.lockedUntil);

  const pickable = (tier: VaultTier) => !!move && tier !== move.item.tier && (tier === "public" || move.enabled[tier]);
  useEffect(() => {
    setTo(VAULT_TIERS.find(pickable) ?? "public");
    setPasswords({});
    setForceSecure(false);
    setFailure(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [move]);

  if (!move) return null;
  const involved = [move.item.tier, to].filter(isVaultLockedTier);
  const asked = involved.filter((t) => t === "sealed" || !move.secureOpen || forceSecure);
  const lockedOut = (failure?.lockedUntil ?? 0) > now;
  const ready = !busy && !lockedOut && pickable(to) && asked.every((t) => !!passwords[t]);
  const detail = failure ? vaultFailureDetail(failure, now) : null;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setFailure(null);
    try {
      const sent: VaultPasswords = {};
      for (const t of asked) sent[t] = passwords[t];
      await vaultApi.move(move.item.id, to, sent);
      onDone();
      onClose();
    } catch (e) {
      const f = vaultFailure(e);
      if (f.needsPassword) setForceSecure(true);
      setFailure(f);
    } finally {
      setBusy(false);
    }
  };

  return (
    <DesignResponsiveDialog
      open
      onClose={() => { if (!busy) onClose(); }}
      title={`Move “${move.item.name}”`}
      description={`Now in the ${VAULT_TIER_LABELS[move.item.tier]} tier.`}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button disabled={!ready} onClick={() => void submit()}>Move</Button>
        </>
      }
    >
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <VaultTierPicker value={to} onChange={setTo} enabled={pickable} disabled={busy} />
        {to === "public" && <PublicTierWarning />}
        {asked.map((t) => (
          <VaultPasswordInput key={t} label={`${VAULT_TIER_LABELS[t]} tier password`} value={passwords[t] ?? ""}
            onChange={(v) => setPasswords((cur) => ({ ...cur, [t]: v }))} disabled={busy} invalid={!!failure} />
        ))}
        {failure && <p className="text-xs text-error" role="alert">{failure.message}{detail && ` ${detail}`}</p>}
      </form>
    </DesignResponsiveDialog>
  );
}
