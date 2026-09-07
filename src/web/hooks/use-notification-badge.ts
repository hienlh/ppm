import { useEffect, useRef } from "react";
import { useNotificationStore, selectProjectUnread } from "@/stores/notification-store";
import { useProjectStore } from "@/stores/project-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useStreamingStore, selectProjectStreaming } from "@/stores/streaming-store";
import { setFavicon, STREAM_FRAME_COUNT } from "@/lib/favicon";

function buildTitle(unread: number, projectName?: string, deviceName?: string): string {
  const parts = [projectName, deviceName || null, "PPM"].filter(Boolean).join(" - ");
  return unread > 0 ? `(${unread}) ${parts}` : parts;
}

/** Syncs document.title and favicon with unread notification count + streaming state.
 * When a chat in this window's project is streaming, favicon alternates between blue and
 * amber every 800ms. Uses direct Zustand subscription to update immediately even in
 * background tabs.
 *
 * Everything here is scoped to `activeProject`, because the title bar and the tab icon
 * describe *this* window and a window shows one project. Both inputs used to be app-wide:
 * `/ws/global` delivers phase and unread changes for every project, so opening three
 * workspaces in three PWA windows gave all three the same count and the same streaming
 * animation whenever any one of them was busy. */
export function useNotificationBadge(): void {
  const activeProject = useProjectStore((s) => s.activeProject);
  const deviceName = useSettingsStore((s) => s.deviceName);
  const projectName = activeProject?.name;
  const projectStreaming = useStreamingStore(selectProjectStreaming(projectName));
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const unreadHere = () => selectProjectUnread(projectName)(useNotificationStore.getState());
    const getHasBadge = () => unreadHere() > 0;

    const updateTitle = () => {
      document.title = buildTitle(unreadHere(), projectName, deviceName ?? undefined);
    };

    updateTitle();

    if (projectStreaming) {
      // Cycle through typing-dots frames (3 dots + 1 rest frame, Messenger style) every 300ms
      let frame = 0;
      setFavicon(getHasBadge(), frame);
      intervalRef.current = setInterval(() => {
        frame = (frame + 1) % STREAM_FRAME_COUNT;
        setFavicon(getHasBadge(), frame);
      }, 300);
    } else {
      setFavicon(getHasBadge());
    }

    // Keep title in sync with notification changes
    const unsub = useNotificationStore.subscribe(() => {
      updateTitle();
      // Static favicon update only when not streaming (interval handles streaming)
      if (!projectStreaming) setFavicon(getHasBadge());
    });

    return () => {
      unsub();
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [projectName, deviceName, projectStreaming]);
}
