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

/** In-flight `/api/fs/raw` thumbnail fetches allowed at once, across every tile on screen. */
const MAX_CONCURRENT = 24;
let active = 0;
const queue: (() => void)[] = [];

function acquire(): Promise<() => void> {
  return new Promise((resolve) => {
    const run = () => {
      active++;
      resolve(() => {
        active--;
        const next = queue.shift();
        if (next) next();
      });
    };
    if (active < MAX_CONCURRENT) run();
    else queue.push(run);
  });
}

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
    let cancelled = false;
    let release: (() => void) | null = null;

    const observer = new IntersectionObserver(
      (observed) => {
        if (!observed[0]?.isIntersecting) return;
        observer.disconnect();
        void (async () => {
          release = await acquire();
          if (cancelled) {
            release();
            return;
          }
          try {
            const token = getAuthToken();
            const res = await fetch(`/api/fs/raw?path=${encodeURIComponent(entry.path)}`, {
              headers: token ? { Authorization: `Bearer ${token}` } : {},
            });
            if (!res.ok) throw new Error(String(res.status));
            const blob = await res.blob();
            if (cancelled) return;
            const url = URL.createObjectURL(blob);
            urlRef.current = url;
            setSrc(url);
          } catch {
            if (!cancelled) setFailed(true);
          } finally {
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
      cancelled = true;
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
