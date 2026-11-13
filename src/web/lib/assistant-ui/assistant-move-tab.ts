import { usePanelStore } from "@/stores/panel-store";
import {
  DOCK_ALLOWED_TAB_TYPES, DOCK_PANEL_ID, MAX_ROWS, NON_POPPABLE_TAB_TYPES, findPanelPosition, isWindowPanelId, maxColumns,
} from "@/stores/panel-utils";
import { isPanelOnScreen } from "@/stores/singleton-tab-relocation";
import type { Tab } from "@/stores/tab-store";
import {
  ASSISTANT_SPLIT_DIRECTIONS, type AssistantMoveTabResult, type AssistantSplitDirection, type AssistantTabPlace,
} from "../../../shared/assistant-ui-protocol";
import { findTab } from "./assistant-ui-actions";

/**
 * `ui_move_tab` on the device: moves an open tab with the same store actions the user's own
 * drag and drop and tab menu use — `moveTab` for a drop on a panel, `splitPanel` for a drop on a
 * panel's edge, `redockTab` for "Move to Dock", `popOutTab` for "Open in window" — so the
 * Assistant can lay out nothing the user could not. The answer says where the tab was, which is
 * how the agent moves it back.
 *
 * A desktop only: a phone shows one panel at a time and no floating windows. Only a tab on
 * screen moves, and never the Assistant's own tab, which stays where the user put it.
 */

const PHONE_REFUSAL = "This device is a phone: it shows one panel at a time and no floating windows, so there is "
  + "nowhere to move a tab to. Bring the tab forward with ui_focus_tab instead.";

/** Where `tabId` sits right now, or null when no panel holds it. */
export function placeOfTab(tabId: string): AssistantTabPlace | null {
  const store = usePanelStore.getState();
  const panel = store.getPanelForTab(tabId);
  if (!panel) return null;
  const index = panel.tabs.findIndex((t) => t.id === tabId);
  if (panel.id === DOCK_PANEL_ID) return { panelId: panel.id, area: "dock", index };
  if (isWindowPanelId(panel.id)) return { panelId: panel.id, area: "window", index };
  const position = findPanelPosition(store.grid, panel.id);
  return { panelId: panel.id, area: "grid", index, ...(position ? { position } : {}) };
}

function optionalIndex(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error("`index` must be a whole number, 0 or more.");
  return value;
}

/** A panel of the grid the user is looking at. */
function requireGridPanel(panelId: unknown, what: string): string {
  const store = usePanelStore.getState();
  if (typeof panelId !== "string" || !store.grid.some((row) => row.includes(panelId))) {
    throw new Error(`\`panelId\` must name ${what}: a panel with area "grid" in ui_get_state.`);
  }
  return panelId;
}

function toWindow(tab: Tab, fromPanelId: string): string {
  if (isWindowPanelId(fromPanelId)) throw new Error("That tab is already in a floating window of its own.");
  if (NON_POPPABLE_TAB_TYPES.has(tab.type)) throw new Error(`A ${tab.type} tab does not open in a floating window.`);
  const windowId = usePanelStore.getState().popOutTab(tab.id, fromPanelId);
  if (!windowId) throw new Error("Too many windows are open; the user has to close one first.");
  return windowId;
}

