/** The browser's own tabs (not PPM's tabs). Desktop: a strip; phone: the list in a sheet. */
import { Bot, Globe, Plus, X } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { WebBrowserTabInfo } from "../../../shared/web-browser-protocol";

export function tabLabel(t: WebBrowserTabInfo): string {
  if (t.title && t.title !== "about:blank") return t.title;
  if (t.url === "about:blank" || !t.url) return "New tab";
  try { return new URL(t.url).host; } catch { return t.url; }
}

export function WebBrowserTabStrip(p: {
  tabs: WebBrowserTabInfo[];
  activeTabId: string | null;
  maxTabs: number;
  vertical?: boolean;
  onActivate(id: string): void;
  onClose(id: string): void;
  onNew(): void;
}) {
  const full = p.tabs.length >= p.maxTabs;
  return (
    <div role="tablist" aria-label="Browser tabs"
      className={cn(p.vertical ? "flex flex-col gap-1" : "flex items-center gap-1 shrink-0 h-9 px-2 pt-1 bg-rail border-b border-border overflow-x-auto")}>
      {p.tabs.map((t) => (
        <div key={t.id} role="tab" aria-selected={t.id === p.activeTabId}
          className={cn("group flex items-center gap-1.5 min-w-0 rounded-md px-2 text-xs cursor-pointer select-none",
            p.vertical ? "min-h-12 text-sm" : "h-7 max-w-52",
            t.id === p.activeTabId ? "bg-panel text-text border border-border" : "text-text-2 hover:bg-panel-2")}
          onClick={() => p.onActivate(t.id)}>
          {t.ai ? <Bot className="size-3.5 shrink-0 text-accent-2" /> : <Globe className="size-3.5 shrink-0 text-text-3" />}
          <span className="truncate flex-1">{tabLabel(t)}</span>
          <button type="button" aria-label={`Close ${tabLabel(t)}`} onClick={(e) => { e.stopPropagation(); p.onClose(t.id); }}
            className={cn("flex items-center justify-center rounded hover:bg-panel-2", p.vertical ? "min-h-11 min-w-11" : "size-5 opacity-60 group-hover:opacity-100")}>
            <X className="size-3" />
          </button>
        </div>
      ))}
      <button type="button" onClick={p.onNew} disabled={full} aria-label="New tab"
        title={full ? `At most ${p.maxTabs} tabs (Settings → Web browser)` : "New tab"}
        className={cn("flex items-center justify-center rounded-md text-text-2 hover:bg-panel-2 disabled:opacity-40",
          p.vertical ? "min-h-12 gap-2 text-sm" : "size-7 shrink-0")}>
        <Plus className="size-4" />{p.vertical && "New tab"}
      </button>
    </div>
  );
}
