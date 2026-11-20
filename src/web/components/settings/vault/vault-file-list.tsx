/**
 * The files attached to one Secure or Sealed item in Settings → Vault: label, type and size, and
 * Preview, Download, Rename and Delete as always-visible buttons (no hover-only reveal). Nothing
 * here holds a file's bytes: opening one goes through the tier's password and lands in the viewer.
 */
import { Download, Eye, FileText, Image, Pencil, Trash2 } from "@/lib/icons";
import { formatVaultFileSize, VAULT_FILE_TYPE_LABELS, type VaultAttachmentMeta } from "../../../../shared/vault";
import { IconButton } from "../settings-rows";

export interface VaultFileActions {
  onPreview: (file: VaultAttachmentMeta) => void;
  onDownload: (file: VaultAttachmentMeta) => void;
  onRename: (file: VaultAttachmentMeta) => void;
  onDelete: (file: VaultAttachmentMeta) => void;
}

export function VaultFileList({ files, actions }: { files: VaultAttachmentMeta[]; actions: VaultFileActions }) {
  if (!files.length) return null;
  return (
    <ul className="mt-2 space-y-1.5" data-vault-files="">
      {files.map((f) => (
        <li key={f.id} className="flex items-center gap-2 rounded-lg border border-border bg-panel-2/60 py-1 pl-2 pr-1" data-vault-file={f.id}>
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-panel-2 text-text-secondary" aria-hidden>
            {f.type === "application/pdf" ? <FileText className="size-4" /> : <Image className="size-4" />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm">{f.label}</p>
            <p className="text-[11px] text-muted-foreground">{VAULT_FILE_TYPE_LABELS[f.type]} · {formatVaultFileSize(f.size)}</p>
          </div>
          <div className="flex shrink-0">
            <IconButton label={`Preview ${f.label}`} onClick={() => actions.onPreview(f)}><Eye className="size-4" /></IconButton>
            <IconButton label={`Download ${f.label}`} onClick={() => actions.onDownload(f)}><Download className="size-4" /></IconButton>
            <IconButton label={`Rename ${f.label}`} onClick={() => actions.onRename(f)}><Pencil className="size-4" /></IconButton>
            <IconButton label={`Delete ${f.label}`} danger onClick={() => actions.onDelete(f)}><Trash2 className="size-4" /></IconButton>
          </div>
        </li>
      ))}
    </ul>
  );
}
