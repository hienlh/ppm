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
import { useWindowStore } from "@/components/floating-window/window-store";
import { cascadeSpawnRect } from "@/components/floating-window/window-geometry";
import { currentTabMetadata, patchTabMetadata } from "@/lib/patch-tab-metadata";
import { ASSISTANT_PROJECT_NAME } from "../../../shared/assistant-project";

/** The Assistant's one tab id (`deriveTabId("assistant")`). */
export const ASSISTANT_TAB_ID = "assistant";
export const ASSISTANT_TAB_TITLE = "PPM Assistant";

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
  const windows = useWindowStore.getState();
  const rect = cascadeSpawnRect(
    Object.values(windows.windows).map((w) => w.rect),
    windows.bounds,
    { w: Math.min(ASSISTANT_WINDOW_MAX_W, Math.round(windows.bounds.w * 0.62)), h: Math.round(windows.bounds.h * 0.84) },
  );
  usePanelStore.getState().popOutTab(tabId, panelId, { closeTabsOnClose: true, rect });
}

/** Wide enough for the session list beside the chat, without covering a whole desktop. */
const ASSISTANT_WINDOW_MAX_W = 980;
