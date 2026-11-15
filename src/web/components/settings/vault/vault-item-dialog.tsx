/**
 * Adding or editing one vault item. The public tier carries its fixed warning (and a stronger one
 * when the name looks like a secret); a locked tier asks for its password in the dialog when it
 * is not unlocked — always for Sealed. Editing a locked item never loads its value: an empty
 * value field keeps the current one.
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DesignResponsiveDialog } from "@/components/design/dialogs/design-responsive-dialog";
import { useNow } from "@/hooks/use-now";
import { vaultApi, vaultFailure, vaultFailureDetail, type VaultFailure } from "@/lib/vault-client";
import { looksSecretName, VAULT_TIER_LABELS, type VaultItemKind, type VaultItemMeta, type VaultTier } from "../../../../shared/vault";
import { VaultPasswordInput } from "../../chat/vault-card-parts";
import { PublicTierWarning, SecretNameWarning, VaultKindSelect, VaultNameInput, VaultValueInput } from "./vault-fields";

export interface VaultItemEdit {
  tier: VaultTier;
  /** Absent when adding. */
  item?: VaultItemMeta;
  /** The current value, for a public item (locked values are never loaded for editing). */
  value?: string;
  /** Ask for the tier's password from the start. */
  askPassword: boolean;
}

export function VaultItemDialog({ edit, onClose, onDone }: { edit: VaultItemEdit | null; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<VaultItemKind>("other");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [password, setPassword] = useState("");
  const [askPassword, setAskPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<VaultFailure | null>(null);
  const now = useNow(!!failure?.lockedUntil);

  useEffect(() => {
    setName(edit?.item?.name ?? "");
    setKind(edit?.item?.kind ?? "other");
    setValue(edit?.value ?? "");
    setNote("");
    setPassword("");
    setAskPassword(edit?.askPassword ?? false);
    setFailure(null);
  }, [edit]);

  if (!edit) return null;
  const { tier, item } = edit;
  const locked = tier !== "public";
  const lockedOut = (failure?.lockedUntil ?? 0) > now;
  const ready = !busy && !lockedOut && name.trim().length > 0 && (item ? true : value.length > 0) && (!askPassword || password.length > 0);
  const detail = failure ? vaultFailureDetail(failure, now) : null;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setFailure(null);
    const pw = askPassword ? password : undefined;
    try {
      if (item) {
        await vaultApi.updateItem(item.id, {
          name: name.trim(), kind, ...(value ? { value } : {}), ...(note ? { note } : {}),
        }, pw);
      } else {
        await vaultApi.addItem({ tier, name: name.trim(), kind, value, ...(note ? { note } : {}), password: pw });
      }
      onDone();
      onClose();
    } catch (e) {
      const f = vaultFailure(e);
      if (f.needsPassword && locked) setAskPassword(true);
      setFailure(f);
    } finally {
      setBusy(false);
    }
  };

  return (
    <DesignResponsiveDialog
      open
      onClose={() => { if (!busy) onClose(); }}
      title={`${item ? "Edit" : "Add"} ${VAULT_TIER_LABELS[tier]} item`}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button disabled={!ready} onClick={() => void submit()}>{item ? "Save" : "Add"}</Button>
        </>
      }
    >
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        {tier === "public" && <PublicTierWarning />}
        <VaultNameInput value={name} onChange={setName} disabled={busy} />
        {tier === "public" && looksSecretName(name) && <SecretNameWarning />}
        <VaultKindSelect value={kind} onChange={setKind} disabled={busy} />
        <VaultValueInput value={value} onChange={setValue} disabled={busy} masked={locked}
          placeholder={item && locked ? "New value (leave empty to keep the current one)" : "Value"} />
        <Input aria-label="Note" placeholder={item ? "Note (leave empty to keep)" : "Note (optional)"} autoComplete="off"
          value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} className="h-11 md:h-9" />
        {askPassword && locked && (
          <VaultPasswordInput label={`${VAULT_TIER_LABELS[tier]} tier password`} value={password} onChange={setPassword} disabled={busy} invalid={!!failure} />
        )}
        {failure && <p className="text-xs text-error" role="alert">{failure.message}{detail && ` ${detail}`}</p>}
      </form>
    </DesignResponsiveDialog>
  );
}
