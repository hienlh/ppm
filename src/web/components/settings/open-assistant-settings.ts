/**
 * Open Settings → PPM Assistant on a given sub-tab (the Assistant window's gear, a card's link).
 * Kept apart from the tab store so the store stays importable without the window layer.
 */
import { openSettings } from "./open-settings";
import { useAssistantSettingsTab, type AssistantSettingsTabId } from "./assistant-settings-tab-store";

export function openAssistantSettings(tab?: AssistantSettingsTabId): void {
  if (tab) useAssistantSettingsTab.getState().setTab(tab);
  openSettings("assistant");
}
