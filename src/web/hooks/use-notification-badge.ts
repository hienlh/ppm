import { useEffect } from "react";
import { useNotificationStore, selectTotalUnread } from "@/stores/notification-store";
import { setFavicon } from "@/lib/favicon";

const DEFAULT_TITLE = "PPM — Personal Project Manager";

/** Syncs document.title and favicon with unread notification count */
export function useNotificationBadge(): void {
  const totalUnread = useNotificationStore(selectTotalUnread);

  useEffect(() => {
    if (totalUnread > 0) {
      document.title = `(${totalUnread}) PPM`;
      setFavicon(true);
    } else {
      document.title = DEFAULT_TITLE;
      setFavicon(false);
    }
  }, [totalUnread]);
}
