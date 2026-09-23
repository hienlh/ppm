import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Palette } from "@/lib/icons";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { usePanelStore } from "@/stores/panel-store";
import { useStreamingStore } from "@/stores/streaming-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useDesignSessionState } from "@/hooks/use-design-session-state";
import { DESIGN_SHOW_CHAT_EVENT, type DesignShowChatDetail } from "@/lib/design/deliver-to-design-chat";
import { DESIGNS_CHANGED_EVENT } from "@/lib/design/design-ui-events";
import { DesignTabContext, type DesignTabContextValue } from "./design-tab-context";
import { DesignChatPane } from "./design-chat-pane";
import { DesignCanvasPane } from "./canvas/design-canvas-pane";
import { DesignSplitLayout } from "./design-split-layout";
import { DesignMobileLayout, type DesignMobilePane } from "./design-mobile-layout";
import { useDesignSummary } from "./use-design-summary";

/**
 * A design tab: the design's chat beside its live canvas.
 *
 * Loaded lazily by the tab pool, so none of this reaches the entry bundle. Everything the
 * two halves share goes through {@link DesignTabContext}.
 */
export function DesignTab({ metadata, tabId }: { metadata?: Record<string, unknown>; tabId?: string }) {
  const projectName = typeof metadata?.projectName === "string" ? metadata.projectName : "";
  const slug = typeof metadata?.designSlug === "string" ? metadata.designSlug : "";
  const { state, refresh } = useDesignSummary(projectName, slug);

  if (!tabId || !metadata) return null;
  if (state.status === "loading") {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-text-subtle" role="status">
        <Loader2 className="size-4 animate-spin" /> Opening design…
      </div>
    );
  }
  if (state.status !== "ready") {
    return <DesignEmptyState slug={slug} message={state.status === "error" ? state.message : undefined} onRetry={refresh} />;
  }
  return <DesignTabBody tabId={tabId} metadata={metadata} design={state.design} refreshDesign={refresh} />;
}

function DesignTabBody({ tabId, metadata, design, refreshDesign }: {
  tabId: string;
  metadata: Record<string, unknown>;
  design: DesignTabContextValue["design"];
  refreshDesign: () => void;
}) {
  const isMobile = useIsMobile();
  const session = useDesignSessionState(tabId, metadata);
  const [pane, setPane] = useState<DesignMobilePane>("canvas");
  const isActive = usePanelStore((s) => Object.values(s.panels).some((p) => p.activeTabId === tabId));
  const isStreaming = useStreamingStore((s) => (session.sessionId ? s.sessions.has(session.sessionId) : false));
  const projectName = String(metadata.projectName);

  // The tab is named after the design; a rename or a tab opened from history catches up here.
  useEffect(() => {
    const tab = usePanelStore.getState().getPanelForTab(tabId)?.tabs.find((t) => t.id === tabId);
    if (tab && tab.title !== design.title) usePanelStore.getState().updateTab(tabId, { title: design.title });
  }, [tabId, design.title]);

  const showChat = useCallback(() => setPane("chat"), []);
  useEffect(() => {
    const onShow = (e: Event) => {
      if ((e as CustomEvent<DesignShowChatDetail>).detail?.tabId === tabId) setPane("chat");
    };
    // A rename from the sidebar changes the manifest; the watcher only reports it while this
    // project is the active one, so the announcement is the reliable signal.
    const onDesignsChanged = (e: Event) => {
      if ((e as CustomEvent<{ projectName?: string }>).detail?.projectName === projectName) refreshDesign();
    };
    window.addEventListener(DESIGN_SHOW_CHAT_EVENT, onShow);
    window.addEventListener(DESIGNS_CHANGED_EVENT, onDesignsChanged);
    return () => {
      window.removeEventListener(DESIGN_SHOW_CHAT_EVENT, onShow);
      window.removeEventListener(DESIGNS_CHANGED_EVENT, onDesignsChanged);
    };
  }, [tabId, projectName, refreshDesign]);

  const ctx = useMemo<DesignTabContextValue>(() => ({
    projectName, slug: design.slug, tabId, design, sessionId: session.sessionId,
    isStreaming, isActive, isMobile, showChat, refreshDesign,
  }), [projectName, design, tabId, session.sessionId, isStreaming, isActive, isMobile, showChat, refreshDesign]);

  const chat = <DesignChatPane tabId={tabId} metadata={metadata} session={session} />;
  return (
    <DesignTabContext.Provider value={ctx}>
      {isMobile ? (
        <DesignMobileLayout
          pane={pane}
          onPaneChange={setPane}
          chat={chat}
          canvas={(more) => <DesignCanvasPane moreOpen={more.open} onMoreClose={more.onClose} />}
        />
      ) : (
        <DesignSplitLayout chat={chat} canvas={<DesignCanvasPane />} />
      )}
    </DesignTabContext.Provider>
  );
}

function DesignEmptyState({ slug, message, onRetry }: { slug: string; message?: string; onRetry: () => void }) {
  const openDesigns = () => {
    const settings = useSettingsStore.getState();
    settings.setSidebarActiveTab("designs");
    if (settings.sidebarCollapsed) settings.toggleSidebar();
  };
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center" role="status">
      <Palette className="size-8 text-text-subtle" />
      <p className="text-sm font-medium">{message ? "Could not open this design" : "This design no longer exists"}</p>
      <p className="max-w-sm text-xs text-text-subtle">
        {message ?? `There is no design folder named “${slug}” in this project. It may have been deleted or renamed on disk.`}
      </p>
      <div className="flex gap-2">
        {message && <button type="button" onClick={onRetry} className="min-h-11 px-3 text-sm text-primary underline">Retry</button>}
        <button type="button" onClick={openDesigns} className="min-h-11 px-3 text-sm text-primary underline">Show designs</button>
      </div>
    </div>
  );
}
