/**
 * Showing a chat of another project in a floating window, beside the project on screen, instead of
 * switching the whole screen to that project.
 *
 * The chat is a new tab with no project (`projectId: null`) placed straight into a new window
 * panel, never through a grid: `openTab` would focus a copy sitting in that project's hidden
 * keep-alive grid, and popping that out would take it out of the project's layout. The window
 * names the project in its subtitle (`describeWindow`) and carries "Open in project" in its
 * titlebar (`managerWindow`, which every such window sets, not only a manager chat's). A chat
 * already in a window is raised instead of opened twice.
 */
import { usePanelStore } from "@/stores/panel-store";
import { useProjectStore } from "@/stores/project-store";
import { isWindowPanelId, windowIdFromPanelId } from "@/stores/panel-utils";
import { useWindowStore } from "@/components/floating-window/window-store";
import { cascadeSpawnRect } from "@/components/floating-window/window-geometry";
import { hydrateProjectCache } from "@/lib/browser-cache/project-cache-hydration";
import { tabSessionId } from "@/lib/tab-session-id";

export interface ChatWindowTarget {
  projectName: string;
  sessionId: string;
  providerId: string;
  title: string;
}

/** What happened: shown (opened or raised), no such project, or no window could be opened. */
export type ChatWindowResult = "opened" | "focused" | "no-project" | "refused";

const CHAT_WINDOW_SIZE = { w: 520, h: 640 };

/** The window already showing `sessionId`, if one does. */
export function chatWindowIdOf(sessionId: string): string | null {
  for (const panel of Object.values(usePanelStore.getState().panels)) {
    if (!isWindowPanelId(panel.id) || !panel.tabs.some((t) => tabSessionId(t) === sessionId)) continue;
    return windowIdFromPanelId(panel.id);
  }
  return null;
}

export function openChatInWindow(target: ChatWindowTarget): ChatWindowResult {
  const existing = chatWindowIdOf(target.sessionId);
  if (existing) {
    useWindowStore.getState().focus(existing);
    return "focused";
  }
  const projects = useProjectStore.getState();
  const project = projects.projects.find((p) => p.name === target.projectName);
  if (!project) return "no-project";
  // Only a project switch warms a project's slash list otherwise. Hydrating names it the project
  // to warm on the next load, so the active one is named again to keep that place.
  void hydrateProjectCache(project);
  if (projects.activeProject) void hydrateProjectCache(projects.activeProject);

  const windows = useWindowStore.getState();
  const rect = cascadeSpawnRect(Object.values(windows.windows).map((w) => w.rect), windows.bounds, CHAT_WINDOW_SIZE);
  const opened = usePanelStore.getState().openTabInNewWindow({
    type: "chat",
    title: target.title,
    projectId: null,
    closable: true,
    metadata: { projectName: target.projectName, sessionId: target.sessionId, providerId: target.providerId, managerWindow: true },
  }, { rect });
  return opened ? "opened" : "refused";
}
