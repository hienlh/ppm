import { usePanelStore } from "@/stores/panel-store";
import { useProjectStore, type ProjectInfo } from "@/stores/project-store";
import { DOCK_PANEL_ID, isWindowPanelId, windowIdFromPanelId } from "@/stores/panel-utils";
import { isPanelOnScreen, projectOwningPanel } from "@/stores/singleton-tab-relocation";
import { useWindowStore } from "@/components/floating-window/window-store";
import { ASSISTANT_TAB_ID, openAssistant } from "@/components/assistant/open-assistant";
import { openSettings } from "@/components/settings/open-settings";
import { isSettingsCategoryId } from "@/components/settings/settings-categories";
import { nextQueryNumber } from "@/lib/db-tabs";
import { chooseAiTabPlacement } from "@/lib/ai-tab-placement";
import { openAiTab } from "@/lib/open-ai-tab";
import { isAssistantProject } from "../../../shared/assistant-project";
import {
  isAssistantTabKind, type AssistantCloseTabResult, type AssistantNavResult, type AssistantOpenTabTarget,
} from "../../../shared/assistant-ui-protocol";
import { buildAssistantTabDef, type AssistantTabDef } from "./assistant-tab-def";
import { tabDetails } from "./ui-state-snapshot";
import { unsavedWorkReason } from "./tab-unsaved-work";

/**
 * What the PPM Assistant's navigation tools do on the device: switch project, open, focus and
 * close tabs. The server validated every argument; the project is checked again here against
 * the projects this device knows, since a stale or foreign name would open a tab nobody sees.
 *
 * A tab always lands where it can be seen: in the project it belongs to, which is brought up
 * first, and beside the Assistant (`ai-tab-placement.ts`). On a phone the Assistant tab lives
 * in a project's grid, so a switch would leave it behind in a grid that is not shown; it is
 * brought along onto the new one, one tap away in the tab bar.
 */

export interface AssistantChat {
  /** The Assistant session asking; its tab is the one new tabs open beside. */
  sessionId: string;
}

function requireProject(name: unknown): ProjectInfo {
  if (typeof name !== "string" || !name.trim() || isAssistantProject(name)) {
    throw new Error("`project` must name one of the user's registered projects.");
  }
  const project = useProjectStore.getState().projects.find((p) => p.name === name);
  if (!project) throw new Error(`This device has no project named "${name.slice(0, 100)}".`);
  return project;
}

function keepAssistantOnScreen(): void {
  const store = usePanelStore.getState();
  const panel = store.getPanelForTab(ASSISTANT_TAB_ID);
  if (panel && !isPanelOnScreen(panel.id, store.grid, store.isMobile())) openAssistant();
}

/** Brings `project` up the way the project switcher does. */
function showProject(project: ProjectInfo): void {
  if (usePanelStore.getState().currentProject !== project.name) {
    useProjectStore.getState().setActiveProject(project);
    usePanelStore.getState().switchProject(project.name);
  }
  keepAssistantOnScreen();
}

const result = (tabId: string | null, previousProject: string | null, extra: Partial<AssistantNavResult> = {}): AssistantNavResult => ({
  tabId, project: usePanelStore.getState().currentProject, previousProject, ...extra,
});

/** Opens `def` beside the Assistant, or brings forward the tab that already shows it. */
function openBeside(def: AssistantTabDef, chat: AssistantChat): string {
  const store = usePanelStore.getState();
  const placement = chooseAiTabPlacement({
    grid: store.grid, panels: store.panels, focusedPanelId: store.focusedPanelId, mobile: store.isMobile(),
    sessionId: chat.sessionId, isTarget: def.matches,
  });
  if (!placement) throw new Error("PPM has no panel to open the tab in.");
  if (placement.kind === "open") {
    const id = store.openTab(def.tab, placement.panelId);
    if (!id) throw new Error("PPM could not open the tab.");
    // An open chat or table found in a floating window is raised there, not split out of the grid.
    if (placement.split && store.getPanelForTab(id)?.id === placement.panelId) store.splitPanel("right", id, placement.panelId);
    return id;
  }
  if (placement.kind === "focus") {
    store.setActiveTab(placement.tabId, placement.panelId);
  } else if (placement.toPanelId) {
    store.moveTab(placement.tabId, placement.fromPanelId, placement.toPanelId);
  } else if (!store.splitPanel("right", placement.tabId, placement.fromPanelId)) {
    store.setActiveTab(placement.tabId, placement.fromPanelId);
  }
  return placement.tabId;
}

