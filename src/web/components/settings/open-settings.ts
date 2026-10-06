/**
 * Opening Settings on whichever presentation the device has.
 *
 * `WindowLayer` renders nothing below the `md` breakpoint, so `open("settings")` would be a
 * silent no-op on a phone. Desktop gets the floating window; mobile gets the `settings` tab
 * route — both host the same `SettingsBody`. On desktop a second call focuses the window that
 * is already open rather than stacking a duplicate: there is only one set of settings, so a
 * repeat open is never a distinct instance.
 *
 * A plain function rather than a hook (the shape `openExplorer` already uses) because the
 * global keybinding handler is not a component and must reach the same routing. The viewport
 * is read at call time, which is what an action wants anyway — a click acts on the width the
 * user currently has, not on a value captured at render.
 *
 * Callers may name a category to land on, which is how a cross-feature link ("manage
 * accounts") reaches a specific pane instead of the index.
 */

import { isMobileDevice } from "@/hooks/use-is-mobile";
import { useWindowStore } from "@/components/floating-window/window-store";
import { useTabStore } from "@/stores/tab-store";
import { SETTINGS_NAVIGATE_EVENT, type SettingsCategoryId } from "./settings-categories";
import { resolveOpenSettingsAction } from "./resolve-open-settings-action";

export function openSettings(category?: SettingsCategoryId): void {
  const windowStore = useWindowStore.getState();
  const existing = Object.values(windowStore.windows).find((w) => w.kind === "settings");
  const action = resolveOpenSettingsAction(isMobileDevice(), existing?.id ?? null, category);

  if (action.kind === "tab") {
    const tabs = useTabStore.getState();
    const id = tabs.openTab(action.tab);
    // An open Settings tab is focused as it is; the pane it mounts on next comes from here.
    if (category && id) tabs.updateTab(id, { metadata: { category } });
  } else if (action.kind === "focus") {
    // Payload first: a reload puts the window back on this pane.
    if (action.category) windowStore.setPayload(action.id, { category: action.category });
    windowStore.focus(action.id);
  } else {
    windowStore.open("settings", action.category ? { category: action.category } : undefined);
  }
  // A Settings that is already mounted only reads its payload or metadata on its first render.
  if (category) window.dispatchEvent(new CustomEvent(SETTINGS_NAVIGATE_EVENT, { detail: category }));
}
