/**
 * One item in Settings → Vault: its name, kind and last change, and its actions as always-visible
 * buttons (no hover-only reveal). A public row shows its value; a locked row shows it only after
 * Show, for `VAULT_REVEAL_MS`, with Copy.
 */
import { useEffect, useState } from "react";
import { ArrowLeftRight, Copy, Eye, EyeOff, Paperclip, Pencil, Trash2 } from "@/lib/icons";
import { copyToClipboard } from "@/lib/clipboard";
import { useNow } from "@/hooks/use-now";
import { formatCountdown } from "@/lib/vault-client";
import { VAULT_KIND_LABELS, type VaultItemMeta } from "../../../../shared/vault";
import { IconButton } from "../settings-rows";
import { VaultFileList, type VaultFileActions } from "./vault-file-list";

/** How long Settings shows a revealed locked value. */
export const VAULT_REVEAL_MS = 30_000;

export interface VaultRevealed { id: string; value: string; until: number }

const updated = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function VaultItemRow({ item, publicValue, revealed, onShow, onHide, onEdit, onMove, onDelete, onAddFile, fileActions }: {
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
  /** Secure and Sealed items only: attach a photo or PDF. */
  onAddFile?: () => void;
  fileActions?: VaultFileActions;
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
    <div className="px-4 py-2" data-vault-item={item.id}>
      <div className="flex flex-col gap-1 md:flex-row md:items-start md:gap-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">
          {item.name} <span className="text-xs text-muted-foreground">· {VAULT_KIND_LABELS[item.kind]}</span>
          {!!item.attachments?.length && (
            <span className="ml-1 inline-flex items-center gap-0.5 text-xs text-muted-foreground" data-vault-file-count="">
              · <Paperclip className="size-3" />{item.attachments.length}
            </span>
          )}
        </p>
        <p className="text-[11px] text-muted-foreground">Updated {updated(item.updatedAt)}</p>
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
        {onAddFile && <IconButton label="Attach a photo or PDF" onClick={onAddFile}><Paperclip className="size-4" /></IconButton>}
        <IconButton label="Move to another tier" onClick={onMove}><ArrowLeftRight className="size-4" /></IconButton>
        <IconButton label="Delete" danger onClick={onDelete}><Trash2 className="size-4" /></IconButton>
      </div>
      </div>
      {/* Below the row, the whole width: a value of many lines and a file's label need the room. */}
      {shown !== null && (
        <div className="mt-1 flex items-start gap-2">
          <code className="block max-h-60 min-w-0 flex-1 select-text overflow-auto whitespace-pre-wrap break-all rounded bg-panel-2 px-2 py-1 font-mono text-xs" data-vault-value="">
            {shown}
          </code>
          {showing && <span className="shrink-0 pt-1 font-mono text-[11px] text-muted-foreground">{formatCountdown(revealed!.until - now)}</span>}
        </div>
      )}
      {fileActions && item.attachments?.length ? <VaultFileList files={item.attachments} actions={fileActions} /> : null}
    </div>
  );
}
