/**
 * What a tab-host window adds to its chrome because of the tab it hosts: buttons in the titlebar
 * (beside the caption buttons), a shorter titlebar label, and a count on its dock chip. Keyed by
 * the hosted tab's type, so the window manager stays generic: the Assistant brings its status and
 * settings gear, a manager chat opened beside another project brings "Open in project".
 *
 * Built on first use rather than at import: the entries are components of features that import
 * the window store themselves, and a module-level table would read them mid-cycle as undefined.
 */
import type { ComponentType } from "react";
import type { Tab, TabType } from "@/stores/tab-store";
import { AssistantTitleExtras } from "@/components/assistant/assistant-title-extras";
import { OpenInProjectTitleExtras } from "@/components/assistant/open-in-project-button";
import { useAssistantWaitingStore } from "@/stores/assistant-waiting-store";
import { ASSISTANT_WINDOW_TITLE } from "@/components/assistant/open-assistant";

export type WindowSkinName = "windows" | "macos";

export interface TabTitleExtrasProps {
  tab: Tab;
  /** An AI turn is running in the tab (the titlebar already says "Working"). */
  busy: boolean;
  skin: WindowSkinName;
}

export interface TabWindowExtras {
  TitleExtras?: ComponentType<TabTitleExtrasProps>;
  /** The titlebar's label when it differs from the tab's title (the dock keeps the tab's). */
  titlebarTitle?: string;
  /** The titlebar says "Idle" as well as "Working": its state is what the window is for. */
  showIdle?: boolean;
  /** A count for the dock chip, read whenever `subscribe` reports a change. */
  count?: { subscribe: (onChange: () => void) => () => void; read: (tab: Tab) => number };
}

let table: Partial<Record<TabType, TabWindowExtras>> | null = null;

function build(): Partial<Record<TabType, TabWindowExtras>> {
  return {
    assistant: {
      TitleExtras: AssistantTitleExtras,
      titlebarTitle: ASSISTANT_WINDOW_TITLE,
      showIdle: true,
      count: { subscribe: useAssistantWaitingStore.subscribe, read: () => useAssistantWaitingStore.getState().total },
    },
    // Renders only for a manager chat opened in a window of its own (see `openManagerChat`).
    chat: { TitleExtras: OpenInProjectTitleExtras },
  };
}

export function tabWindowExtras(type: TabType | undefined): TabWindowExtras | undefined {
  if (!type) return undefined;
  table ??= build();
  return table[type];
}
