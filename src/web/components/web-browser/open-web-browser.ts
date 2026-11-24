/**
 * Opens PPM's browser: a floating window on desktop, a full-screen tab below `md` (where the
 * window layer does not render). There is one browser on the host, so a second call focuses
 * what is already open instead of opening another view of it.
 */
import { useWindowStore } from "@/components/floating-window/window-store";
import { isMobileDevice } from "@/hooks/use-is-mobile";
import { useTabStore } from "@/stores/tab-store";
import { openSettings } from "@/components/settings/open-settings";

export function openWebBrowser(): void {
  if (isMobileDevice()) {
    useTabStore.getState().openTab({ type: "web-browser", title: "Browser", projectId: null, closable: true, metadata: {} });
    return;
  }
  const store = useWindowStore.getState();
  const existing = Object.values(store.windows).find((w) => w.kind === "web-browser");
  if (existing) store.focus(existing.id);
  else store.open("web-browser");
}

export function openWebBrowserSettings(): void {
  openSettings("web-browser");
}
