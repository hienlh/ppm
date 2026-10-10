import type { UiSummary, UiSummaryPanel } from "../../../shared/assistant-ui-protocol";
import type { UiStateSnapshot } from "./ui-state-snapshot";

/**
 * The short picture of this device's screen that each PPM Assistant message carries: the
 * project, every grid panel's tabs (and the dock's, when it is showing) and the floating
 * windows — types and titles only. Ids and details stay in the full snapshot, which the agent
 * reads with `ui_get_state`. Pure; the server validates and cleans it again before use.
 */

const MAX_TABS = 12;
const MAX_TITLE_CHARS = 80;
const MAX_WINDOWS = 10;

const cut = (text: string) => (text.length > MAX_TITLE_CHARS ? `${text.slice(0, MAX_TITLE_CHARS - 1)}…` : text);

export function buildUiSummary(snapshot: UiStateSnapshot): UiSummary {
  const panels: UiSummaryPanel[] = [];
  for (const panel of snapshot.panels) {
    if (panel.area === "window" || (panel.area === "dock" && !snapshot.dock.visible)) continue;
    const kept = panel.tabs.slice(0, MAX_TABS);
    const more = panel.tabs.length - kept.length + (panel.omittedTabs ?? 0);
    panels.push({
      area: panel.area,
      ...(panel.focused ? { focused: true } : {}),
      tabs: kept.map((t) => ({ type: t.type, title: cut(t.title), ...(t.active ? { active: true } : {}) })),
      ...(more ? { more } : {}),
    });
  }
  return {
    project: snapshot.currentProject,
    layout: snapshot.layout,
    panels,
    windows: snapshot.windows.slice(0, MAX_WINDOWS).map((w) => ({ kind: w.kind, title: cut(w.title), state: w.state })),
  };
}
