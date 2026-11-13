/**
 * A chat renamed anywhere — the Assistant's `chat_organize`, `ppm chat rename`, another device or
 * this one — reaches every open PPM as `sessions:list_changed` with a `renamed` field. This is
 * what a browser does with it, at once and without anyone clicking into the chat:
 *
 * - every open tab of that chat takes the new title (tab bar, floating window, mobile switcher and
 *   command palette all read the tab's own title), except a design tab, which is named after its
 *   design, and the Assistant's sessions, whose tab is named after the Assistant — the same rule
 *   the chat tab applies to a title it learns over its own socket;
 * - the project's shared session list shows it;
 * - `SESSION_TITLE_CHANGED_WINDOW_EVENT` goes out for whatever keeps its own copy (a mounted chat's
 *   title, the history list's extra pages and search results).
 *
 * The title is the one the server stored, which is also what decides a user's rename over an
 * automatic one, so nothing here can bring an automatic title back over a typed one.
 */
import { useEffect, useRef } from "react";
import { usePanelStore } from "@/stores/panel-store";
import { useSessionListStore } from "@/stores/session-list-store";
import { projectRefForName } from "@/stores/session-list-sync-triggers";
import { tabSessionId } from "@/lib/tab-session-id";
import { isAssistantProject } from "../../shared/assistant-project";
import type { RenamedChat } from "../../shared/chat-list-events";

export const SESSION_TITLE_CHANGED_WINDOW_EVENT = "ppm:session-title-changed";

export interface SessionTitleChange extends RenamedChat {
  projectName: string;
}

/** Retitles the open chat tabs showing `sessionId`; returns the ids of the tabs it changed. */
export function retitleOpenChatTabs(sessionId: string, title: string, projectName: string): string[] {
  if (isAssistantProject(projectName)) return [];
  const store = usePanelStore.getState();
  const changed: string[] = [];
  for (const panel of Object.values(store.panels)) {
    for (const tab of panel.tabs) {
      if (tab.type !== "chat" || tabSessionId(tab) !== sessionId || tab.title === title) continue;
      if (typeof tab.metadata?.designSlug === "string" && tab.metadata.designSlug) continue;
      changed.push(tab.id);
    }
  }
  for (const id of changed) store.updateTab(id, { title });
  return changed;
}

export function applySessionTitleChange(change: SessionTitleChange): void {
  const { projectName, sessionId, title } = change;
  retitleOpenChatTabs(sessionId, title, projectName);
  useSessionListStore.getState().renameSession(projectRefForName(projectName), sessionId, title);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<SessionTitleChange>(SESSION_TITLE_CHANGED_WINDOW_EVENT, { detail: change }));
  }
}

/** Calls `onChange` for every rename announced while mounted (any project; filter in the handler). */
export function useSessionTitleChanges(onChange: (change: SessionTitleChange) => void): void {
  const ref = useRef(onChange);
  ref.current = onChange;
  useEffect(() => {
    const listener = (e: Event) => {
      const detail = (e as CustomEvent<SessionTitleChange>).detail;
      if (detail) ref.current(detail);
    };
    window.addEventListener(SESSION_TITLE_CHANGED_WINDOW_EVENT, listener);
    return () => window.removeEventListener(SESSION_TITLE_CHANGED_WINDOW_EVENT, listener);
  }, []);
}
