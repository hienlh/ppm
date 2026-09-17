/**
 * Images and files inside a transcript, which cannot be `<img src>`.
 *
 * Every upload is behind PPM's auth, and an `<img>` sends no `Authorization`
 * header — so the bytes are fetched with one and handed to the element as a blob
 * URL. That is also why the cache below exists rather than being an optimisation:
 * the transcript rows unmount and remount constantly while scrolling.
 */
import { useCallback, useEffect, useState } from "react";
import { FileText, Image as ImageIcon } from "@/lib/icons";
import { getAuthToken } from "@/lib/api-client";
import { basename } from "@/lib/utils";
import { useImageOverlay } from "@/stores/image-overlay-store";
import { collectGallery, GALLERY_ITEM_ATTR } from "@/lib/image-gallery";

/** Image extensions that can be previewed inline */
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/** Build a preview URL for an uploaded file (served from /chat/uploads/:filename) */
export function uploadPreviewUrl(filePath: string, projectName?: string): string {
  const filename = basename(filePath);
  // Use a generic project name — the upload route is project-scoped but files are global
  return `/api/project/${encodeURIComponent(projectName ?? "_")}/chat/uploads/${encodeURIComponent(filename)}`;
}

/** Check if a file path is an image based on extension */
export function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return IMAGE_EXTS.has(path.slice(dot).toLowerCase());
}

function isPdfPath(path: string): boolean {
  return path.toLowerCase().endsWith(".pdf");
}
/**
 * Session-scoped image cache: blob URL + rendered box per src. Virtualized rows
 * unmount/remount constantly while scrolling; refetching the image and re-growing
 * from the placeholder on EVERY remount changed the row height after paint — the
 * repeatable downward jerk when scrolling up through image-bearing messages.
 * URLs are intentionally never revoked (bounded by unique images per session).
 */
const imageBlobCache = new Map<string, { url: string; w?: number; h?: number }>();

/** Hook: fetch an image via auth header, return blob URL (cached across mounts) */
function useAuthBlob(src: string): { blobUrl: string | null; error: boolean } {
  const [blobUrl, setBlobUrl] = useState<string | null>(() => imageBlobCache.get(src)?.url ?? null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const cached = imageBlobCache.get(src);
    if (cached) { setBlobUrl(cached.url); return; }
    let stale = false;
    const token = getAuthToken();
    fetch(src, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => { if (!r.ok) throw new Error("Failed"); return r.blob(); })
      .then((blob) => {
        if (stale) return;
        const url = URL.createObjectURL(blob);
        imageBlobCache.set(src, { url });
        setBlobUrl(url);
      })
      .catch(() => { if (!stale) setError(true); });
    return () => { stale = true; }; // cache owns the URL — no revoke
  }, [src]);

  return { blobUrl, error };
}

/** Fetches image with auth header, renders as blob URL — click opens lightbox */
function AuthImage({ src, alt }: { src: string; alt: string }) {
  const { blobUrl, error } = useAuthBlob(src);
  const openOverlay = useImageOverlay((s) => s.open);
  // Rendered box captured after the first load — pins the layout on remounts so
  // the row never grows after paint (see imageBlobCache).
  const cached = imageBlobCache.get(src);
  const box = cached?.w && cached?.h ? { width: cached.w, height: cached.h } : undefined;

  if (error) {
    return (
      <div className="flex items-center gap-1.5 rounded-md border border-border bg-background/50 px-2 py-1 text-xs text-text-secondary">
        <ImageIcon className="size-3.5 shrink-0" />
        <span className="truncate max-w-40">{alt}</span>
      </div>
    );
  }

  if (!blobUrl) {
    return <div className="rounded-md bg-surface border border-border h-24 w-32 animate-pulse" style={box} />;
  }

  return (
    <button
      type="button"
      onClick={(e) => openOverlay(blobUrl, alt, collectGallery(e.currentTarget))}
      className="block text-left"
    >
      <img
        src={blobUrl}
        alt={alt}
        style={box}
        {...{ [GALLERY_ITEM_ATTR]: "" }}
        onLoad={(e) => {
          const el = e.currentTarget;
          const c = imageBlobCache.get(src);
          if (c && (!c.w || !c.h)) { c.w = el.offsetWidth; c.h = el.offsetHeight; }
        }}
        className="rounded-md max-h-48 max-w-full object-contain border border-border cursor-pointer hover:opacity-90 transition-opacity"
      />
    </button>
  );
}

/** Chip for attached images in user bubble — tiny preview replaces icon, click opens lightbox */
export function AuthImageThumbnail({ filePath, projectName }: { filePath: string; projectName?: string }) {
  const src = uploadPreviewUrl(filePath, projectName);
  const { blobUrl, error } = useAuthBlob(src);
  const openOverlay = useImageOverlay((s) => s.open);
  const name = basename(filePath);

  return (
    <button
      type="button"
      onClick={(e) => blobUrl && openOverlay(blobUrl, name, collectGallery(e.currentTarget))}
      className="flex items-center gap-1 rounded-md border border-border/60 bg-background/40 px-1.5 py-0.5 text-[11px] text-text-secondary hover:bg-surface transition-colors cursor-pointer"
    >
      {blobUrl ? (
        <img src={blobUrl} alt={name} {...{ [GALLERY_ITEM_ATTR]: "" }} className="size-4 rounded-sm object-cover shrink-0" />
      ) : error ? (
        <ImageIcon className="size-3 shrink-0" />
      ) : (
        <div className="size-4 rounded-sm bg-surface animate-pulse shrink-0" />
      )}
      <span className="truncate max-w-32">{name}</span>
    </button>
  );
}

/** Fetches file with auth, opens in new browser tab (for PDFs, etc.) */
function AuthFileLink({ src, filename, mimeType }: { src: string; filename: string; mimeType: string }) {
  const [loading, setLoading] = useState(false);

  const handleClick = useCallback(async () => {
    setLoading(true);
    try {
      const token = getAuthToken();
      const res = await fetch(src, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!res.ok) throw new Error("Failed to load");
      const blob = await res.blob();
      const url = URL.createObjectURL(new Blob([blob], { type: mimeType }));
      window.open(url, "_blank");
      // Revoke after a delay to let the new tab load
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      // Fallback: try direct link
      window.open(src, "_blank");
    } finally {
      setLoading(false);
    }
  }, [src, mimeType]);

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={loading}
      className="flex items-center gap-1.5 rounded-md border border-border bg-background/50 px-2 py-1 text-xs text-text-secondary hover:bg-surface hover:text-text-primary transition-colors cursor-pointer disabled:opacity-50"
    >
      <FileText className="size-3.5 shrink-0 text-error" />
      <span className="truncate max-w-40">{filename}</span>
      {loading && <span className="animate-spin text-[10px]">...</span>}
    </button>
  );
}