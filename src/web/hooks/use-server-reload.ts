import { useEffect } from "react";
import { useConnectionStore } from "@/stores/connection-store";

const POLL_NORMAL_MS = 10_000;  // 10s when server is up
const POLL_DOWN_MS   = 2_000;   // 2s when server is down (waiting for it to come back)

/**
 * Polls /api/health in the background.
 * When the server goes down and comes back up (restart/stop+start),
 * clears all browser/SW caches and reloads the page so the user
 * always gets fresh assets.
 *
 * Also updates the connection store to drive the ConnectionLostOverlay.
 */
export function useServerReload() {
  useEffect(() => {
    let serverWasDown = false;
    let timer: ReturnType<typeof setTimeout>;
    const { markDown, markUp } = useConnectionStore.getState();

    async function check() {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        if (res.ok && serverWasDown) {
          // Server came back — clear caches then reload
          markUp();
          if ("caches" in window) {
            const keys = await caches.keys();
            await Promise.all(keys.map((k) => caches.delete(k)));
          }
          window.location.reload();
          return;
        }
        if (res.ok) {
          markUp();
        }
        serverWasDown = false;
      } catch {
        serverWasDown = true;
        markDown();
      }
      timer = setTimeout(check, serverWasDown ? POLL_DOWN_MS : POLL_NORMAL_MS);
    }

    timer = setTimeout(check, POLL_NORMAL_MS);
    return () => clearTimeout(timer);
  }, []);
}
