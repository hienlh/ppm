/**
 * One item in Settings → Vault: its name, kind and last change, and its actions as always-visible
 * buttons (no hover-only reveal). A public row shows its value; a locked row shows it only after
 * Show, for `VAULT_REVEAL_MS`, with Copy.
 */
import { useEffect, useState } from "react";
import { ArrowLeftRight, Copy, Eye, EyeOff, Pencil, Trash2 } from "@/lib/icons";
import { copyToClipboard } from "@/lib/clipboard";
import { useNow } from "@/hooks/use-now";
import { formatCountdown } from "@/lib/vault-client";
import { VAULT_KIND_LABELS, type VaultItemMeta } from "../../../../shared/vault";
import { IconButton } from "../settings-rows";

/** How long Settings shows a revealed locked value. */
export const VAULT_REVEAL_MS = 30_000;

export interface VaultRevealed { id: string; value: string; until: number }

const updated = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function VaultItemRow({ item, publicValue, revealed, onShow, onHide, onEdit, onMove, onDelete }: {
  item: VaultItemMeta;
  /** A public item's value, shown as it is. */
  publicValue?: string;
  /** This row's revealed value, when it is the one on show. */
  revealed?: VaultRevealed | null;
  onShow?: () => void;
  onHide?: () => void;
  onEdit: () => void;
  onMove: () => void;
  onDelete: () => void;
}) {
  const now = useNow(!!revealed);
  const [copied, setCopied] = useState(false);
  const showing = !!revealed && revealed.until > now;
  useEffect(() => {
    if (revealed && revealed.until <= now) onHide?.();
  }, [revealed, now, onHide]);
  useEffect(() => setCopied(false), [revealed]);
  const shown = publicValue ?? (showing ? revealed!.value : null);

  return (
    <div className="flex flex-col gap-1 px-4 py-2 md:flex-row md:items-center md:gap-3" data-vault-item={item.id}>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">
          {item.name} <span className="text-xs text-muted-foreground">· {VAULT_KIND_LABELS[item.kind]}</span>
        </p>
        <p className="text-[11px] text-muted-foreground">Updated {updated(item.updatedAt)}</p>
        {shown !== null && (
          <div className="mt-1 flex items-start gap-2">
            <code className="min-w-0 flex-1 select-text whitespace-pre-wrap break-all rounded bg-panel-2 px-2 py-1 font-mono text-xs" data-vault-value="">
              {shown}
            </code>
            {showing && <span className="shrink-0 pt-1 font-mono text-[11px] text-muted-foreground">{formatCountdown(revealed!.until - now)}</span>}
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-1 md:shrink-0">
        {shown !== null && (
          <IconButton label={copied ? "Copied" : "Copy"} onClick={() => void copyToClipboard(shown).then(setCopied)}>
            <Copy className="size-4" />
          </IconButton>
        )}
        {onShow && (showing
          ? <IconButton label="Hide" onClick={() => onHide?.()}><EyeOff className="size-4" /></IconButton>
          : <IconButton label="Show" onClick={onShow}><Eye className="size-4" /></IconButton>)}
        <IconButton label="Edit" onClick={onEdit}><Pencil className="size-4" /></IconButton>
        <IconButton label="Move to another tier" onClick={onMove}><ArrowLeftRight className="size-4" /></IconButton>
        <IconButton label="Delete" danger onClick={onDelete}><Trash2 className="size-4" /></IconButton>
      </div>
    </div>
  );
}
