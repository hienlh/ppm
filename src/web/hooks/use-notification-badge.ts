import { useEffect, useRef } from "react";
import { useNotificationStore, selectTotalUnread } from "@/stores/notification-store";
import { useProjectStore } from "@/stores/project-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useStreamingStore, selectAnyStreaming } from "@/stores/streaming-store";
import { setFavicon } from "@/lib/favicon";

function buildTitle(unread: number, projectName?: string, deviceName?: string): string {
  const parts = [projectName, deviceName || null, "PPM"].filter(Boolean).join(" - ");
  return unread > 0 ? `(${unread}) ${parts}` : parts;
}

/** Syncs document.title and favicon with unread notification count + streaming state.
 * When any chat is streaming, favicon alternates between blue and amber every 800ms.
 * Uses direct Zustand subscription to update immediately even in background tabs. */
export function useNotificationBadge(): void {
  const activeProject = useProjectStore((s) => s.activeProject);
  const deviceName = useSettingsStore((s) => s.deviceName);
  const anyStreaming = useStreamingStore(selectAnyStreaming);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const getHasBadge = () => selectTotalUnread(useNotificationStore.getState()) > 0;

    const updateTitle = () => {
      const unread = selectTotalUnread(useNotificationStore.getState());
      document.title = buildTitle(unread, activeProject?.name, deviceName ?? undefined);
    };

    updateTitle();

    if (anyStreaming) {
      // Alternate favicon between primary (blue) and streaming (amber) every 800ms
      let alt = false;
      setFavicon(getHasBadge(), false);
      intervalRef.current = setInterval(() => {
        alt = !alt;
        setFavicon(getHasBadge(), alt);
      }, 800);
    } else {
      setFavicon(getHasBadge());
    }

    // Keep title in sync with notification changes
    const unsub = useNotificationStore.subscribe(() => {
      updateTitle();
      // Static favicon update only when not streaming (interval handles streaming)
      if (!anyStreaming) setFavicon(getHasBadge());
    });

    return () => {
      unsub();
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [activeProject?.name, deviceName, anyStreaming]);
}
