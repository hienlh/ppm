/**
 * Settings → Vault: the three tiers of PPM's secret vault (`src/shared/vault.ts`). This component
 * owns the dialogs and decides, per action, whether a password has to be asked for: never for
 * Public, for Secure only while Settings' five-minute unlock is not open (or ended meanwhile, a
 * 423), and always for Sealed.
 */
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { useNow } from "@/hooks/use-now";
import { vaultApi, vaultFailure } from "@/lib/vault-client";
import { VAULT_HISTORY_LIMIT, VAULT_LOCKED_TIERS, VAULT_TIER_LABELS, type VaultItemMeta, type VaultLockedTier } from "../../../../shared/vault";
import { useVaultSettings } from "./use-vault-settings";
import { VaultPublicGroup } from "./vault-public-group";
import { VaultLockedTierGroup, type VaultTierActions } from "./vault-locked-tier-group";
import { VAULT_REVEAL_MS, type VaultRevealed } from "./vault-item-row";
import { VaultPromptDialog, type VaultPrompt } from "./vault-prompt-dialog";
import { VaultItemDialog, type VaultItemEdit } from "./vault-item-dialog";
import { VaultMoveDialog, type VaultMove } from "./vault-move-dialog";
import { VaultEnableTierDialog } from "./vault-enable-tier-dialog";
import { VaultChangePasswordDialog } from "./vault-change-password-dialog";

export function VaultSettingsSection() {
  const { data, error, refresh } = useVaultSettings();
  const [prompt, setPrompt] = useState<VaultPrompt | null>(null);
  const [itemEdit, setItemEdit] = useState<VaultItemEdit | null>(null);
  const [move, setMove] = useState<VaultMove | null>(null);
  const [enableTier, setEnableTier] = useState<VaultLockedTier | null>(null);
  const [passwordTier, setPasswordTier] = useState<VaultLockedTier | null>(null);
  const [revealed, setRevealed] = useState<VaultRevealed | null>(null);
  const now = useNow(!!data);
  const hide = useCallback(() => setRevealed(null), []);

  if (!data) return <p className="text-xs text-muted-foreground">{error ?? "Loading…"}</p>;
  const { status, items } = data;
  const secureOpen = status.tiers.secure.settingsOpenUntil > now;
  /** Whether an action on `tier` has to ask for its password before it is tried. */
  const asksFirst = (tier: VaultLockedTier) => tier === "sealed" || !secureOpen;
  const done = () => void refresh();

  /**
   * Runs `p` on `tier`: at once when Secure is unlocked and nothing needs confirming (asking for
   * the password if the unlock ended meanwhile), otherwise through the dialog.
   */
  const act = (tier: VaultLockedTier | null, p: Omit<VaultPrompt, "askPassword" | "tier">, confirm: boolean) => {
    const run = async (password?: string) => { try { await p.run(password); } finally { done(); } };
    const full = { ...p, tier, run };
    if (tier && !confirm && !asksFirst(tier)) {
      run(undefined).catch((e) => {
        const f = vaultFailure(e);
        if (f.needsPassword) setPrompt({ ...full, askPassword: true });
        else toast.error(f.message);
      });
      return;
    }
    setPrompt({ ...full, askPassword: tier !== null && asksFirst(tier) });
  };

  const deleteItem = (item: VaultItemMeta) => act(item.tier === "public" ? null : item.tier, {
    title: `Delete “${item.name}”?`,
    description: "Deleted items stay in older backups until they expire.",
    confirmLabel: "Delete",
    danger: true,
    run: async (password) => { await vaultApi.deleteItem(item.id, password); },
  }, true);
  const moveItem = (item: VaultItemMeta) =>
    setMove({ item, enabled: { secure: status.tiers.secure.enabled, sealed: status.tiers.sealed.enabled }, secureOpen });

  const tierActions = (tier: VaultLockedTier): VaultTierActions => ({
    onEnable: () => setEnableTier(tier),
    onAdd: () => setItemEdit({ tier, askPassword: asksFirst(tier) }),
    onShow: (item) => act(tier, {
      title: `Show “${item.name}”`,
      description: `Shown here for ${VAULT_REVEAL_MS / 1000} seconds.`,
      confirmLabel: "Show",
      run: async (password) => {
        const v = await vaultApi.reveal(item.id, password);
        setRevealed({ id: item.id, value: v.value, until: Date.now() + VAULT_REVEAL_MS });
      },
    }, false),
    onHide: hide,
    onEdit: (item) => setItemEdit({ tier, item, askPassword: asksFirst(tier) }),
    onMove: moveItem,
    onDelete: deleteItem,
    onChangePassword: () => setPasswordTier(tier),
    onDeleteTier: () => setPrompt({
      tier,
      askPassword: true,
      title: `Delete the ${VAULT_TIER_LABELS[tier]} tier?`,
      description: "The tier is turned off and every item in it is deleted. Deleted items stay in older backups until they expire.",
      confirmLabel: "Delete tier",
      danger: true,
      acknowledge: `Delete all ${status.tiers[tier].itemCount} item${status.tiers[tier].itemCount === 1 ? "" : "s"} in this tier for good.`,
      run: async (password) => { try { await vaultApi.deleteTier(tier, password ?? ""); } finally { done(); } },
    }),
    ...(tier === "secure" ? {
      onUnlock: () => setPrompt({
        tier, askPassword: true, title: "Unlock the Secure tier", description: "Settings keeps it open for five minutes.", confirmLabel: "Unlock",
        run: async (password) => { try { await vaultApi.unlockSecure(password ?? ""); } finally { done(); } },
      }),
      onLock: () => {
        setRevealed(null);
        vaultApi.lock("secure").then(done, (e) => toast.error(vaultFailure(e).message));
      },
    } : {}),
  });

  return (
    <div className="space-y-6">
      <p className="text-xs leading-relaxed text-muted-foreground">
        Personal details the AI may need, kept in three tiers. The Secure and Sealed tiers are encrypted under passwords of their own,
        separate from PPM's password; neither password is stored, and a restart locks both. Deleted items stay in older backups until they expire.
        {" "}{VAULT_HISTORY_LIMIT}
      </p>
      <VaultPublicGroup
        items={items.filter((i) => i.tier === "public")}
        values={data.publicValues}
        onAdd={() => setItemEdit({ tier: "public", askPassword: false })}
        onEdit={(item) => setItemEdit({ tier: "public", item, value: data.publicValues[item.id], askPassword: false })}
        onMove={moveItem}
        onDelete={deleteItem}
      />
      {VAULT_LOCKED_TIERS.map((tier) => (
        <VaultLockedTierGroup key={tier} tier={tier} status={status.tiers[tier]} items={items.filter((i) => i.tier === tier)}
          revealed={revealed} now={now} actions={tierActions(tier)} />
      ))}
      <VaultPromptDialog prompt={prompt} onClose={() => setPrompt(null)} />
      <VaultItemDialog edit={itemEdit} onClose={() => setItemEdit(null)} onDone={done} />
      <VaultMoveDialog move={move} onClose={() => setMove(null)} onDone={done} />
      <VaultEnableTierDialog tier={enableTier} onClose={() => setEnableTier(null)} onDone={done} />
      <VaultChangePasswordDialog tier={passwordTier} onClose={() => setPasswordTier(null)} onDone={done} />
    </div>
  );
}
