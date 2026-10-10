/**
 * Which sub-tab Settings → PPM Assistant shows, and where retired category ids now lead.
 *
 * A store rather than component state so a link from outside the pane can land on a given
 * sub-tab: the old Settings → PPMBot (`ppmbot`) is now the Telegram sub-tab here, and that id
 * still arrives from a remembered window, a persisted tab or an AI asking for it by name.
 */
import { create } from "zustand";
import { isSettingsCategoryId, type SettingsCategoryId } from "./settings-categories";

export type AssistantSettingsTabId = "general" | "telegram";

export const ASSISTANT_SETTINGS_TABS: { id: AssistantSettingsTabId; label: string }[] = [
  { id: "general", label: "General" },
  { id: "telegram", label: "Telegram" },
];

export const useAssistantSettingsTab = create<{
  tab: AssistantSettingsTabId;
  setTab: (tab: AssistantSettingsTabId) => void;
}>((set) => ({
  tab: "general",
  setTab: (tab) => set({ tab }),
}));

/** Ids no longer in the rail, and the pane plus sub-tab each one moved to. */
const RETIRED_CATEGORIES: Record<string, { category: SettingsCategoryId; assistantTab: AssistantSettingsTabId }> = {
  ppmbot: { category: "assistant", assistantTab: "telegram" },
};

/**
 * Narrows an untrusted category (a window payload, tab metadata, a navigate event, an AI's
 * request) to a pane, following a retired id to where it lives now. Following one also puts
 * the PPM Assistant pane on that sub-tab, which is why this is a call made once per link —
 * on mount, or per event — and never on every render, where it would undo the user's own
 * choice of sub-tab.
 */
export function resolveSettingsLink(value: unknown): SettingsCategoryId | undefined {
  if (isSettingsCategoryId(value)) return value;
  if (typeof value !== "string" || !Object.hasOwn(RETIRED_CATEGORIES, value)) return undefined;
  const retired = RETIRED_CATEGORIES[value]!;
  useAssistantSettingsTab.getState().setTab(retired.assistantTab);
  return retired.category;
}
