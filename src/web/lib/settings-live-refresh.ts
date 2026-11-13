import { api } from "./api-client";
import { clearChatPreparationCache } from "./chat-preparation-cache";
import { useSettingsStore } from "@/stores/settings-store";
import { useKeybindingsStore } from "@/stores/keybindings-store";
import type { PpmThemeMode } from "@/theme/types";
import { SETTINGS_CHANGED_EVENT, type SettingsSection } from "../../shared/settings-events";

/**
 * What this browser does when the server announces `settings:changed {section}` (a screen on
 * another device, the `ppm` CLI): the app-wide state behind a section is read again here — the
 * theme is re-applied, imported themes and keybindings reloaded — whether or not Settings is open.
 * Then the event is re-dispatched on `window` (same name, `detail: { section }`) for the open
 * Settings panes, which read their section again through `useSettingsChanged`.
 */
export async function refreshAppWideSettings(section: SettingsSection): Promise<void> {
  if (section === "theme") {
    const { theme } = await api.get<{ theme: { style: string; mode: PpmThemeMode; customThemeId?: string } }>("/api/settings/theme");
    if (theme && typeof theme.style === "string") useSettingsStore.getState().setThemeFromPayload(theme);
  } else if (section === "themes") {
    await useSettingsStore.getState().fetchThemes();
  } else if (section === "keybindings") {
    await useKeybindingsStore.getState().loadFromServer();
  } else if (section === "ai") {
    // A chat opened next must not start from the AI settings cached before the change.
    clearChatPreparationCache();
  }
}

export function handleSettingsChanged(section: SettingsSection): void {
  void refreshAppWideSettings(section)
    .catch(() => { /* the next reload or reconnect reads it anyway */ })
    .finally(() => window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT, { detail: { section } })));
}
