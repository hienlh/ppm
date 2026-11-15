/**
 * Opening a project's manager chat from the Assistant (a chip, a card's "Open manager chat").
 *
 * Desktop: in a floating window of its own, without switching project. The chat is a new tab with
 * no project (`projectId: null`) placed straight into a new window panel, never through a grid:
 * `openTab` would focus a copy sitting in that project's hidden keep-alive grid, and popping that
 * out would take it out of the project's layout. The project's slash cache is hydrated here, since
 * only a project switch does that otherwise. A chat already in a window is raised instead.
 *
 * Phone: there are no windows, so the project switches and the chat opens as a tab that remembers
 * where the user came from; its "‹ Assistant" goes back there.
 */
import { toast } from "sonner";
import { usePanelStore } from "@/stores/panel-store";
import { useProjectStore } from "@/stores/project-store";
import { isWindowPanelId, windowIdFromPanelId } from "@/stores/panel-utils";
import { useWindowStore } from "@/components/floating-window/window-store";
import { closeWindow } from "@/components/floating-window/close-window";
import { cascadeSpawnRect } from "@/components/floating-window/window-geometry";
import { hydrateProjectCache } from "@/lib/browser-cache/project-cache-hydration";
import { showProjectTab } from "@/lib/open-ppm-tab";
import { patchTabMetadata } from "@/lib/patch-tab-metadata";
import { tabSessionId } from "@/lib/tab-session-id";
import type { Tab } from "@/stores/tab-store";
import { openAssistant } from "./open-assistant";
import type { AssistantReturn } from "./assistant-return";
import { MANAGER_PROVIDER_ID } from "../../../shared/assistant-managers";

export interface ManagerChatRef {
  projectName: string;
  sessionId: string;
  title?: string | null;
  /**
   * Another chat of the project, opened the same way from one of its cards: its provider, and the
   * title its tab takes. Absent for the manager chat.
   */
  chat?: { title: string; providerId: string };
}

const tabTitle = (target: ManagerChatRef): string => target.chat?.title ?? managerChatTitle(target.projectName);
const providerOf = (target: ManagerChatRef): string => target.chat?.providerId ?? MANAGER_PROVIDER_ID;

const MANAGER_WINDOW_SIZE = { w: 520, h: 640 };

export function managerChatTitle(projectName: string): string {
  return `${projectName} · manager`;
}

/** Said before a manager chat opens, so a full-screen sheet over the Assistant gets out of the way. */
export const MANAGER_CHAT_OPENING_EVENT = "ppm:manager-chat-opening";

export function openManagerChat(target: ManagerChatRef): Promise<void> {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(MANAGER_CHAT_OPENING_EVENT));
  return usePanelStore.getState().isMobile() ? openOnPhone(target) : Promise.resolve(openInWindow(target));
}

function openInWindow(target: ManagerChatRef): void {
  const store = usePanelStore.getState();
  for (const panel of Object.values(store.panels)) {
    if (!isWindowPanelId(panel.id) || !panel.tabs.some((t) => tabSessionId(t) === target.sessionId)) continue;
    const windowId = windowIdFromPanelId(panel.id);
    if (windowId) useWindowStore.getState().focus(windowId);
    return;
  }
  const projects = useProjectStore.getState();
  const project = projects.projects.find((p) => p.name === target.projectName);
  if (!project) { toast.error(`${target.projectName} is not a project in this PPM any more.`); return; }
  // Hydrating names it the project to warm on the next load; the active one keeps that place.
  void hydrateProjectCache(project);
  if (projects.activeProject) void hydrateProjectCache(projects.activeProject);

  const windows = useWindowStore.getState();
  const rect = cascadeSpawnRect(Object.values(windows.windows).map((w) => w.rect), windows.bounds, MANAGER_WINDOW_SIZE);
  const opened = store.openTabInNewWindow({
    type: "chat",
    title: tabTitle(target),
    projectId: null,
    closable: true,
    metadata: { projectName: target.projectName, sessionId: target.sessionId, providerId: providerOf(target), managerWindow: true },
  }, { rect });
  if (!opened) toast.error("Too many windows are open. Close one to open the manager chat.");
}

async function openOnPhone(target: ManagerChatRef): Promise<void> {
  const from = useProjectStore.getState().activeProject?.name ?? null;
  if (!(await showProjectTab(target.projectName, null, null))) {
    toast.error(`${target.projectName} is not a project in this PPM any more.`);
    return;
  }
  const id = usePanelStore.getState().openTab({
    type: "chat",
    title: tabTitle(target),
    projectId: target.projectName,
    closable: true,
    metadata: { projectName: target.projectName, sessionId: target.sessionId, providerId: providerOf(target) },
  });
  const returnTo: AssistantReturn = { kind: "assistant", project: from === target.projectName ? null : from };
  if (id) patchTabMetadata(id, { returnTo, returnNote: true });
}

/** "‹ Assistant": back to the project the chip was tapped in, with the Assistant on screen. */
export async function returnToAssistant(tabId: string, returnTo: AssistantReturn): Promise<void> {
  patchTabMetadata(tabId, { returnTo: undefined, returnNote: undefined });
  if (returnTo.project) await showProjectTab(returnTo.project, null, null);
  openAssistant();
}

/** "Open in project": the window goes, and the chat opens in its project's grid. */
export async function openManagerChatInProject(tab: Tab): Promise<void> {
  const projectName = typeof tab.metadata?.projectName === "string" ? tab.metadata.projectName : null;
  const sessionId = tabSessionId(tab);
  if (!projectName || !sessionId) return;
  const panelId = usePanelStore.getState().getPanelForTab(tab.id)?.id;
  const windowId = panelId ? windowIdFromPanelId(panelId) : null;
  if (windowId) closeWindow(windowId);
  const providerId = typeof tab.metadata?.providerId === "string" ? tab.metadata.providerId : MANAGER_PROVIDER_ID;
  if (!(await showProjectTab(projectName, "chat", `${providerId}/${sessionId}`))) {
    toast.error(`${projectName} is not a project in this PPM any more.`);
  }
}