function toSplit(tab: Tab, fromPanelId: string, args: Record<string, unknown>): void {
  const direction = (args.direction ?? "right") as AssistantSplitDirection;
  if (!ASSISTANT_SPLIT_DIRECTIONS.includes(direction)) throw new Error("`direction` must be \"right\" or \"down\".");
  const beside = requireGridPanel(args.panelId ?? fromPanelId, "the grid panel to split beside");
  const store = usePanelStore.getState();
  if (beside === fromPanelId && store.panels[fromPanelId]!.tabs.length === 1) {
    throw new Error("That tab is alone in its panel, so a split beside it changes nothing. Name another panel with `panelId`.");
  }
  // The checks `splitPanel` makes, made first: a tab from the dock or a window is moved into the
  // grid before the split, and must not be left there when the split is refused.
  const pos = findPanelPosition(store.grid, beside)!;
  const full = direction === "right" ? (store.grid[pos.row]?.length ?? 0) >= maxColumns(false) : store.grid.length >= MAX_ROWS;
  if (full) {
    throw new Error(`There is no room for another panel ${direction === "right" ? "in that row" : "below"} `
      + `(at most ${maxColumns(false)} panels a row and ${MAX_ROWS} rows). Move the tab into an open panel instead.`);
  }
  let source = fromPanelId;
  if (source !== beside && !store.grid.some((row) => row.includes(source))) {
    // The dock and a window are off the grid; the user drags such a tab into the grid first, too.
    store.moveTab(tab.id, source, beside);
    source = beside;
  }
  if (!usePanelStore.getState().splitPanel(direction, tab.id, source, beside)) throw new Error("PPM could not split the panel.");
}

function toPanel(tab: Tab, fromPanelId: string, args: Record<string, unknown>): void {
  const index = optionalIndex(args.index);
  const store = usePanelStore.getState();
  const target = args.panelId;
  if (typeof target !== "string" || !target) throw new Error("`panelId` is required with `to: \"panel\"`: a panel id from ui_get_state.");
  if (isWindowPanelId(target)) throw new Error("That panel belongs to a floating window. To give the tab a window of its own, use `to: \"window\"`.");
  if (target === DOCK_PANEL_ID) {
    if (!DOCK_ALLOWED_TAB_TYPES.has(tab.type)) throw new Error(`The dock takes only ${[...DOCK_ALLOWED_TAB_TYPES].join(", ")} tabs.`);
    if (fromPanelId !== DOCK_PANEL_ID) store.redockTab(tab.id, fromPanelId);
  } else {
    requireGridPanel(target, "the panel to move the tab into");
    if (target !== fromPanelId) {
      const size = store.panels[target]!.tabs.length;
      store.moveTab(tab.id, fromPanelId, target, index === undefined ? undefined : Math.min(index, size));
      return;
    }
  }
  if (target === fromPanelId && index === undefined) throw new Error("The tab is already in that panel.");
  if (index !== undefined) {
    const panel = usePanelStore.getState().panels[target]!;
    usePanelStore.getState().reorderTab(tab.id, target, Math.min(index, panel.tabs.length - 1));
  }
}

export function moveAssistantTab(args: Record<string, unknown>): AssistantMoveTabResult {
  const store = usePanelStore.getState();
  if (store.isMobile()) throw new Error(PHONE_REFUSAL);
  const { panel, tab } = findTab(args.tabId);
  if (tab.type === "assistant") throw new Error("That is the Assistant's own tab; only the user moves it.");
  const hiddenDockTab = panel.id === DOCK_PANEL_ID && !!tab.projectId && tab.projectId !== store.currentProject;
  if (!isPanelOnScreen(panel.id, store.grid, false) || hiddenDockTab) {
    throw new Error("That tab is in a project that is not showing; bring it forward with ui_focus_tab first.");
  }
  const previous = placeOfTab(tab.id)!;
  let windowId: string | undefined;
  if (args.to === "window") windowId = toWindow(tab, panel.id);
  else if (args.to === "split") toSplit(tab, panel.id, args);
  else if (args.to === "panel") toPanel(tab, panel.id, args);
  else throw new Error("`to` must be \"panel\", \"split\" or \"window\".");
  const now = placeOfTab(tab.id);
  if (!now) throw new Error("PPM lost track of the tab while moving it; check with ui_get_state.");
  const after = usePanelStore.getState();
  return {
    tabId: tab.id,
    project: after.currentProject,
    now,
    previous,
    previousPanelClosed: !after.panels[previous.panelId],
    ...(windowId ? { window: windowId } : {}),
  };
}
