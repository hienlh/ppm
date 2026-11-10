/**
 * What a host may add to a chat's message list without a list of its own: items placed among the
 * messages by time (the Assistant's cards), rows it hides from view (a project filter, a folded
 * turn), and history paging that waits to be asked. Every field is optional and a chat without an
 * extension draws exactly as before.
 */
import type { ReactNode } from "react";
import type { ChatMessage } from "../../../types/chat";

export interface ChatTimelineItem {
  key: string;
  /** Epoch ms; see `placeTimelineItems` for where an item lands. */
  at: number;
  node: ReactNode;
}

export interface ChatTimelineExtension {
  /** Worked out from the rows the list draws; called again whenever they change. */
  build: (rows: readonly ChatMessage[]) => { items: ChatTimelineItem[]; hidden?: ReadonlySet<string> };
  /**
   * Older history loads only from a "Load earlier" button, never by scrolling to the top: a
   * filter that hides most rows would otherwise pull page after page by itself.
   */
  manualPaging?: boolean;
  /** The extension has older items of its own to load. */
  hasEarlier?: boolean;
  /** Called with every "Load earlier", beside the chat's own older page. */
  onLoadEarlier?: () => void;
}

export const LOAD_EARLIER_LABEL = "Load earlier";
