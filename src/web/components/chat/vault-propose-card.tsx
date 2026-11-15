/**
 * The card for `vault_propose`: the AI suggests saving an item, the user settles the name, kind,
 * tier and value and confirms with that tier's password (none for the public tier).
 *
 * A value the AI filled in is fetched masked (`GET /api/vault/cards/:id/prefill`), never sent
 * over the chat socket. Left as it is, it is not sent back either: the server saves its own copy.
 */
import { useEffect, useState } from "react";
import { Lock } from "@/lib/icons";
import { vaultApi, vaultFailure } from "@/lib/vault-client";
import { looksSecretName, type VaultCardAnswer, type VaultCardInput, type VaultItemKind, type VaultTier } from "../../../shared/vault";
import {
  PublicTierWarning, SecretNameWarning, VaultKindSelect, VaultNameInput, VaultTierPicker, VaultValueInput,
} from "../settings/vault/vault-fields";
import { useVaultCardAnswer, VaultCardActions, VaultCardButton, VaultCardFailure, VaultCardRequesterLine, VaultPasswordInput } from "./vault-card-parts";

type ProposeInput = Extract<VaultCardInput, { kind: "propose" }>;

/** The answer a propose card sends. `value` is left out while the AI's prefilled one stands. */
export function proposeAnswer(p: { tier: VaultTier; name: string; itemKind: VaultItemKind; value: string | null; password: string }): VaultCardAnswer {
  return {
    approved: true,
    tier: p.tier,
    name: p.name,
    itemKind: p.itemKind,
    ...(p.value !== null ? { value: p.value } : {}),
    ...(p.tier !== "public" ? { password: p.password } : {}),
  };
}

export function VaultProposeCard({ requestId, input }: { requestId: string; input: ProposeInput }) {
  const tierOn = (t: VaultTier) => t === "public" || input.enabled[t];
  const [tier, setTier] = useState<VaultTier>(() => (tierOn(input.suggestedTier) ? input.suggestedTier : "public"));
  const [name, setName] = useState(input.name);
  const [itemKind, setItemKind] = useState<VaultItemKind>(input.itemKind);
  const [prefill, setPrefill] = useState<string | null>(null);
  const [prefillError, setPrefillError] = useState<string | null>(null);
  /** What the user typed; null while the AI's value stands untouched. */
  const [typed, setTyped] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const { busy, failure, lockedOut, send } = useVaultCardAnswer(requestId);

  useEffect(() => {
    if (!input.hasPrefill) return;
    let live = true;
    vaultApi.cardPrefill(requestId)
      .then((r) => { if (live) setPrefill(r.value); })
      .catch((e) => { if (live) setPrefillError(vaultFailure(e).message); });
    return () => { live = false; };
  }, [requestId, input.hasPrefill]);

  const shownValue = typed ?? prefill ?? "";
  const canSave = !busy && !lockedOut && name.trim().length > 0 && shownValue.length > 0 && (tier === "public" || password.length > 0);
  const save = () => void send(proposeAnswer({ tier, name: name.trim(), itemKind, value: typed, password }));

  return (
    <div className="rounded-lg border-2 border-primary/40 bg-primary/10 p-3 space-y-3 select-text" data-vault-card="propose">
      <div className="flex items-center gap-2 text-primary text-sm font-medium">
        <Lock className="size-4" />
        <span>Save to the vault</span>
      </div>
      <VaultCardRequesterLine requester={input.requester} />
      <div className="grid gap-2 md:grid-cols-2">
        <VaultNameInput value={name} onChange={setName} disabled={busy} />
        <VaultKindSelect value={itemKind} onChange={setItemKind} disabled={busy} />
      </div>
      {tier === "public" && looksSecretName(name) && <SecretNameWarning />}
      <VaultTierPicker value={tier} onChange={setTier} enabled={tierOn} disabled={busy} />
      {tier === "public" && <PublicTierWarning />}
      <div className="space-y-1">
        <VaultValueInput value={shownValue} onChange={setTyped} disabled={busy} placeholder={input.hasPrefill && prefill === null ? "Loading…" : "Value"} />
        {input.hasPrefill && prefill !== null && typed === null && (
          <p className="text-[11px] text-warning" data-vault-prefill-warning="">This value is already in the chat history.</p>
        )}
        {prefillError && <p className="text-[11px] text-error">{prefillError}</p>}
      </div>
      <VaultCardFailure failure={failure} />
      <form
        className="flex flex-col gap-2 md:flex-row md:items-center"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) save();
        }}
      >
        {tier !== "public" && (
          <VaultPasswordInput label={`${tier === "secure" ? "Secure" : "Sealed"} tier password`} value={password} onChange={setPassword} disabled={busy} invalid={!!failure} />
        )}
        <VaultCardActions>
          <VaultCardButton kind="primary" type="submit" disabled={!canSave}>Save</VaultCardButton>
          <VaultCardButton kind="secondary" disabled={busy} onClick={() => void send({ approved: false })}>Decline</VaultCardButton>
        </VaultCardActions>
      </form>
    </div>
  );
}
