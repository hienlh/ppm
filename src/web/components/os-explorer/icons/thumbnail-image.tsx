/**
 * Lazy, viewport-gated thumbnail for image files.
 *
 * A bare `<img src="/api/fs/raw?...">` cannot carry the Authorization header the API
 * requires, so the bytes are fetched manually and turned into an object URL — the same
 * trick `useBlobUrl` uses — but gated by an `IntersectionObserver` (nothing fetches until
 * the tile scrolls near the viewport) and a module-wide concurrency cap, so opening a
 * folder of a thousand photos does not fire a thousand requests at once.
 */

import { useEffect, useRef, useState } from "react";
import { getAuthToken } from "@/lib/api-client";
import type { FsEntry } from "@/lib/fs-api";
import { cn } from "@/lib/utils";
import { FileTypeIcon } from "./file-type-icon";
import { acquireSlot } from "./thumbnail-fetch-semaphore";

export interface ThumbnailImageProps {
  entry: Pick<FsEntry, "name" | "path" | "kind">;
  /** Square box the thumbnail (or its icon fallback) renders into, in px. */
  size: number;
  className?: string;
}

export function ThumbnailImage({ entry, size, className }: ThumbnailImageProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const urlRef = useRef<string | null>(null);

  // A different entry (row recycled by the virtualizer, or the user navigated) starts over.
  useEffect(() => {
    setSrc(null);
    setFailed(false);
  }, [entry.path]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || src || failed) return;
    // A scrolled-past tile must stop downloading (the server has no thumbnail endpoint —
    // `/api/fs/raw` streams the whole original file) and give its semaphore slot back
    // immediately rather than waiting for a fetch nobody will render.
    const controller = new AbortController();
    let release: (() => void) | null = null;

    const observer = new IntersectionObserver(
      (observed) => {
        if (!observed[0]?.isIntersecting) return;
        observer.disconnect();
        void (async () => {
          release = await acquireSlot();
          if (controller.signal.aborted) {
            release();
            return;
          }
          try {
            const token = getAuthToken();
            const res = await fetch(`/api/fs/raw?path=${encodeURIComponent(entry.path)}`, {
              headers: token ? { Authorization: `Bearer ${token}` } : {},
              signal: controller.signal,
            });
            if (!res.ok) throw new Error(String(res.status));
            const blob = await res.blob();
            if (controller.signal.aborted) return;
            const url = URL.createObjectURL(blob);
            urlRef.current = url;
            setSrc(url);
          } catch {
            if (!controller.signal.aborted) setFailed(true);
          } finally {
            // Idempotent: harmless if this fires again from the cleanup below for the same
            // completed acquisition.
            release?.();
          }
        })();
      },
      // Start the fetch a little before the tile is actually visible so it is usually
      // ready by the time it scrolls fully into view.
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => {
      controller.abort();
      observer.disconnect();
      release?.();
    };
  }, [entry.path, src, failed]);

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  if (failed || !src) {
    return (
      <div
        ref={rootRef}
        className={cn("flex items-center justify-center", className)}
        style={{ width: size, height: size }}
      >
        <FileTypeIcon name={entry.name} kind={entry.kind} className="size-1/2" />
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className={cn("flex items-center justify-center overflow-hidden", className)}
      style={{ width: size, height: size }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- plain img, not next/image */}
      <img
        src={src}
        alt=""
        loading="lazy"
        className="max-h-full max-w-full rounded object-contain"
        onError={() => setFailed(true)}
      />
    </div>
  );
}
