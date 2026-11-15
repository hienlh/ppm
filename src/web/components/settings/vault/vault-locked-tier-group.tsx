/**
 * The Secure or Sealed tier in Settings → Vault. Off: what the tier is for and Turn on. On: its
 * items and actions, plus — for Secure — whether Settings has it unlocked and for how long, with
 * Lock now. The Sealed tier never stays open, so every action there asks for its password.
 */
import { Key, Lock, Plus, ShieldCheck, Trash2 } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { formatCountdown } from "@/lib/vault-client";
import { VAULT_TIER_LABELS, type VaultItemMeta, type VaultLockedTier, type VaultTierStatus } from "../../../../shared/vault";
import { SectionHeader } from "../settings-rows";
import { VaultItemRow, type VaultRevealed } from "./vault-item-row";

const INTRO: Record<VaultLockedTier, string> = {
  secure: "Encrypted under its own password. The AI reads an item only after you type that password on a card in PPM, once or for a few minutes.",
  sealed: "Encrypted under a second, separate password and never kept open. One item per card, shown to you unless you give it to the AI that once.",
};

export interface VaultTierActions {
  onEnable: () => void;
  onAdd: () => void;
  onShow: (item: VaultItemMeta) => void;
  onHide: () => void;
  onEdit: (item: VaultItemMeta) => void;
  onMove: (item: VaultItemMeta) => void;
  onDelete: (item: VaultItemMeta) => void;
  onChangePassword: () => void;
  onDeleteTier: () => void;
  /** Secure only. */
  onUnlock?: () => void;
  onLock?: () => void;
}

export function VaultLockedTierGroup({ tier, status, items, revealed, now, actions }: {
  tier: VaultLockedTier;
  status: VaultTierStatus;
  items: VaultItemMeta[];
  revealed: VaultRevealed | null;
  now: number;
  actions: VaultTierActions;
}) {
  const label = VAULT_TIER_LABELS[tier];
  const openMs = status.settingsOpenUntil - now;
  const lockedOutMs = status.lockedUntil - now;

  if (!status.enabled) {
    return (
      <section className="space-y-3" data-vault-tier={tier}>
        <SectionHeader title={label}>{INTRO[tier]}</SectionHeader>
        <Button className="h-11 md:h-9" onClick={actions.onEnable}><Lock className="size-4" />Turn on</Button>
      </section>
    );
  }

  return (
    <section className="space-y-3" data-vault-tier={tier}>
      <SectionHeader title={label}>{INTRO[tier]}</SectionHeader>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {tier === "secure" && (openMs > 0 ? (
          <>
            <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-1 text-success" data-vault-unlocked="">
              <ShieldCheck className="size-3.5" />Unlocked, {formatCountdown(openMs)} left
            </span>
            <Button variant="outline" className="h-11 md:h-8" onClick={actions.onLock}>Lock now</Button>
          </>
        ) : (
          <>
            <span className="inline-flex items-center gap-1 rounded-full bg-panel-2 px-2 py-1 text-text-secondary"><Lock className="size-3.5" />Locked</span>
            <Button variant="outline" className="h-11 md:h-8" onClick={actions.onUnlock}>Unlock for 5 minutes</Button>
          </>
        ))}
        {tier === "sealed" && <span className="text-muted-foreground">Asks for its password at every action.</span>}
        {lockedOutMs > 0 && (
          <span className="text-error" data-vault-locked-out="">Too many wrong passwords — try again in {Math.ceil(lockedOutMs / 1000)} s.</span>
        )}
      </div>
      <div className="divide-y divide-border rounded-lg border border-border">
        {items.length === 0 && <p className="px-4 py-3 text-xs text-muted-foreground">No items yet.</p>}
        {items.map((item) => (
          <VaultItemRow
            key={item.id}
            item={item}
            revealed={revealed?.id === item.id ? revealed : null}
            onShow={() => actions.onShow(item)}
            onHide={actions.onHide}
            onEdit={() => actions.onEdit(item)}
            onMove={() => actions.onMove(item)}
            onDelete={() => actions.onDelete(item)}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button className="h-11 md:h-9" onClick={actions.onAdd}><Plus className="size-4" />Add</Button>
        <Button variant="outline" className="h-11 md:h-9" onClick={actions.onChangePassword}><Key className="size-4" />Change password</Button>
        <Button variant="outline" className="h-11 md:h-9 text-error" onClick={actions.onDeleteTier}><Trash2 className="size-4" />Delete tier</Button>
      </div>
    </section>
  );
}
