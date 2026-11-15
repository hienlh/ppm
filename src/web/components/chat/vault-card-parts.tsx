/**
 * What the three vault cards share: the answer request and its refusal, the password field, the
 * "who asks" line and the action row. Each card answers over HTTP (`POST /api/vault/cards/:id`),
 * never through the chat socket, so a wrong password is answered on the card while it stays, and
 * the password is never in a socket broadcast. The card leaves when `approval_resolved` arrives.
 */
import { useState, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useNow } from "@/hooks/use-now";
import { vaultApi, vaultFailure, vaultFailureDetail, type VaultFailure } from "@/lib/vault-client";
import { requesterLabel } from "@/lib/vault-tool-call";
import type { VaultCardAnswer, VaultCardAnswerResult, VaultCardRequester } from "../../../shared/vault";

/** Sends the card's answer; a refusal is kept for the card to show and resolves to null. */
export function useVaultCardAnswer(requestId: string, lockedUntil = 0) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<VaultFailure | null>(() =>
    lockedUntil > Date.now()
      ? { message: "Too many wrong passwords.", status: 423, lockedUntil, needsPassword: false }
      : null);
  const lockedOut = useNow(!!failure?.lockedUntil) < (failure?.lockedUntil ?? 0);

  const send = async (answer: VaultCardAnswer): Promise<VaultCardAnswerResult | null> => {
    setBusy(true);
    setFailure(null);
    try {
      return await vaultApi.answerCard(requestId, answer);
    } catch (e) {
      setFailure(vaultFailure(e));
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { busy, failure, lockedOut, send };
}

export function VaultCardFailure({ failure }: { failure: VaultFailure | null }) {
  const now = useNow(!!failure?.lockedUntil);
  if (!failure) return null;
  const detail = vaultFailureDetail(failure, now);
  return (
    <p className="text-xs text-error" role="alert" data-vault-card-error="">
      {failure.message}{detail && ` ${detail}`}
    </p>
  );
}

export function VaultCardRequesterLine({ requester, purpose }: { requester: VaultCardRequester; purpose?: string }) {
  return (
    <div className="space-y-1 text-xs">
      <p className="text-text-secondary">
        Asked by <span className="font-medium text-text-primary">{requesterLabel(requester)}</span>
        {requester.fromTelegram && <span className="text-text-subtle"> · from Telegram</span>}
      </p>
      {purpose && <p className="whitespace-pre-wrap break-words text-text-primary" data-vault-purpose="">{purpose}</p>}
    </div>
  );
}

export function VaultPasswordInput({ label, value, onChange, disabled, invalid }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  invalid?: boolean;
}) {
  return (
    <Input
      type="password"
      autoComplete="off"
      spellCheck={false}
      placeholder={label}
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-invalid={invalid}
      disabled={disabled}
      className="h-11 md:h-8 md:max-w-64"
    />
  );
}

/**
 * The card's answers: stacked bottom-up on a phone with the main answer lowest (nearest the
 * thumb), a row on desktop; 44 px tall below `md`.
 */
export function VaultCardActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-col-reverse gap-2 md:flex-row" data-vault-card-actions="">{children}</div>;
}

export function VaultCardButton({ kind, danger, disabled, onClick, type = "button", children }: {
  kind: "primary" | "secondary";
  danger?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
  children: ReactNode;
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "h-11 md:h-8 px-4 rounded text-xs font-medium transition-colors disabled:opacity-50 md:flex-none",
        kind === "primary"
          ? danger ? "bg-error text-white can-hover:hover:bg-error/80" : "bg-primary text-primary-foreground can-hover:hover:bg-primary/80"
          : "border border-border text-text-primary can-hover:hover:bg-panel-2",
      )}
    >
      {children}
    </button>
  );
}

/** A row with a checkbox whose whole label is tappable, at least 44 px tall on a phone. */
export function VaultCheckRow({ checked, onChange, disabled, children, dataAttr }: {
  checked: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
  children: ReactNode;
  dataAttr?: string;
}) {
  return (
    <label className="flex min-h-11 md:min-h-8 cursor-pointer items-center gap-2.5 text-xs text-text-primary" data-vault-check={dataAttr}>
      <input type="checkbox" className="size-4 shrink-0 accent-primary" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="min-w-0">{children}</span>
    </label>
  );
}
