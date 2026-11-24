/** "RAM 1.0 GB · 2 tabs · stops after 10 min unused" and a Stop button. */
import { Power } from "@/lib/icons";
import type { WebBrowserViewState } from "./use-web-browser-connection";

export function statusLine(s: Pick<WebBrowserViewState, "ramMB" | "tabs" | "idleStopAt">, now = Date.now()): string {
  const parts: string[] = [];
  if (s.ramMB !== null) parts.push(s.ramMB >= 1024 ? `RAM ${(s.ramMB / 1024).toFixed(1)} GB` : `RAM ${s.ramMB} MB`);
  parts.push(`${s.tabs.length} ${s.tabs.length === 1 ? "tab" : "tabs"}`);
  if (s.idleStopAt) {
    const min = Math.max(1, Math.round((s.idleStopAt - now) / 60_000));
    parts.push(`stops after ${min} min unused`);
  }
  return parts.join(" · ");
}

export function WebBrowserStatusBar({ s, onStop }: { s: WebBrowserViewState; onStop(): void }) {
  if (s.browser !== "running") return null;
  return (
    <div className="flex items-center gap-2 shrink-0 h-8 md:h-7 px-3 border-t border-border bg-panel text-xs text-text-3 font-mono">
      <span className="flex-1 truncate">{statusLine(s)}</span>
      <button type="button" onClick={onStop} className="flex items-center gap-1 min-h-11 md:min-h-6 px-2 rounded text-destructive hover:bg-panel-2 font-sans">
        <Power className="size-3.5" />Stop
      </button>
    </div>
  );
}
