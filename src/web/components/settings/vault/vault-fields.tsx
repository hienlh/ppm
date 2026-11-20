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

/**
 * Whether this browser can draw a textarea's characters as discs (`-webkit-text-security`):
 * Chromium and Safari can, Firefox cannot. Where it cannot, a hidden value is shown as a block of
 * dots and typing into it starts by showing it, so a value is never on screen while it says hidden.
 */
export function canMaskTextarea(): boolean {
  try {
    return typeof CSS !== "undefined" && CSS.supports("-webkit-text-security", "disc");
  } catch {
    return false;
  }
}

/** "4 lines · 52 / 8,000", the size of a value without its content. */
export function valueSizeLabel(value: string): string {
  const lines = value ? value.split("\n").length : 0;
  return `${lines} line${lines === 1 ? "" : "s"} · ${value.length.toLocaleString()} / ${VAULT_MAX_VALUE_LENGTH.toLocaleString()}`;
}

/**
 * A value field of one or many lines (an address, a list of recovery codes, a key), hidden until
 * the user asks to see it. Hidden, each character is drawn as a disc where the browser can do that,
 * else the field is a block of dots that opens on Show.
 */
export function VaultValueInput({ value, onChange, disabled, placeholder = "Value", masked = true }: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Public values are shown as typed; locked ones start hidden. */
  masked?: boolean;
}) {
  const [visible, setVisible] = useState(!masked);
  const [discs] = useState(canMaskTextarea);
  const hiddenBlock = !visible && !discs;
  return (
    <div className="space-y-1">
      <div className="flex gap-2">
        {hiddenBlock ? (
          <button
            type="button"
            onClick={() => setVisible(true)}
            disabled={disabled}
            aria-label="Hidden value. Show it to type or edit"
            data-vault-value-hidden=""
            className="min-h-24 flex-1 rounded-lg border border-dashed border-border bg-panel-2 px-3 py-2 text-left font-mono text-sm text-text-subtle"
          >
            {value ? `•••••••• (${valueSizeLabel(value).split(" · ")[0]})` : "Hidden. Tap Show to type."}
          </button>
        ) : (
          <textarea
            aria-label="Value"
            placeholder={placeholder}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-gramm="false"
            maxLength={VAULT_MAX_VALUE_LENGTH}
            rows={3}
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            data-vault-value-masked={visible ? undefined : ""}
            className={cn(
              "min-h-24 max-h-72 w-full flex-1 resize-y rounded-lg border border-border bg-surface px-3 py-2 font-mono text-base md:text-sm text-foreground",
              "placeholder:text-text-subtle disabled:opacity-60",
              !visible && "[-webkit-text-security:disc]",
            )}
          />
        )}
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
      {value.length > 0 && <p className="text-right text-[11px] text-text-subtle" data-vault-value-size="">{valueSizeLabel(value)}</p>}
    </div>
  );
}