export function openAssistantTab(args: Record<string, unknown>, chat: AssistantChat): AssistantNavResult {
  const project = requireProject(args.project);
  const target = args.target as AssistantOpenTabTarget | undefined;
  if (!target || typeof target !== "object" || !isAssistantTabKind(target.kind)) throw new Error("Unknown tab kind.");
  const previous = usePanelStore.getState().currentProject;
  showProject(project);

  if (target.kind === "file") {
    if (typeof target.filePath !== "string" || !target.filePath) throw new Error("No file was named.");
    const opened = openAiTab(
      { tool: "open_file", filePath: target.filePath, projectName: target.projectName ?? null, ...(target.line ? { line: target.line } : {}) },
      { sessionId: chat.sessionId, projectName: project.name },
    );
    return result(opened.tabId, previous);
  }
  if (target.kind === "settings") {
    if (target.section !== undefined && !isSettingsCategoryId(target.section)) throw new Error(`Settings has no section "${String(target.section).slice(0, 40)}".`);
    openSettings(target.section);
    // A desktop shows Settings as a window of its own, a phone as a tab.
    const inWindow = Object.values(useWindowStore.getState().windows).some((w) => w.kind === "settings");
    if (inWindow && !usePanelStore.getState().isMobile()) return result(null, previous, { window: "settings" });
    return result(usePanelStore.getState().getPanelForTab("settings") ? "settings" : null, previous);
  }
  const queryNumber = nextQueryNumber(Object.values(usePanelStore.getState().panels).flatMap((p) => p.tabs));
  return result(openBeside(buildAssistantTabDef(target, project.name, { queryNumber }), chat), previous);
}

/** The project a tab is shown under, or null when it shows in every project (windows, project-less tabs). */
function owningProject(panelId: string, tab: { projectId: string | null }): string | null {
  const store = usePanelStore.getState();
  if (panelId === DOCK_PANEL_ID) return tab.projectId;
  if (isWindowPanelId(panelId)) return null;
  if (store.grid.some((row) => row.includes(panelId))) return store.currentProject;
  return projectOwningPanel(store.projectGrids, panelId);
}

function findTab(tabId: unknown) {
  if (typeof tabId !== "string" || !tabId) throw new Error("`tabId` is required: an id from ui_get_state.");
  const panel = usePanelStore.getState().getPanelForTab(tabId);
  const tab = panel?.tabs.find((t) => t.id === tabId);
  if (!panel || !tab) throw new Error(`No tab "${tabId.slice(0, 200)}" is open on this device. Call ui_get_state for the current ids.`);
  return { panel, tab };
}

export function focusAssistantTab(args: Record<string, unknown>): AssistantNavResult {
  const { panel, tab } = findTab(args.tabId);
  const previous = usePanelStore.getState().currentProject;
  const owner = owningProject(panel.id, tab);
  if (owner && owner !== previous && owner !== "__global__") showProject(requireProject(owner));
  const store = usePanelStore.getState();
  if (isWindowPanelId(panel.id)) {
    if (store.isMobile()) throw new Error("That tab is in a floating window, which this device does not show.");
    store.setActiveTab(tab.id, panel.id);
    const windowId = windowIdFromPanelId(panel.id);
    if (windowId) useWindowStore.getState().focus(windowId);
  } else {
    store.setActiveTab(tab.id, panel.id);
    if (panel.id === DOCK_PANEL_ID) store.setDockVisible(true);
  }
  return result(tab.id, previous);
}

export function switchAssistantProject(args: Record<string, unknown>): AssistantNavResult {
  const project = requireProject(args.project);
  const previous = usePanelStore.getState().currentProject;
  showProject(project);
  return result(null, previous);
}

export function closeAssistantTab(args: Record<string, unknown>): AssistantCloseTabResult {
  const { panel, tab } = findTab(args.tabId);
  if (tab.type === "assistant") throw new Error("That is the Assistant's own tab; only the user closes it.");
  if (!tab.closable) throw new Error("That tab cannot be closed.");
  const metaProject = tab.metadata?.projectName;
  const project = tab.projectId ?? (typeof metaProject === "string" && metaProject ? metaProject : null);
  // `discardUnsaved` is the server's alone to add, once the user approved losing this work.
  const reason = args.discardUnsaved === true ? null : unsavedWorkReason(tab);
  if (reason) return { closed: false, tabId: tab.id, needsApproval: { reason, tab: { type: tab.type, title: tab.title, project } } };
  const details = tabDetails(tab);
  const closedTab = { type: tab.type, title: tab.title, project, ...(details ? { details } : {}) };
  usePanelStore.getState().closeTab(tab.id, panel.id);
  return { closed: true, tabId: tab.id, closedTab, project: usePanelStore.getState().currentProject };
}
