import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { projectCacheId, type ProjectCacheRef } from "@/lib/browser-cache/cache-keys";
import { useSessionListStore } from "@/stores/session-list-store";

/** Once shown, stays up for at least this long — a sync that finishes almost
 * instantly must not blink the icon on and off. */
const MIN_VISIBLE_MS = 300;
/** How long the offline note stays up after a failed sync, before it goes
 * back to hidden on its own — never a blocking error. */
const ERROR_VISIBLE_MS = 4000;

interface SessionListSyncIndicatorProps {
  project: ProjectCacheRef;
  className?: string;
}

/**
 * Read-only "Syncing…" while the shared session store refreshes in the
 * background, so users know a cached list is being refreshed — never an
 * action, so it carries no tap target and sits outside the thumb zone
 * (design-guidelines §2, §9).
 */
export function SessionListSyncIndicator({ project, className }: SessionListSyncIndicatorProps) {
  const id = projectCacheId(project);
  const isSyncing = useSessionListStore((s) => s.byProject[id]?.isSyncing ?? false);
  const lastSyncError = useSessionListStore((s) => s.byProject[id]?.lastSyncError ?? null);

  const [visible, setVisible] = useState(false);
  const shownAt = useRef<number | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (isSyncing) {
      if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
      shownAt.current = Date.now();
      setVisible(true);
      return;
    }
    if (!visible) return;
    const elapsed = shownAt.current ? Date.now() - shownAt.current : MIN_VISIBLE_MS;
    const remaining = Math.max(0, MIN_VISIBLE_MS - elapsed);
    hideTimer.current = setTimeout(() => { setVisible(false); shownAt.current = null; }, remaining);
    return () => { if (hideTimer.current) clearTimeout(hideTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSyncing]);

  const [showError, setShowError] = useState(false);
  const lastShownError = useRef<string | null>(null);
  useEffect(() => {
    if (!lastSyncError) { lastShownError.current = null; return; }
    if (lastSyncError === lastShownError.current) return;
    lastShownError.current = lastSyncError;
    setShowError(true);
    const t = setTimeout(() => setShowError(false), ERROR_VISIBLE_MS);
    return () => clearTimeout(t);
  }, [lastSyncError]);

  if (!visible && !showError) return null;

  return (
    <span role="status" aria-live="polite" className={cn("inline-flex items-center gap-1 text-xs text-text-dim", className)}>
      {visible ? (
        <>
          <RefreshCw className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          Syncing…
        </>
      ) : (
        "Offline — showing saved list"
      )}
    </span>
  );
}
