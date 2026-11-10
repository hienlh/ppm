/**
 * Opening the PPM Assistant on whichever presentation the device has.
 *
 * The Assistant is one tab (`type: "assistant"`), never a window kind of its own: on a
 * desktop it is moved into a `tab-host` floating window the first time it opens, and below
 * `md` — where the window layer does not render — it simply stays a tab. Being a tab is
 * what lets everything that asks "which tab shows this session?" (`tabSessionId`) find it.
 *
 * The tab belongs to no project (`projectId: null`), so the panel store brings it onto the
 * grid that is on screen rather than focusing it inside another project's hidden grid. Its
 * chat runs in the virtual `__assistant__` project, which only the metadata names.
 *
 * A plain function (the shape `openSettings` uses) so the command palette, a keybinding and
 * a notification can all reach it.
 */
import { usePanelStore } from "@/stores/panel-store";
import { windowIdFromPanelId } from "@/stores/panel-utils";
import { frontWindowId, useWindowStore } from "@/components/floating-window/window-store";
import { clampRect, type Bounds, type Rect } from "@/components/floating-window/window-geometry";
import { currentTabMetadata, patchTabMetadata } from "@/lib/patch-tab-metadata";
import { ASSISTANT_PROJECT_NAME } from "../../../shared/assistant-project";

/** The Assistant's one tab id (`deriveTabId("assistant")`). */
export const ASSISTANT_TAB_ID = "assistant";
export const ASSISTANT_TAB_TITLE = "PPM Assistant";
/** What its window's titlebar says; the dock chip keeps the tab's title. */
export const ASSISTANT_WINDOW_TITLE = "Assistant";

export interface OpenAssistantInput {
  /** Show this session (a notification, a history entry) instead of the one already open. */
  sessionId?: string;
  providerId?: string;
}

export function openAssistant(input: OpenAssistantInput = {}): string {
  const { sessionId, providerId } = input;
  const wasOpen = Boolean(usePanelStore.getState().getPanelForTab(ASSISTANT_TAB_ID));
  const id = usePanelStore.getState().openTab({
    type: "assistant",
    title: ASSISTANT_TAB_TITLE,
    projectId: null,
    closable: true,
    metadata: {
      projectName: ASSISTANT_PROJECT_NAME,
      ...(sessionId && { sessionId }),
      ...(providerId && { providerId }),
    },
  });
  if (!id) return id;
  showInWindow(id, wasOpen);

  // An open Assistant was focused as it is; switching it to the requested session is a
  // remount of its chat, which the epoch drives.
  const current = currentTabMetadata(id);
  if (wasOpen && sessionId && current?.sessionId !== sessionId) {
    patchTabMetadata(id, {
      sessionId,
      // Unknown is left unknown: the open session's provider may not be this one's, and the
      // Assistant looks it up in its list (see `AssistantBody`).
      providerId: providerId || undefined,
      pendingMessage: undefined,
      clearedFrom: undefined,
      assistantChatEpoch: nextAssistantChatEpoch(current),
    });
  }
  return id;
}

/** What an Assistant chat always runs with: the server asks before every change regardless. */
export const ASSISTANT_PERMISSION = { permissionMode: "default", permissionModeSource: "user" } as const;

/**
 * A blank chat on `providerId` in the Assistant (Settings' "New session"). Its first message
 * creates the session, which is a one-off unless no main session exists yet.
 */
export function openAssistantNewSession(providerId: string): void {
  const id = openAssistant({ providerId });
  if (!id) return;
  patchTabMetadata(id, {
    sessionId: undefined,
    providerId,
    pendingMessage: undefined,
    clearedFrom: undefined,
    ...ASSISTANT_PERMISSION,
    projectName: ASSISTANT_PROJECT_NAME,
    assistantChatEpoch: nextAssistantChatEpoch(currentTabMetadata(id)),
  });
}

/** The epoch after the one `metadata` carries; the Assistant keys its chat on it. */
export function nextAssistantChatEpoch(metadata: Record<string, unknown> | undefined): number {
  const epoch = metadata?.assistantChatEpoch;
  return (typeof epoch === "number" && Number.isFinite(epoch) ? epoch : 0) + 1;
}

/**
 * Put the Assistant on screen in its window. Already in one: that window comes forward.
 * Just opened: it moves into a new window, which is its home — closing the window closes the
 * tab. Already open in the grid (the user docked it there): it stays where the user put it.
 * A phone has no windows and `popOutTab` refuses there, as it does at the window cap.
 */
function showInWindow(tabId: string, wasOpen: boolean): void {
  const panelId = usePanelStore.getState().getPanelForTab(tabId)?.id;
  if (!panelId) return;
  const windowId = windowIdFromPanelId(panelId);
  if (windowId) {
    useWindowStore.getState().focus(windowId);
    return;
  }
  if (wasOpen) return;
  const rect = assistantSpawnRect(useWindowStore.getState().bounds);
  usePanelStore.getState().popOutTab(tabId, panelId, { closeTabsOnClose: true, rect });
}

/** A portrait window, top-right, so the code on the left stays readable. */
const ASSISTANT_WINDOW = { w: 470, h: 620, margin: 16, right: 28 };

export function assistantSpawnRect(bounds: Bounds): Rect {
  const w = Math.min(ASSISTANT_WINDOW.w, bounds.w - ASSISTANT_WINDOW.margin * 2);
  const h = Math.min(ASSISTANT_WINDOW.h, bounds.h - ASSISTANT_WINDOW.margin * 2);
  return clampRect({ x: bounds.w - ASSISTANT_WINDOW.right - w, y: ASSISTANT_WINDOW.margin, w, h }, bounds);
}

/** The Assistant's window, when it is in one. */
export function assistantWindowId(): string | null {
  const panelId = usePanelStore.getState().getPanelForTab(ASSISTANT_TAB_ID)?.id;
  return panelId ? windowIdFromPanelId(panelId) : null;
}

/**
 * The rail button: a window in front minimizes to the dock, anything else (closed, behind,
 * minimized, docked in the grid, a phone tab) brings the Assistant forward.
 */
export function toggleAssistant(): void {
  const id = assistantWindowId();
  const windows = useWindowStore.getState();
  const win = id ? windows.windows[id] : undefined;
  if (win && win.state !== "minimized" && frontWindowId(windows.windows) === win.id) {
    windows.setState(win.id, "minimized");
    return;
  }
  openAssistant();
}
