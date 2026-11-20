/**
 * A vault file opened for the user on this device: a photo, or a PDF in the browser's own viewer,
 * full screen, closing itself after `VAULT_FILE_PREVIEW_MS`. The bytes live in one Blob held by
 * this component; its object URL is revoked the moment the viewer closes, and nothing is written
 * to the browser's storage.
 */
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Download, X } from "@/lib/icons";
import { useNow } from "@/hooks/use-now";
import { formatCountdown } from "@/lib/vault-client";
import { formatVaultFileSize, VAULT_FILE_TYPE_LABELS, type VaultAttachmentMeta } from "../../../../shared/vault";

export interface VaultFileView {
  file: VaultAttachmentMeta;
  blob: Blob;
  fileName: string;
  until: number;
}

/** Saves `blob` as `fileName` through a temporary link, its URL revoked right after. */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Long enough for the browser to start the download, short enough to leave nothing behind.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function VaultFileViewer({ view, onClose }: { view: VaultFileView | null; onClose: () => void }) {
  const now = useNow(!!view);
  const [url, setUrl] = useState<string | null>(null);
  const blob = view?.blob ?? null;

  useEffect(() => {
    if (!blob) return;
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => {
      URL.revokeObjectURL(u);
      setUrl(null);
    };
  }, [blob]);

  useEffect(() => {
    if (view && now >= view.until) onClose();
  }, [view, now, onClose]);

  useEffect(() => {
    if (!view) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, onClose]);

  const isPdf = view?.file.type === "application/pdf";
  const body = useMemo(() => {
    if (!view || !url) return null;
    return isPdf
      ? <iframe title={view.file.label} src={url} className="h-full w-full border-0 bg-white" data-vault-viewer-pdf="" />
      : <img src={url} alt={view.file.label} className="max-h-full max-w-full object-contain" data-vault-viewer-image="" />;
  }, [view, url, isPdf]);

  if (!view) return null;
  return createPortal(
    <div className="fixed inset-0 z-[100] flex flex-col bg-black/95 text-white" role="dialog" aria-modal="true" aria-label={view.file.label} data-vault-viewer="">
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{view.file.label}</p>
          <p className="text-[11px] text-white/60">{VAULT_FILE_TYPE_LABELS[view.file.type]} · {formatVaultFileSize(view.file.size)}</p>
        </div>
        <span className="font-mono text-xs text-white/70" data-vault-viewer-countdown="">{formatCountdown(view.until - now)}</span>
        <button type="button" onClick={onClose} aria-label="Close" className="inline-flex size-11 items-center justify-center rounded-lg can-hover:hover:bg-white/10">
          <X className="size-5" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-2">{body}</div>
      <div className="flex flex-wrap items-center gap-2 border-t border-white/10 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <button
          type="button"
          onClick={() => saveBlob(view.blob, view.fileName)}
          className="inline-flex h-11 items-center gap-2 rounded-lg border border-white/20 px-4 text-sm can-hover:hover:bg-white/10"
        >
          <Download className="size-4" />Download
        </button>
        <p className="ml-auto text-[11px] text-white/60">Shown on this device only. No AI sees it; nothing is kept in the browser.</p>
      </div>
    </div>,
    document.body,
  );
}
