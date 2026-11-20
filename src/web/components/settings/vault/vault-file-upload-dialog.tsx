/**
 * Attaching a photo or PDF to a Secure or Sealed item. A photo is shrunk to 2,000 px and redrawn
 * before it leaves the browser, which also drops its EXIF (GPS position, phone model) — unless the
 * user ticks "Keep the original" for this one upload. The tier's password is asked for here when
 * the tier is not unlocked (always for Sealed).
 */
import { useEffect, useRef, useState } from "react";
import { Upload } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DesignResponsiveDialog } from "@/components/design/dialogs/design-responsive-dialog";
import { useNow } from "@/hooks/use-now";
import { vaultApi, vaultFailure, vaultFailureDetail, type VaultFailure } from "@/lib/vault-client";
import { isPhoto, shrinkPhoto } from "@/lib/vault-photo-shrink";
import {
  formatVaultFileSize, VAULT_FILE_MAX_BYTES, VAULT_FILE_TYPES, VAULT_FILES_PER_ITEM, VAULT_MAX_LABEL_LENGTH, VAULT_PHOTO_MAX_SIDE,
  VAULT_TIER_LABELS, type VaultItemMeta, type VaultLockedTier,
} from "../../../../shared/vault";
import { VaultCheckRow, VaultPasswordInput } from "../../chat/vault-card-parts";

export interface VaultFileUpload {
  item: VaultItemMeta & { tier: VaultLockedTier };
  askPassword: boolean;
}

export function VaultFileUploadDialog({ upload, onClose, onDone }: { upload: VaultFileUpload | null; onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [label, setLabel] = useState("");
  const [keepOriginal, setKeepOriginal] = useState(false);
  const [password, setPassword] = useState("");
  const [askPassword, setAskPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<VaultFailure | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const now = useNow(!!failure?.lockedUntil);

  useEffect(() => {
    setFile(null);
    setLabel("");
    setKeepOriginal(false);
    setPassword("");
    setAskPassword(upload?.askPassword ?? false);
    setFailure(null);
  }, [upload]);

  if (!upload) return null;
  const { item } = upload;
  const tierLabel = VAULT_TIER_LABELS[item.tier];
  const full = (item.attachments?.length ?? 0) >= VAULT_FILES_PER_ITEM;
  const lockedOut = (failure?.lockedUntil ?? 0) > now;
  const ready = !busy && !lockedOut && !full && !!file && (!askPassword || password.length > 0);
  const detail = failure ? vaultFailureDetail(failure, now) : null;
  // The original is checked against the limit here; a shrunk photo is smaller still.
  const tooBig = !!file && (keepOriginal || !isPhoto(file.type)) && file.size > VAULT_FILE_MAX_BYTES;

  const submit = async () => {
    if (!ready || !file || tooBig) return;
    setBusy(true);
    setFailure(null);
    try {
      const prepared = keepOriginal ? { blob: file, name: file.name } : await shrinkPhoto(file);
      await vaultApi.uploadFile(item.id, prepared.blob, prepared.name, { label: label.trim() || undefined, password: askPassword ? password : undefined });
      onDone();
      onClose();
    } catch (e) {
      const f = vaultFailure(e);
      if (f.needsPassword) setAskPassword(true);
      setFailure(f);
    } finally {
      setBusy(false);
    }
  };

  return (
    <DesignResponsiveDialog
      open
      onClose={() => { if (!busy) onClose(); }}
      title={`Attach a file to “${item.name}”`}
      description={`Encrypted under the ${tierLabel} tier's key. Only you can open it, in PPM; no AI reads it.`}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button disabled={!ready || tooBig} onClick={() => void submit()}>{busy ? "Uploading…" : "Attach"}</Button>
        </>
      }
    >
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }} data-vault-upload="">
        <input
          ref={inputRef}
          type="file"
          accept={VAULT_FILE_TYPES.join(",")}
          className="sr-only"
          aria-label="Choose a photo or PDF"
          data-vault-upload-input=""
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            setFile(f);
            setFailure(null);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          disabled={busy || full}
          onClick={() => inputRef.current?.click()}
          className="flex min-h-20 w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border px-3 py-3 text-center text-sm text-text-secondary can-hover:hover:bg-panel-2 disabled:opacity-50"
        >
          <Upload className="size-5" />
          {file ? (
            <span className="max-w-full truncate text-text-primary" data-vault-upload-chosen="">{file.name} · {formatVaultFileSize(file.size)}</span>
          ) : (
            <span>Choose a photo or PDF</span>
          )}
          <span className="text-[11px] text-text-subtle">
            JPEG, PNG, WebP or PDF · up to {VAULT_FILE_MAX_BYTES / (1024 * 1024)} MB · {VAULT_FILES_PER_ITEM} per item
          </span>
        </button>
        {full && <p className="text-xs text-error">This item already holds {VAULT_FILES_PER_ITEM} files.</p>}
        <Input
          aria-label="Label"
          placeholder="Label, e.g. Passport photo page (optional)"
          autoComplete="off"
          maxLength={VAULT_MAX_LABEL_LENGTH}
          value={label}
          disabled={busy}
          onChange={(e) => setLabel(e.target.value)}
          className="h-11 md:h-9"
        />
        <p className="text-[11px] text-text-subtle">
          The label is what lists and the AI see. The file's own name stays encrypted with the file.
        </p>
        {file && isPhoto(file.type) && (
          <VaultCheckRow checked={keepOriginal} onChange={setKeepOriginal} disabled={busy} dataAttr="keep-original">
            Keep the original. Otherwise the photo is shrunk to {VAULT_PHOTO_MAX_SIDE.toLocaleString()} px and its EXIF
            (location, phone model) is removed before upload.
          </VaultCheckRow>
        )}
        {tooBig && <p className="text-xs text-error">This file is larger than {VAULT_FILE_MAX_BYTES / (1024 * 1024)} MB.</p>}
        {askPassword && (
          <VaultPasswordInput label={`${tierLabel} tier password`} value={password} onChange={setPassword} disabled={busy} invalid={!!failure} />
        )}
        {failure && <p className="text-xs text-error" role="alert">{failure.message}{detail && ` ${detail}`}</p>}
      </form>
    </DesignResponsiveDialog>
  );
}
