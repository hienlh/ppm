/**
 * Whether to offer "Browser" in the rail and the phone drawer: the host allows it, has a Chrome
 * or Edge, and the user turned it on. Asked once per page load and again whenever Settings or
 * the tour changes the answer (`refreshWebBrowserAvailable`).
 */
import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";

interface Caps {
  available: boolean;
  enabled: boolean | null;
}

let cached: Promise<Caps> | null = null;
const listeners = new Set<() => void>();

function load(): Promise<Caps> {
  cached ??= api.get<Caps>("/api/web-browser/capabilities").catch(() => ({ available: false, enabled: null }));
  return cached;
}

export function refreshWebBrowserAvailable(): void {
  cached = null;
  for (const l of listeners) l();
}

// Answering the tour's question on any device re-asks here (re-dispatched by use-global-events).
if (typeof window !== "undefined") window.addEventListener("feature-intros:changed", refreshWebBrowserAvailable);

export function useWebBrowserAvailable(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    const check = () => void load().then((c) => { if (live) setOn(c.available && c.enabled === true); });
    check();
    listeners.add(check);
    return () => { live = false; listeners.delete(check); };
  }, []);
  return on;
}
