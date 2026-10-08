import { usePanelStore } from "@/stores/panel-store";
import { windowIdFromPanelId } from "@/stores/panel-utils";
import { useSettingsStore } from "@/stores/settings-store";
import { useWindowStore } from "@/components/floating-window/window-store";
import { cascadeSpawnRect } from "@/components/floating-window/window-geometry";
import { currentTabMetadata, patchTabMetadata } from "@/lib/patch-tab-metadata";
import { designTabMetadata } from "./design-tab-metadata";

export interface OpenDesignTabInput {
  projectName: string;
  slug: string;
  title?: string;
  /** Open the design on this session (history, a notification) instead of its current one. */
  sessionId?: string;
  providerId?: string;
  /** The panel to open in when the design is not open yet. */
  panelId?: string;
  /** Just created: skip looking up its latest session, it has none. */
  fresh?: boolean;
  /**
   * Stay in `panelId` as a tab even where designs open in windows: the design is taking the
   * place of a tab there (a chat that turned out to be a design session), and moving it out
   * would leave that panel empty.
   */
  inPlace?: boolean;
}

/**
 * Open (or focus) a design's tab. There is one tab per design; opening it again focuses
 * the existing tab, and asking for a particular session switches that tab to it.
 *
 * On a desktop with Settings → Design → "Open designs in a window" on, a design that was
 * not open yet goes straight into a floating window of its own (see {@link showInWindow}).
 */
export function openDesignTab(input: OpenDesignTabInput): string {
  const { projectName, slug, title, sessionId, providerId, panelId, fresh, inPlace } = input;
  const wasOpen = isDesignOpen(projectName, slug);
  const id = usePanelStore.getState().openTab({
    type: "design",
    title: title || slug,
    projectId: projectName,
    closable: true,
    metadata: designTabMetadata({ projectName, designSlug: slug, sessionId, providerId, fresh }),
  }, panelId);
  if (id) showInWindow(id, wasOpen || Boolean(inPlace));
  if (!id || !sessionId) return id;

  // The tab already existed, so the panel store focused it and ignored the metadata above.
  // Bumping the epoch remounts its chat on the requested session.
  const current = currentTabMetadata(id);
  if (current && current.sessionId !== sessionId) {
    patchTabMetadata(id, {
      sessionId,
      ...(providerId ? { providerId, providerPending: undefined } : {}),
      pendingMessage: undefined,
      designChatEpoch: nextChatEpoch(current),
    });
  }
  return id;
}

/** Same match as the panel store's one-tab-per-design rule: slug and project, any panel. */
function isDesignOpen(projectName: string, slug: string): boolean {
  return Object.values(usePanelStore.getState().panels).some((p) => p.tabs.some((t) =>
    t.type === "design" && t.metadata?.designSlug === slug && (t.projectId ?? t.metadata?.projectName) === projectName));
}

/**
 * Put a design on screen in its window.
 *
 * Already in a window: that window comes forward, out of the dock if it was minimized. Just
 * opened: it moves from the tab strip into a new window, which is its home — closing the
 * window closes the design. Open in the grid already (the user docked it there, or the
 * setting was off when it opened): it stays where the user put it.
 *
 * A phone has no windows, and `popOutTab` refuses there; at the window cap it refuses too,
 * and the design simply stays a tab.
 */
function showInWindow(tabId: string, wasOpen: boolean): void {
  const panelId = usePanelStore.getState().getPanelForTab(tabId)?.id;
  if (!panelId) return;
  const windowId = windowIdFromPanelId(panelId);
  if (windowId) {
    useWindowStore.getState().focus(windowId);
    return;
  }
  if (wasOpen || !useSettingsStore.getState().designWindows) return;
  const windows = useWindowStore.getState();
  const rect = cascadeSpawnRect(
    Object.values(windows.windows).map((w) => w.rect),
    windows.bounds,
    { w: Math.round(windows.bounds.w * DESIGN_WINDOW_SHARE.w), h: Math.round(windows.bounds.h * DESIGN_WINDOW_SHARE.h) },
  );
  usePanelStore.getState().popOutTab(tabId, panelId, { closeTabsOnClose: true, rect });
}

/** A design window's first size, as a share of the work area: a canvas wants room. */
const DESIGN_WINDOW_SHARE = { w: 0.72, h: 0.84 };

/** The epoch after the one `metadata` carries; the design tab keys its chat on it. */
export function nextChatEpoch(metadata: Record<string, unknown> | undefined): number {
  const epoch = metadata?.designChatEpoch;
  return (typeof epoch === "number" && Number.isFinite(epoch) ? epoch : 0) + 1;
}

export interface SessionToOpen {
  id: string;
  providerId?: string;
  title?: string;
  designSlug?: string | null;
}

/**
 * Open a session from a history list in the tab it belongs to: a design session in its
 * design tab, anything else as a chat tab. The panel store also focuses an already-open
 * design tab for a session opened as a chat, but only this can open one that is closed.
 */
export function openSessionInItsTab(session: SessionToOpen, projectName: string, panelId?: string): string {
  if (session.designSlug) {
    return openDesignTab({
      projectName, slug: session.designSlug, sessionId: session.id, providerId: session.providerId, panelId,
    });
  }
  return usePanelStore.getState().openTab({
    type: "chat",
    title: session.title || "Chat",
    projectId: projectName,
    metadata: { projectName, sessionId: session.id, ...(session.providerId ? { providerId: session.providerId } : {}) },
    closable: true,
  }, panelId);
}
