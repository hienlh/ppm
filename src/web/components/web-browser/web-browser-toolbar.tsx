/**
 * Back / Forward / Reload, the address field, the "on host" chip, downloads and the menu.
 * Desktop puts it above the page; a phone puts it below, in the thumb zone (`placement`).
 */
import { WB_ICON_BUTTON, WB_TEXT_BUTTON } from "./web-browser-button-styles";
import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Download, Keyboard, Lock, Monitor, MoreHorizontal, RotateCw, X } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { WebBrowserTabInfo } from "../../../shared/web-browser-protocol";

const btn = WB_ICON_BUTTON;

export interface ToolbarProps {
  tab: WebBrowserTabInfo | undefined;
  latencyMs: number | null;
  downloads: number;
  phone: boolean;
  tabCount: number;
  onNavigate(url: string): void;
  onBack(): void;
  onForward(): void;
  onReload(): void;
  onStop(): void;
  onShowInfo(): void;
  onShowDownloads(): void;
  onShowMenu(): void;
  onShowTabs?(): void;
  onKeyboard?(): void;
}

export function WebBrowserToolbar(p: ToolbarProps) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(p.tab?.url ?? "");
  useEffect(() => { if (!editing) setText(p.tab?.url === "about:blank" ? "" : p.tab?.url ?? ""); }, [p.tab?.url, editing]);
  const secure = p.tab?.url.startsWith("https://");
  const chip = (
    <button type="button" onClick={p.onShowInfo} title="Runs on the host machine — click for details"
      className={`${WB_TEXT_BUTTON} border border-border text-text-2 hover:bg-panel-2`}>
      <span className="size-1.5 rounded-full bg-success" />
      <Monitor className="size-3.5" />
      {!p.phone && <span>On host</span>}
      <span className="font-mono">{p.latencyMs !== null ? `${p.latencyMs} ms` : "—"}</span>
    </button>
  );
  const address = (
    <form className="flex-1 min-w-0" onSubmit={(e) => { e.preventDefault(); setEditing(false); p.onNavigate(text); }}>
      <label className="flex items-center gap-1.5 h-7 rounded-full bg-panel-2 border border-border px-2.5 focus-within:ring-1 focus-within:ring-ring">
        {secure && <Lock className="size-3.5 text-text-3 shrink-0" />}
        <input value={text} onChange={(e) => setText(e.target.value)} onFocus={(e) => { setEditing(true); e.currentTarget.select(); }}
          onBlur={() => setEditing(false)} placeholder="Search or type an address" aria-label="Address"
          inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false}
          className="flex-1 min-w-0 bg-transparent text-[13px] md:text-xs outline-none text-text" />
      </label>
    </form>
  );
  const nav = (
    <>
      <button type="button" className={btn} onClick={p.onBack} disabled={!p.tab?.canBack} aria-label="Back" title="Back"><ArrowLeft className="size-4" /></button>
      <button type="button" className={btn} onClick={p.onForward} disabled={!p.tab?.canForward} aria-label="Forward" title="Forward"><ArrowRight className="size-4" /></button>
      {p.tab?.loading
        ? <button type="button" className={btn} onClick={p.onStop} aria-label="Stop loading" title="Stop loading"><X className="size-4" /></button>
        : <button type="button" className={btn} onClick={p.onReload} aria-label="Reload" title="Reload"><RotateCw className="size-4" /></button>}
    </>
  );
  const downloadsBtn = (
    <button type="button" className={cn(btn, "relative")} onClick={p.onShowDownloads} aria-label="Downloads" title="Downloads">
      <Download className="size-4" />
      {p.downloads > 0 && <span className="absolute -top-1 -right-1 min-w-3.5 h-3.5 px-0.5 rounded-full bg-primary text-[9px] leading-[14px] text-white">{p.downloads}</span>}
    </button>
  );
  const menuBtn = <button type="button" className={btn} onClick={p.onShowMenu} aria-label="More" title="More"><MoreHorizontal className="size-4" /></button>;

  if (p.phone) {
    return (
      <div role="toolbar" aria-label="Browser" className="shrink-0 border-t border-border bg-panel px-2 pt-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))]">
        <div className="flex items-center gap-2">
          {chip}
          {address}
          <button type="button" onClick={p.onShowTabs} aria-label="Tabs" className={btn}>
            <span className="flex items-center justify-center size-4 rounded-[4px] border-[1.5px] border-current text-[10px] font-semibold leading-none">{p.tabCount}</span>
          </button>
        </div>
        <div className="flex items-center justify-around mt-1.5">
          {nav}
          <button type="button" className={btn} onClick={p.onKeyboard} aria-label="Keyboard" title="Keyboard"><Keyboard className="size-4" /></button>
          {downloadsBtn}
          {menuBtn}
        </div>
      </div>
    );
  }
  return (
    <div role="toolbar" aria-label="Browser" className="flex items-center gap-1 shrink-0 h-9 px-2 border-b border-border bg-panel">
      {nav}
      {address}
      {chip}
      {downloadsBtn}
      {menuBtn}
    </div>
  );
}
