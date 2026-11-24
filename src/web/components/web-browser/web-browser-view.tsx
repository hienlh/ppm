/**
 * PPM's browser, one body for both the desktop window and the phone tab (`phone`).
 * Desktop: tabs and toolbar above the page. Phone: the page full-height, the toolbar below it.
 */
import { WB_TEXT_BUTTON } from "./web-browser-button-styles";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { useWebBrowserConnection } from "./use-web-browser-connection";
import { useWebBrowserInput } from "./use-web-browser-input";
import { useVisibleWhileShown } from "./use-visible-while-shown";
import { WebBrowserToolbar } from "./web-browser-toolbar";
import { WebBrowserTabStrip } from "./web-browser-tab-strip";
import { WebBrowserAiBanner, WebBrowserPageDialog, WebBrowserStateScreen } from "./web-browser-overlays";
import { DownloadsPanel, FileChooserPanel, InfoPanel, MenuPanel, PanelFrame, type PanelKind } from "./web-browser-panels";
import { WebBrowserStatusBar } from "./web-browser-status-bar";
import { openWebBrowserSettings } from "./open-web-browser";

export function WebBrowserView({ phone }: { phone: boolean }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const visible = useVisibleWhileShown(rootRef);
  const [muted, setMuted] = useState(false);
  const [panel, setPanel] = useState<PanelKind>(null);
  const { state: s, patch, send, connect, surfaceRef, attachCanvas, unlockAudio, latency } = useWebBrowserConnection({ mobile: phone, visible, muted });
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const active = s.tabs.find((t) => t.id === s.activeTabId);
  const running = s.conn === "open" && s.browser === "running" && s.isController;
  const [lat, setLat] = useState<number | null>(null);
  useEffect(() => { const t = setInterval(() => setLat(latency()), 1000); return () => clearInterval(t); }, [latency]);

  useWebBrowserInput(surfaceRef, fieldRef, {
    enabled: running,
    send,
    onCopy: () => send({ type: "clipboard.copyRequest" }),
    onPasteText: (text) => send({ type: "clipboard.paste", text }),
  });

  const start = useCallback(async () => {
    patch({ error: null });
    try { await api.post("/api/web-browser/start"); connect(); } catch (e) {
      const err = e as Error & { code?: string };
      patch({ error: { code: err.code ?? "start-failed", message: err.message } });
    }
  }, [connect, patch]);

  const clearData = async () => {
    if (!window.confirm("Clear the browser's logins, history and downloads on the host?")) return;
    await api.post("/api/web-browser/clear-data");
    toast.success("Browsing data cleared");
    setPanel(null);
  };
  const closeBrowser = async () => { await api.post("/api/web-browser/stop"); setPanel(null); };

  const toolbar = (
    <WebBrowserToolbar tab={active} latencyMs={lat} downloads={s.downloads.filter((d) => d.state === "done").length} phone={phone} tabCount={s.tabs.length}
      onNavigate={(url) => send({ type: "navigate", url })} onBack={() => send({ type: "back" })} onForward={() => send({ type: "forward" })}
      onReload={() => send({ type: "reload" })} onStop={() => send({ type: "stop" })}
      onShowInfo={() => setPanel("info")} onShowDownloads={() => setPanel("downloads")} onShowMenu={() => setPanel("menu")}
      onShowTabs={() => setPanel("tabs")} onKeyboard={() => { unlockAudio(); fieldRef.current?.focus(); }} />
  );

  return (
    <div ref={rootRef} className="relative flex h-full w-full flex-col bg-background">
      {!phone && <WebBrowserTabStrip tabs={s.tabs} activeTabId={s.activeTabId} maxTabs={s.maxTabs}
        onActivate={(id) => send({ type: "tab.activate", tabId: id })} onClose={(id) => send({ type: "tab.close", tabId: id })} onNew={() => send({ type: "tab.open" })} />}
      {!phone && toolbar}
      {s.ai && <WebBrowserAiBanner ai={s.ai} onTakeBack={() => send({ type: "ai.release" })} onGiveBack={() => send({ type: "ai.return" })} />}
      {s.blocked && (
        <div role="status" className="flex items-center gap-2 shrink-0 px-3 py-1 text-xs bg-warning/15 text-text border-b border-border">
          <span className="flex-1 truncate">Blocked: {s.blocked.url} ({s.blocked.reason.replace("-", " ")})</span>
          <button type="button" className={`${WB_TEXT_BUTTON} hover:bg-panel-2`} onClick={() => patch({ blocked: null })}>Dismiss</button>
        </div>
      )}
      <div ref={surfaceRef} className="relative flex-1 min-h-0 overflow-hidden bg-white touch-none select-none" onPointerDown={unlockAudio}>
        <canvas ref={attachCanvas} className="absolute inset-0 h-full w-full" aria-label={active ? `Page: ${active.title || active.url}` : "Page"} />
        <textarea ref={fieldRef} aria-label="Type into the page" autoCapitalize="off" autoCorrect="off" spellCheck={false}
          className="absolute left-0 bottom-0 h-px w-px opacity-0 resize-none" />
        <WebBrowserStateScreen s={s} onReconnect={connect} onStart={() => void start()} onTakeover={() => send({ type: "takeover" })} onOpenSettings={openWebBrowserSettings} />
        {s.dialog && running && <WebBrowserPageDialog dialog={s.dialog} onAnswer={(accept, text) => { send({ type: "dialog.answer", id: s.dialog!.id, accept, ...(text !== undefined ? { text } : {}) }); patch({ dialog: null }); }} />}
      </div>
      {!phone && <WebBrowserStatusBar s={s} onStop={() => void closeBrowser()} />}
      {phone && toolbar}
      {panel === "info" && <PanelFrame phone={phone} onClose={() => setPanel(null)} title="Browser on the host"><InfoPanel s={s} latencyMs={lat} /></PanelFrame>}
      {panel === "downloads" && <PanelFrame phone={phone} onClose={() => setPanel(null)} title="Downloads"><DownloadsPanel s={s} /></PanelFrame>}
      {panel === "menu" && (
        <PanelFrame phone={phone} onClose={() => setPanel(null)}>
          <MenuPanel s={s} url={active?.url} muted={muted} onToggleMute={() => setMuted((m) => !m)} onClear={() => void clearData()} onCloseBrowser={() => void closeBrowser()} />
          {phone && <WebBrowserStatusBar s={s} onStop={() => void closeBrowser()} />}
        </PanelFrame>
      )}
      {panel === "tabs" && (
        <PanelFrame phone={phone} onClose={() => setPanel(null)} title="Tabs">
          <WebBrowserTabStrip vertical tabs={s.tabs} activeTabId={s.activeTabId} maxTabs={s.maxTabs}
            onActivate={(id) => { send({ type: "tab.activate", tabId: id }); setPanel(null); }} onClose={(id) => send({ type: "tab.close", tabId: id })}
            onNew={() => { send({ type: "tab.open" }); setPanel(null); }} />
        </PanelFrame>
      )}
      {s.chooser && (
        <PanelFrame phone={phone} onClose={() => { send({ type: "file.cancel", chooserId: s.chooser!.chooserId }); patch({ chooser: null }); }} title="Upload">
          <FileChooserPanel chooser={s.chooser}
            onChosen={(ids) => { send({ type: "file.choose", chooserId: s.chooser!.chooserId, uploadIds: ids }); patch({ chooser: null }); }}
            onCancel={() => { send({ type: "file.cancel", chooserId: s.chooser!.chooserId }); patch({ chooser: null }); }} />
        </PanelFrame>
      )}
    </div>
  );
}
