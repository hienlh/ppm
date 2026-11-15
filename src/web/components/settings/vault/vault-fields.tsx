/**
 * The form pieces Settings → Vault and the chat's "save to vault" card share: the tier picker,
 * the kind picker, a masked value field with a reveal toggle, and the warnings the public tier
 * carries.
 */
import { useState } from "react";
import { AlertTriangle, Eye, EyeOff } from "@/lib/icons";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  VAULT_ITEM_KINDS, VAULT_KIND_LABELS, VAULT_MAX_NAME_LENGTH, VAULT_MAX_VALUE_LENGTH, VAULT_TIER_LABELS, VAULT_TIERS,
  type VaultItemKind, type VaultTier,
} from "../../../../shared/vault";

export const PUBLIC_TIER_NOTE =
  "Items in this tier are read freely by the AI, may be sent through Telegram and are stored as plain text on this machine. Do not keep secrets here.";

export function PublicTierWarning() {
  return (
    <p className="flex gap-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-text-primary" data-vault-public-warning="">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
      <span>{PUBLIC_TIER_NOTE}</span>
    </p>
  );
}

export function SecretNameWarning() {
  return (
    <p className="rounded-md border border-error/40 bg-error/10 p-2 text-xs text-text-primary" data-vault-secret-name-warning="">
      This name looks like a secret. Keep it in the Secure tier instead, where the AI needs your password to read it.
    </p>
  );
}

export function VaultTierPicker({ value, onChange, enabled, disabled }: {
  value: VaultTier;
  onChange: (tier: VaultTier) => void;
  /** Tiers that can be picked; a locked tier that is not turned on is shown but disabled. */
  enabled: (tier: VaultTier) => boolean;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Tier" data-vault-tier-picker="">
      {VAULT_TIERS.map((tier) => {
        const on = enabled(tier);
        return (
          <button
            key={tier}
            type="button"
            role="radio"
            aria-checked={value === tier}
            disabled={disabled || !on}
            onClick={() => onChange(tier)}
            title={on ? undefined : "Turn this tier on in Settings → Vault first"}
            className={cn(
              "min-h-11 md:min-h-8 rounded-full border px-3 text-xs transition-colors disabled:opacity-40",
              value === tier ? "border-primary bg-primary/15 text-text-primary" : "border-border text-text-secondary can-hover:hover:bg-panel-2",
            )}
          >
            {VAULT_TIER_LABELS[tier]}{on ? "" : " (off)"}
          </button>
        );
      })}
    </div>
  );
}

export function VaultKindSelect({ value, onChange, disabled }: { value: VaultItemKind; onChange: (k: VaultItemKind) => void; disabled?: boolean }) {
  return (
    <select
      aria-label="Kind"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as VaultItemKind)}
      className="h-11 md:h-9 w-full rounded-lg border border-border bg-surface px-3 text-base md:text-sm text-foreground"
    >
      {VAULT_ITEM_KINDS.map((k) => <option key={k} value={k}>{VAULT_KIND_LABELS[k]}</option>)}
    </select>
  );
}

export function VaultNameInput({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <Input
      aria-label="Name"
      placeholder="Name"
      autoComplete="off"
      maxLength={VAULT_MAX_NAME_LENGTH}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="h-11 md:h-9"
    />
  );
}

/** A value field, masked until the user asks to see it. */
export function VaultValueInput({ value, onChange, disabled, placeholder = "Value", masked = true }: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Public values are shown as typed; locked ones start hidden. */
  masked?: boolean;
}) {
  const [visible, setVisible] = useState(!masked);
  return (
    <div className="flex gap-2">
      <Input
        type={visible ? "text" : "password"}
        aria-label="Value"
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        maxLength={VAULT_MAX_VALUE_LENGTH}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="h-11 md:h-9 font-mono"
      />
      <button
        type="button"
        onClick={() => setVisible(!visible)}
        aria-label={visible ? "Hide value" : "Show value"}
        aria-pressed={visible}
        className="inline-flex size-11 md:size-9 shrink-0 items-center justify-center rounded-lg border border-border text-text-secondary can-hover:hover:bg-panel-2"
      >
        {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}
